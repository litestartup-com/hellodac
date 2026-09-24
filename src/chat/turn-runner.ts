/**
 * 债务 E2:回合编排从 routes/chat.ts 抽出——三层拆分(relay / 回合编排 /
 * CRUD 路由壳)的第二层。
 *
 * 编排职责(蜂群 P5.4 修订):**会话内串行、会话间并行**——同一个 gateway
 * 会话同时只能跑一个回合,所以每个 chat 同一时刻最多一个回合(chatTurns
 * 登记);同会话的新消息排进该 chat 的队列,前一个完成后自动接着跑;不同
 * chat 互不阻塞。会话名额(maxSessions)仍是全局上限,满了的失败如实透给
 * 用户。路由壳只解析请求,派工/队列衔接/收尾全在这里。
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
  /** 直播帧记忆(刷新后仍能拿到回合中帧);与 publish 一起挂在 onFrame 上。 */
  rememberLiveFrame: (chatId: string, frame: Record<string, unknown>) => void
  /** 历史缓存失效(回合新增事件 / 模型与沙箱切换后)。 */
  invalidateHistory: (sessionId: string) => void
}

export interface ChatTurnRunner {
  /** 该 chat 是否有回合在跑(会话内串行判断)。 */
  hasRunningTurn: (chatId: string) => boolean
  /** 中止在跑回合(abort 信号);true = 确实有回合被中止。 */
  abortTurn: (chatId: string) => boolean
  startChatTurn: (
    chat: ChatRow,
    agent: ResolvedAgent,
    client: GatewayClient,
    upstream: SessionDriver | null,
    driver: 'gateway' | 'apiproxy',
    text: string,
  ) => Promise<unknown>
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
        timeoutMs: config.runner.timeoutMs,
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
  ): Promise<unknown> => {
    const controller = new AbortController()
    chatCancels.set(chat.id, controller)
    const tracked = (async () => {
      try {
        await runChatTurn(chat, agent, client, upstream, driver, text, controller.signal)
      } catch (error) {
        // No HTTP reply carries the failure any more; the relay does.
        const doneFrame = {
          kind: 'turn_done',
          state: 'failed',
          error: error instanceof Error ? error.message : String(error),
        }
        rememberLiveFrame(chat.id, doneFrame)
        publish(chat.id, doneFrame)
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
