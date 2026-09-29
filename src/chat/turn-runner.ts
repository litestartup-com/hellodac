/**
 * Debt E2: turn orchestration extracted from routes/chat.ts -- the middle layer of a three-way
 * split (relay / turn orchestration / CRUD route shell).
 *
 * Orchestration duties (Hive P5.4 revision): **serial within a chat, parallel across chats** -- one gateway
 * session runs one turn at a time, so a chat runs at most one turn at any moment (registered in chatTurns);
 * a new message for the same chat queues behind its turn and starts once the previous one finishes; different
 * chats never block each other. The chat slot limit (maxSessions) is still the global cap and a failure when
 * it is full is reported to the user as-is. The route shell only parses requests; dispatch, queue hand-off and teardown all live here.
 */
import type { FastifyBaseLogger } from 'fastify'
import type { AppConfig, ResolvedAgent } from '../config.js'
import type { Db } from '../db/index.js'
import type { GatewayClient } from '../gateway/client.js'
import type { GatewayFrame } from '../gateway/stream.js'
import type { SessionDriver } from '../session-driver/port.js'
import { runAgent, type RunOutcome } from '../runner.js'
import { drainChatQueue } from './queue.js'
import { bindSession, getChat, touchChat } from './store.js'

type ChatRow = NonNullable<ReturnType<typeof getChat>>

export interface TurnRunnerDeps {
  db: Db
  config: AppConfig
  log: FastifyBaseLogger
  publish: (chatId: string, payload: unknown) => void
  /** Live-frame memory (frames of a running turn survive a refresh); mounted on onFrame together with publish. */
  rememberLiveFrame: (chatId: string, frame: Record<string, unknown>) => void
  /** Invalidate the history cache (after a turn adds events / a model or sandbox switch). */
  invalidateHistory: (sessionId: string) => void
}

export interface TurnOptions {
  /**
   * Which public key this turn is billed to (public API calls). Default = an internal turn.
   * One object argument rather than a 7th positional parameter: the two call sites (internal, public) differ
   * only here, and a run of positional parameters is exactly how one call site ends up missing a value.
   */
  apiKeyId?: string | null
}

export interface ChatTurnRunner {
  /** Whether this chat has a turn running (the serial-within-a-chat check). */
  hasRunningTurn: (chatId: string) => boolean
  /** Abort the running turn (abort signal); true = a turn really was aborted. */
  abortTurn: (chatId: string) => boolean
  /** Run a turn and **wait for it to finish**: the public API wants "the answer to this turn", so the result must be available. */
  startChatTurn: (
    chat: ChatRow,
    agent: ResolvedAgent,
    client: GatewayClient,
    upstream: SessionDriver | null,
    driver: 'gateway' | 'apiproxy',
    text: string,
    options?: TurnOptions,
  ) => Promise<RunOutcome>
}

export const makeChatTurnRunner = (deps: TurnRunnerDeps): ChatTurnRunner => {
  const { db, config, log, publish, rememberLiveFrame, invalidateHistory } = deps

  /**
   * One chat turn end to end: run + the post-run bookkeeping (history cache,
   * session binding, turn_done frame). Shared by the direct path and the queue,
   * so a queued turn does exactly what a direct one does.
   */
  const runChatTurn = async (
    chat: ChatRow,
    agent: ResolvedAgent,
    client: GatewayClient,
    upstream: SessionDriver | null,
    driver: 'gateway' | 'apiproxy',
    text: string,
    signal: AbortSignal,
    options: TurnOptions = {},
  ): Promise<RunOutcome> => {
    const outcome = await runAgent(
      {
        db,
        pricing: config.pricing,
        log: {
          info: (m) => log.info(m),
          warn: (m) => log.warn(m),
          error: (m) => log.error(m),
        },
      },
      {
        agent,
        client,
        ...(upstream === null ? {} : { upstream }),
        driver,
        prompt: text,
        trigger: 'manual',
        apiKeyId: options.apiKeyId ?? null,
        // An outward turn holds a customer's HTTP request open, so it rides the (much shorter)
        // outward ceiling instead of the internal one; a hand-written test config may omit it.
        timeoutMs:
          options.apiKeyId !== undefined && options.apiKeyId !== null
            ? (config.runner.outwardTimeoutMs ?? config.runner.timeoutMs)
            : config.runner.timeoutMs,
        silenceMs: config.runner.silenceMs,
        chatId: chat.id,
        sessionId: chat.dshSessionId,
        signal,
        onSession: (sessionId) => {
          if (getChat(db, chat.id)?.dshSessionId === null) bindSession(db, chat.id, sessionId)
        },
        // A conversation continues on this session, so it keeps its slot.
        // Releasing here would make the next message pay for a cold resume.
        keepSession: true,
        // The gateway echoes the message we just sent back as its own
        // `user` frame, and the route has already published one above. Both
        // would reach the browser and draw the same bubble twice. manager
        // owns the echo because it can publish before the session even
        // exists, so the upstream copy is the redundant one.
        onFrame: (frame: GatewayFrame) => {
          if (frame.kind === 'user') return
          rememberLiveFrame(chat.id, frame)
          publish(chat.id, frame)
        },
      },
    )

    // Invalidate history cache — the turn added new events.
    if (outcome.sessionId !== null) invalidateHistory(outcome.sessionId)

    // First turn: remember the session so the next message continues it
    // rather than starting a fresh conversation.
    if (outcome.sessionId !== null && chat.dshSessionId === null) {
      bindSession(db, chat.id, outcome.sessionId)
    } else {
      touchChat(db, chat.id)
    }

    const doneFrame = { kind: 'turn_done', runId: outcome.runId, state: outcome.state, error: outcome.error }
    rememberLiveFrame(chat.id, doneFrame)
    publish(chat.id, doneFrame)
    return outcome
  }

  const chatTurns = new Map<string, Promise<unknown>>()
  const chatCancels = new Map<string, AbortController>()

  const startChatTurn = (
    chat: ChatRow,
    agent: ResolvedAgent,
    client: GatewayClient,
    upstream: SessionDriver | null,
    driver: 'gateway' | 'apiproxy',
    text: string,
    options: TurnOptions = {},
  ): Promise<RunOutcome> => {
    const controller = new AbortController()
    chatCancels.set(chat.id, controller)
    const tracked = (async () => {
      try {
        return await runChatTurn(chat, agent, client, upstream, driver, text, controller.signal, options)
      } catch (error) {
        // The admin UI receives failures through the relay (no HTTP reply carries them); but the exception
        // **must also be rethrown to the caller**: the public API is synchronous Q&A, and swallowing it would
        // hand the customer a "successful but empty" response. So internal call sites all use
        // `.catch(() => undefined)` (the frames were already sent).
        const doneFrame = {
          kind: 'turn_done',
          state: 'failed',
          error: error instanceof Error ? error.message : String(error),
        }
        rememberLiveFrame(chat.id, doneFrame)
        publish(chat.id, doneFrame)
        throw error
      } finally {
        if (chatCancels.get(chat.id) === controller) chatCancels.delete(chat.id)
        chatTurns.delete(chat.id)
        drainChatQueue(chat.id)
      }
    })()
    chatTurns.set(chat.id, tracked)
    return tracked
  }

  return {
    hasRunningTurn: (chatId) => chatTurns.has(chatId),
    abortTurn: (chatId) => {
      const controller = chatCancels.get(chatId)
      if (controller === undefined) return false
      controller.abort()
      return true
    },
    startChatTurn,
  }
}
