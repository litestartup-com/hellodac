import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, preHandlerHookHandler } from 'fastify'
import { count, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { AppConfig, ResolvedAgent } from '../config.js'
import type { AuditKind } from '../audit.js'
import type { Db } from '../db/index.js'
import { schema } from '../db/index.js'
import { GatewayError, dummyGatewayClient, type GatewayClient, type HistoryEvent, type QuestionAnswer } from '../gateway/client.js'
import { errorText } from '../errors.js'
import type { SessionDriver } from '../session-driver/port.js'
import type { UpstreamComposerState } from '../upstream/client.js'
import type { UpstreamGoal } from '../upstream/translate.js'
import { UpstreamError } from '../upstream/rpc.js'
import { activeRunCount, runningRunId } from '../runner.js'
import { cancelQueuedTurn, cancelQueuedTurns, enqueueTurn } from '../chat/queue.js'
import { compactHistory } from '../chat/replay.js'
import { HistoryCache } from '../chat/history-cache.js'
// 债务 E2:回合编排(会话内串行/会话间并行)已下沉 chat/turn-runner.ts。
import { makeChatTurnRunner } from '../chat/turn-runner.js'
import {
  chatRuns,
  createChat,
  deriveTitle,
  getChat,
  listArchivedChats,
  listChats,
  removeChat,
  renameChat,
  restoreChat,
  setTitleIfEmpty,
  touchChat,
} from '../chat/store.js'
// 债务 E2:relay(SSE pub-sub)已下沉 chat/relay.ts;此处 re-export 保持既有导入面。
import { publish, registerRelayRoute } from '../chat/relay.js'
export { publish, openChatRelays, closeChatRelays } from '../chat/relay.js'

/**
 * The chat API: threads, transcripts, and one live relay per chat.
 *
 * manager does not store the transcript. The gateway already persists it and
 * serves it from `GET /sessions/:id/history`, and a second copy would only be a
 * copy that can disagree with the first. So a transcript request is a read
 * through to the gateway, and manager's own tables hold nothing but the thread
 * metadata and the cost ledger.
 */

const sendBody = z.object({ text: z.string().min(1, 'a message is required').max(20_000) })
const renameBody = z.object({ title: z.string().min(1).max(200) })
const createBody = z.object({ agentId: z.string().min(1) })
const modelBody = z.object({ provider: z.string().min(1), model: z.string().min(1), reasoningEffort: z.string().min(1).optional() })
const sandboxModeBody = z.object({ mode: z.enum(['read-only', 'workspace-write', 'danger-full-access']) })

export const registerChatRoutes = (
  app: FastifyInstance,
  config: AppConfig,
  db: Db,
  clients: Map<string, GatewayClient>,
  requireUser: preHandlerHookHandler,
  upstreamClients?: Map<string, SessionDriver>,
  /** 审计回调（全量沙箱切换留痕用；测试可不传）。 */
  audit?: (actor: string, kind: AuditKind, detail: string) => void,
): void => {
  const agentOf = (chatAgentId: string): ResolvedAgent | undefined => config.agents[chatAgentId]

  const driverOf = (endpointId: string): 'gateway' | 'apiproxy' =>
    config.endpoints[endpointId]?.driver ?? 'gateway'

  /** Loads a chat and its agent, answering the right 404 for each. */
  const resolve = (
    chatId: string,
    reply: FastifyReply,
  ): { chat: NonNullable<ReturnType<typeof getChat>>; agent: ResolvedAgent; client: GatewayClient; upstream: SessionDriver | null; driver: 'gateway' | 'apiproxy' } | null => {
    const chat = getChat(db, chatId)
    if (chat === null || chat.removedAt !== null) {
      void reply.code(404).send({ error: 'unknown_chat' })
      return null
    }
    const agent = agentOf(chat.agentId)
    if (agent === undefined) {
      void reply.code(409).send({
        error: 'agent_gone',
        detail: `this session belongs to agent "${chat.agentId}", which is no longer in the config`,
      })
      return null
    }
    const driver = driverOf(agent.endpoint)
    const upstream = upstreamClients?.get(agent.endpoint) ?? null
    const client = clients.get(agent.endpoint)
    if (driver === 'apiproxy' && upstream === null) {
      void reply.code(500).send({ error: 'endpoint_not_configured' })
      return null
    }
    if (driver === 'gateway' && client === undefined) {
      void reply.code(500).send({ error: 'endpoint_not_configured' })
      return null
    }
    // For gateway mode, client is always defined here; for apiproxy, we still
    // need a GatewayClient reference for routes that haven't been branched yet.
    // 债务 E10:占位 client 永不连通,分支逻辑保证不会被真调。
    return { chat, agent, client: client ?? dummyGatewayClient(), upstream, driver }
  }

  // ---- history cache (avoids re-reading the same session log on every page open) ----
  // 债务 B2(半项):容量上限 LRU + 惰性 TTL——旧裸 Map 无上限,大量
  // 「读过一次不再跑」的会话会让最贵的对象(整段历史数组)单调增长。

  interface CachedHistory { events: HistoryEvent[]; sessionState: string; title: string | null; composer: UpstreamComposerState; goal: UpstreamGoal | null }
  const historyCache = new HistoryCache<CachedHistory>({ max: 200, ttlMs: 30_000 }) // cold sessions don't change; 30s is safe
  const liveFrames = new Map<string, Array<Record<string, unknown>>>()
  const rememberLiveFrame = (chatId: string, frame: Record<string, unknown>): void => {
    if (frame.kind === 'turn_done') {
      liveFrames.delete(chatId)
      // 债务卡片链:turn_done 只清回合转录重放——挂起卡片(pendingCards)独立于
      // 回合生命周期,回合死掉(重连/超时/重启)后卡片仍可重放、仍可作答
      // (答案经 respond 直达宿主,与回合是否活着无关)。
      return
    }
    // 债务卡片链:已作答/已决断的卡片必须从转录重放里移除——合成 resolved 关闭
    // 卡片后,回合未结束时刷新(GET 重放 liveFrames)不得把卡片复活。
    if (frame.kind === 'question_resolved') {
      const live = (liveFrames.get(chatId) ?? []).filter((l) => !(l.kind === 'question_asked' && l.questionId === frame.questionId))
      if (live.length === 0) liveFrames.delete(chatId)
      else liveFrames.set(chatId, live)
      updatePendingCard(chatId, frame)
      return
    }
    if (frame.kind === 'approval_resolved') {
      const live = (liveFrames.get(chatId) ?? []).filter((l) => {
        if (l.kind !== 'approval_pending') return true
        if (typeof frame.decisionId === 'string') return l.decisionId !== frame.decisionId
        if (typeof frame.approvalId === 'string') return l.approvalId !== frame.approvalId
        return true
      })
      if (live.length === 0) liveFrames.delete(chatId)
      else liveFrames.set(chatId, live)
      updatePendingCard(chatId, frame)
      return
    }
    const frames = liveFrames.get(chatId) ?? []
    frames.push(frame)
    liveFrames.set(chatId, frames)
    updatePendingCard(chatId, frame)
  }

  // ---- 债务卡片链(2026-09-17):挂起卡片持久化 + 重放 ----
  // question/approval 帧是「等人作答」状态:上游只广播一次,若断线窗口/页面
  // 刷新/回合死亡丢掉了它,卡片就永远回不来(ask_user_question 干等)。本 map
  // 与回合无关地留存卡片帧,resolved 帧或 TTL 才清理;GET 与 SSE 重连都重放。
  const pendingCards = new Map<string, Array<Record<string, unknown>>>()
  const CARD_TTL_MS = 15 * 60_000 // runner 总超时上限;facade 10 分钟放手,15 分钟兜底
  const freshCards = (chatId: string): Array<Record<string, unknown>> =>
    (pendingCards.get(chatId) ?? []).filter((c) => Date.now() - (typeof c.at === 'number' ? c.at : 0) < CARD_TTL_MS)
  const updatePendingCard = (chatId: string, frame: Record<string, unknown>): void => {
    const kind = frame.kind
    if (kind === 'question_asked' || kind === 'approval_pending') {
      const id = kind === 'question_asked' ? frame.questionId : frame.decisionId
      if (typeof id !== 'string') return
      const cards = (pendingCards.get(chatId) ?? []).filter((c) =>
        !(c.kind === kind && (kind === 'question_asked' ? c.questionId === id : c.decisionId === id)))
      cards.push({ ...frame, at: Date.now() })
      pendingCards.set(chatId, cards)
      return
    }
    if (kind === 'question_resolved') {
      const id = frame.questionId
      if (typeof id !== 'string') return
      const cards = (pendingCards.get(chatId) ?? []).filter((c) => !(c.kind === 'question_asked' && c.questionId === id))
      if (cards.length === 0) pendingCards.delete(chatId)
      else pendingCards.set(chatId, cards)
      return
    }
    if (kind === 'approval_resolved') {
      // resolved 可能只带 approvalId(新连接没见过 request)——两种 id 都扫。
      const cards = (pendingCards.get(chatId) ?? []).filter((c) => {
        if (c.kind !== 'approval_pending') return true
        if (typeof frame.decisionId === 'string') return c.decisionId !== frame.decisionId
        if (typeof frame.approvalId === 'string') return c.approvalId !== frame.approvalId
        return true
      })
      if (cards.length === 0) pendingCards.delete(chatId)
      else pendingCards.set(chatId, cards)
    }
  }
  /** GET 重放 = 回合转录(liveFrames) + 存活挂起卡片(去重)。 */
  const replayFrames = (chatId: string): Array<Record<string, unknown>> => {
    const live = liveFrames.get(chatId) ?? []
    const cards = freshCards(chatId).filter((c) => !live.some((l) =>
      l.kind === c.kind &&
      (typeof l.questionId === 'string' ? l.questionId === c.questionId : l.decisionId === c.decisionId)))
    return [...live, ...cards]
  }
  /** SSE 重连重放 = 只重放卡片帧(转录帧不重放——reduce 非幂等,会画重块)。 */
  const pendingCardFrames = (chatId: string): Array<Record<string, unknown>> => freshCards(chatId)

  const invalidateHistory = (sessionId: string): void => { historyCache.delete(sessionId) }

  // ---- threads ------------------------------------------------------------

  app.get('/api/chats', { preHandler: requireUser }, async (_request, reply) => {
    // Grouped by agent, in config order, because that is the order the sidebar
    // draws them in and the client should not have to guess it.
    const agents = Object.values(config.agents).map((agent) => ({
      id: agent.id,
      name: agent.name,
      public: agent.public,
      endpoint: agent.endpoint,
      busyRunId: runningRunId(agent.id),
      activeRuns: activeRunCount(agent.id),
      chats: listChats(db, agent.id),
    }))
    return reply.header('cache-control', 'no-store').send({ agents })
  })

  /**
   * Archived chats, so archiving is reversible.
   *
   * A soft delete the user cannot see into is indistinguishable from a real
   * delete, which would make "归档" a lie about their own data.
   *
   * Static segment, so it is matched ahead of `/api/chats/:id` regardless of the
   * order these are registered in.
   */
  app.get('/api/chats/archived', { preHandler: requireUser }, async (_request, reply) => {
    const chats = listArchivedChats(db).map((chat) => {
      const agent = agentOf(chat.agentId)
      return {
        ...chat,
        // Named for display, and flagged when the agent is gone: such a chat
        // cannot be restored, and the list has to say so before the button is
        // pressed.
        agentName: agent?.name ?? chat.agentId,
        agentGone: agent === undefined,
      }
    })
    return reply.header('cache-control', 'no-store').send({ chats })
  })

  app.post<{ Body: unknown }>('/api/chats', { preHandler: requireUser }, async (request, reply) => {
    const parsed = createBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' })
    const agent = agentOf(parsed.data.agentId)
    if (agent === undefined) return reply.code(404).send({ error: 'unknown_agent' })

    // No gateway session yet. Creating one now would consume a slot against the
    // gateway's maxSessions for a chat the user may never type into.
    const chat = createChat(db, agent.id)
    return reply.code(201).send({ chat, turns: [], events: [] })
  })

  /**
   * 蜂群 P2：主脑派工记录（delegation 帧的数据源）。
   *
   * 该会话发起的每一次派工 = 一条 run（trigger='brain'、source_chat_id=本会话）。
   * 页面首屏读这里，实时更新靠 relay 上的 delegation_done 帧。
   */
  app.get<{ Params: { id: string } }>('/api/chats/:id/delegations', { preHandler: requireUser }, async (request, reply) => {
    const chat = getChat(db, request.params.id)
    if (chat === null) return reply.code(404).send({ error: 'unknown_chat' })
    const rows = db
      .select()
      .from(schema.run)
      .where(eq(schema.run.sourceChatId, chat.id))
      .orderBy(desc(schema.run.startedAt))
      .limit(50)
      .all()
    return reply.header('cache-control', 'no-store').send({
      delegations: rows.map((r) => ({
        runId: r.id,
        agentId: r.agentId,
        agentName: config.agents[r.agentId]?.name ?? r.agentId,
        state: r.state,
        summary: r.resultSummary,
        error: r.error,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
      })),
    })
  })

  /**
   * A chat with its transcript.
   *
   * `sessionState` is reported explicitly because the three cases need three
   * different things from the user, and all of them look identical if you only
   * report a message list:
   *   - `fresh`   nothing sent yet
   *   - `live`    the gateway holds the session and it can take a turn now
   *   - `cold`    readable, and will be revived on the next message
   *   - `lost`    the gateway has no record of it at all; it cannot continue
   */
  app.get<{ Params: { id: string } }>('/api/chats/:id', { preHandler: requireUser }, async (request, reply) => {
    const found = resolve(request.params.id, reply)
    if (found === null) return reply
    const { chat, agent, client, upstream, driver } = found
    const capabilities = {
      modelSelection: upstream?.modelCatalog !== undefined && upstream.selectModel !== undefined,
      accessMode: upstream?.canSetSandboxMode?.() === true && upstream.setSandboxMode !== undefined,
      // 第三档权限（danger-full-access）：节点开锁才为 true；形态用于 UI 风险文案。
      fullAccess: await upstream?.allowsFullAccess?.().catch(() => false) ?? false,
      fullAccessForm: config.endpoints[agent.endpoint]?.spawn?.runner === 'docker' ? 'container' : 'bare-metal',
    }
    let composer: UpstreamComposerState = { model: null, context: null, accessMode: null }

    // 权限展示真相源（2026-09-11）：宿主 permissions 投影的 preset 是意图标签，
    // 沙箱旋钮漂移后推导值= custom，反推不出真实沙箱（read-only 标签 + 全量旋钮
    // 的组合会显示成只读）。以 manager 记录的钉入值为准，退宿主推导值，再退
    // agent 配置默认（runner 建会话时会钉它）。历史读取前后各套一次：fresh 分支
    // 与主路径的 composer 来源不同。
    const withEffectiveAccess = (current: UpstreamComposerState): UpstreamComposerState => {
      const rowAccess = db.select().from(schema.chat).where(eq(schema.chat.id, chat.id)).get()?.accessMode
      const resolved = rowAccess === 'read-only' || rowAccess === 'workspace-write' || rowAccess === 'danger-full-access'
        ? rowAccess
        : current.accessMode ?? agent.sandboxMode
      return resolved === null ? current : { ...current, accessMode: resolved }
    }

    // 债务卡片链:向宿主要回仍挂起的问答/授权帧(manager 重启后 in-memory 全丢;
    // question/approval 只广播一次)——刷新页面时卡片经重放恢复,用户仍可作答
    // (respond 直达宿主,与回合是否活着无关)。失败静默,恢复通道尽力而为。
    // 必须在 base 之前:liveFrames 重放要带上刚恢复的卡片。
    if (driver === 'apiproxy' && upstream !== null && chat.dshSessionId !== null) {
      try {
        for (const ask of await (upstream.pendingAsks?.(chat.dshSessionId) ?? Promise.resolve([]))) {
          rememberLiveFrame(chat.id, ask)
        }
      } catch {
        // 旧 facade 无恢复端点 → 空。
      }
    }

    const base = {
      chat,
      // `workspacePath` is here rather than left to /api/status because the
      // composer prints it next to the send button, and that line is the one
      // thing this UI adds over DSH: sending to the wrong agent does not mean a
      // worse answer, it means the wrong workspace was written to. Making it
      // depend on a second, racing request would let the page render a send
      // button with no destination under it. Already visible to the same signed
      // in user through /api/status, so nothing new is exposed.
      agent: { id: agent.id, name: agent.name, public: agent.public, workspacePath: agent.workspacePath },
      busyRunId: runningRunId(agent.id),
      activeRuns: activeRunCount(agent.id),
      turns: chatRuns(db, chat.id),
      liveFrames: replayFrames(chat.id),
    }

    if (chat.dshSessionId === null) {
      return reply.header('cache-control', 'no-store').send({ ...base, sessionState: 'fresh', events: [], goal: null, composer: { ...withEffectiveAccess(composer), capabilities } })
    }

    let events: HistoryEvent[] = []
    let sessionState = 'cold'
    let goal: UpstreamGoal | null = null
    const t0 = Date.now()

    // Check cache first — DSH session log reads are expensive (~6s for large sessions).
    const cached = historyCache.get(chat.dshSessionId)
    if (cached !== null) {
      events = cached.events
      sessionState = cached.sessionState
      composer = cached.composer
      goal = cached.goal
      if (cached.title !== null && cached.title !== '') renameChat(db, chat.id, cached.title)
      app.log.info(`GET /api/chats/${chat.id}: history CACHED ${Date.now() - t0}ms, ${events.length} events`)
    } else {
      try {
        if (driver === 'apiproxy' && upstream !== null) {
          // apiproxy path: session.history returns raw events + projections.
          // compactHistory is already called inside upstream.history().
          const history = await upstream.history(chat.dshSessionId)
          events = history.events
          sessionState = history.sessionState
          composer = history.composer
          goal = history.goal
          if (history.title !== null && history.title !== '') renameChat(db, chat.id, history.title)
          historyCache.set(chat.dshSessionId, { events, sessionState, title: history.title, composer, goal })
        } else {
          // Read-only and does not wake the session, so opening an old chat costs
          // nothing on the gateway.
          const history = await client.history(chat.dshSessionId)
          // Chunks were the streaming preview of text the `message` frames already
          // carry. Replaying them costs the browser 30x the events for nothing.
          events = compactHistory(history.events)
          sessionState = history.adopted ? 'live' : 'cold'
          // The gateway names sessions itself; prefer its title over our guess.
          const title = history.header?.title
          if (typeof title === 'string' && title !== '') renameChat(db, chat.id, title)
          historyCache.set(chat.dshSessionId, { events, sessionState, title: title ?? null, composer, goal: null })
        }
        app.log.info(`GET /api/chats/${chat.id}: history ${driver} ${Date.now() - t0}ms, ${events.length} events`)
      } catch (error) {
        app.log.warn(`GET /api/chats/${chat.id}: history ${driver} failed after ${Date.now() - t0}ms: ${(error as Error).message}`)
        if (error instanceof GatewayError && error.status === 404) {
          sessionState = 'lost'
        } else if (error instanceof UpstreamError && error.code === 'not_found') {
          sessionState = 'lost'
        } else {
          const detail = error instanceof GatewayError ? error.message
            : error instanceof UpstreamError ? error.message
              : String(error)
          return reply.code(502).send({ error: 'gateway_unreachable', detail })
        }
      }
    }

    const refreshed = getChat(db, chat.id) ?? chat
    return reply.header('cache-control', 'no-store').send({ ...base, chat: refreshed, sessionState, events, goal, composer: { ...withEffectiveAccess(composer), capabilities } })
  })

  app.patch<{ Params: { id: string }; Body: unknown }>(
    '/api/chats/:id',
    { preHandler: requireUser },
    async (request, reply) => {
      const found = resolve(request.params.id, reply)
      if (found === null) return reply
      const parsed = renameBody.safeParse(request.body)
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' })
      renameChat(db, found.chat.id, parsed.data.title)
      return reply.send({ chat: getChat(db, found.chat.id) })
    },
  )

  /**
   * Hides a chat and hands its gateway slot back.
   *
   * Still named `remove`, not `delete`, because nothing is destroyed: the
   * transcript stays on the gateway and the `dshSessionId` stays on the row, so
   * the conversation remains readable and could be adopted again. What the
   * release gives up is one slot against the gateway's `maxSessions`. Chat
   * sessions are long-lived, so without this every removed chat would hold a
   * slot until DSH restarted.
   *
   * The run rows stay too -- they are the cost ledger, and money spent does not
   * become unspent.
   *
   * Best effort on the release: a chat whose agent has left the config, or an
   * unreachable gateway, must still disappear from the list when asked. The
   * response reports what actually happened rather than assuming.
   */
  app.post<{ Params: { id: string } }>('/api/chats/:id/remove', { preHandler: requireUser }, async (request, reply) => {
    const chat = getChat(db, request.params.id)
    if (chat === null) return reply.code(404).send({ error: 'unknown_chat' })

    let slotReleased = false
    let releaseFailure: string | null = null
    if (chat.dshSessionId !== null) {
      const agent = agentOf(chat.agentId)
      const driver = agent !== undefined ? driverOf(agent.endpoint) : 'gateway'
      if (driver === 'apiproxy') {
        // apiproxy has no slot management; sessions persist in DSH until
        // archived via workspace.archiveSession (which we don't call).
        // Nothing to release.
        slotReleased = false
      } else {
        const client = agent === undefined ? undefined : clients.get(agent.endpoint)
        if (client === undefined) {
          releaseFailure = `agent "${chat.agentId}" is no longer in the config, so the DSH session slot cannot be released`
        } else {
          try {
            const result = await client.release(chat.dshSessionId)
            slotReleased = result.released
          } catch (error) {
            releaseFailure = error instanceof GatewayError ? error.message : String(error)
            app.log.warn(`chat ${chat.id}: releasing session ${chat.dshSessionId} failed: ${releaseFailure}`)
          }
        }
      }
    }

    removeChat(db, chat.id)
    // Queued turns of this chat must not fire after the chat is gone.
    cancelQueuedTurns(chat.id)

    const detail =
      chat.dshSessionId === null
        ? 'session archived — restore it under Archived'
        : releaseFailure !== null
          ? `session archived, but the DSH session slot could not be released and still counts against the gateway limit: ${releaseFailure}`
          : slotReleased
            ? 'session archived and its DSH slot released. The transcript is kept and can be restored.'
            : 'session archived. The gateway no longer holds it, so no slot had to be released. The transcript is kept and can be restored.'

    return reply.send({
      ok: true,
      removedFromManager: true,
      dshSessionId: chat.dshSessionId,
      slotReleased,
      releaseFailure,
      detail,
    })
  })

  /**
   * 蜂群 Q5：清掉「建了但一个字没写」的空会话。
   *
   * 硬删除而不是归档：空会话没有 transcript、没有账单、没有网关 session，
   * 把这样的空壳收进「可恢复的已归档」反而是对恢复承诺的谎报。有过回合
   * 或已被网关起过标题的会话一律 409——红线：有内容的会话只能归档，
   * 永远不许物理删除。
   */
  app.post<{ Params: { id: string } }>('/api/chats/:id/vacate', { preHandler: requireUser }, async (request, reply) => {
    const chat = getChat(db, request.params.id)
    if (chat === null || chat.removedAt !== null) return reply.code(404).send({ error: 'unknown_chat' })

    const turns = db
      .select({ n: count() })
      .from(schema.run)
      .where(eq(schema.run.chatId, chat.id))
      .all()
    if ((turns[0]?.n ?? 0) > 0 || (chat.title ?? '') !== '') {
      return reply.code(409).send({
        error: 'chat_not_empty',
        detail: 'this session has content: it can only be archived, never deleted automatically',
      })
    }

    db.delete(schema.chat).where(eq(schema.chat.id, chat.id)).run()
    return reply.send({ ok: true, vacated: true })
  })

  /**
   * Un-archives a chat.
   *
   * The gateway slot was handed back on archive, so the thread may come back
   * `cold` (revived on the next message) or `lost`. That is reported by
   * `GET /api/chats/:id` and deliberately not hidden here: silently reviving a
   * session would spend money on a click the user thought was free.
   */
  app.post<{ Params: { id: string } }>('/api/chats/:id/restore', { preHandler: requireUser }, async (request, reply) => {
    const chat = getChat(db, request.params.id)
    if (chat === null) return reply.code(404).send({ error: 'unknown_chat' })
    if (chat.removedAt === null) return reply.send({ ok: true, chat, detail: 'this session was already in the list' })
    if (agentOf(chat.agentId) === undefined) {
      // Restoring it would put a row in a tree that has no branch for it: the
      // sidebar groups by configured agents, so it would come back invisible.
      return reply.code(409).send({
        error: 'agent_gone',
        detail: `this session belongs to agent "${chat.agentId}", which is no longer in the config; once restored it will not appear under any agent`,
      })
    }
    restoreChat(db, chat.id)
    return reply.send({ ok: true, chat: getChat(db, chat.id), detail: 'session restored' })
  })

  // ---- turns（债务 E2:回合编排在 chat/turn-runner.ts） ----------------------

  const turns = makeChatTurnRunner({
    db,
    config,
    log: app.log,
    publish,
    rememberLiveFrame,
    invalidateHistory,
  })

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/chats/:id/messages',
    {
      preHandler: requireUser,
      // A turn costs money and holds the agent, so an authenticated but stuck
      // tab cannot spend all day.
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const found = resolve(request.params.id, reply)
      if (found === null) return reply
      const { chat, agent, client, upstream, driver } = found

      const parsed = sendBody.safeParse(request.body)
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', detail: parsed.error.issues.map((i) => i.message) })
      }
      const text = parsed.data.text

      // Titled from the user's own first words before the turn runs, so the
      // sidebar has a label even if the turn then fails.
      setTitleIfEmpty(db, chat.id, deriveTitle(text))
      touchChat(db, chat.id)

      // Echoed to watchers immediately: the sender already has it on screen, but
      // a second tab should not sit blank until the assistant replies.
      const userFrame = { kind: 'user', text, at: Date.now() }
      rememberLiveFrame(chat.id, userFrame)
      publish(chat.id, userFrame)

      // DSH's own queue semantics: accept immediately, run the turn in the
      // background, and report progress through the relay. A synchronous POST
      // would hold the browser's `sending` state for the whole turn and make
      // the second message impossible to send.
      //
      // 蜂群 P5.4 修订：同会话上一回合还在跑 → 排进本会话队列（dock 可见、
      // 可删），完成后自动接着跑；不同会话直接并行。
      try {
        if (turns.hasRunningTurn(chat.id)) {
          const queuedId = randomUUID()
          const position = enqueueTurn(chat.id, {
            id: queuedId,
            chatId: chat.id,
            // Re-read the chat when the turn finally runs: the queued closure
            // must not carry a stale snapshot (a null dshSessionId would make
            // the second turn start a fresh session), and an archived chat
            // must not fire at all. Await the turn, so the queue chain only
            // advances once the previous round-trip truly finished.
            execute: () => {
              const fresh = getChat(db, chat.id)
              if (fresh === null || fresh.removedAt !== null) return Promise.resolve()
              return turns.startChatTurn(fresh, agent, client, upstream, driver, text).then(() => undefined)
            },
          })
          publish(chat.id, { kind: 'turn_queued', id: queuedId, position, text })
          return reply.code(202).send({
            queued: true,
            position,
            chat: getChat(db, chat.id),
          })
        }

        void turns.startChatTurn(chat, agent, client, upstream, driver, text)
        return reply.code(202).send({ accepted: true, chat: getChat(db, chat.id) })
      } catch (error) {
        app.log.error(`chat turn failed for ${chat.id}: ${(error as Error).message}`)
        return reply.code(500).send({ error: 'turn_failed', detail: (error as Error).message })
      }
    },
  )

  /**
   * Drop one queued turn. Edit/undo pulls the text back into the composer;
   * delete just removes it. Idempotent: a turn that already started (or an
   * unknown id) answers ok so the UI can remove the row optimistically.
   */
  app.post<{ Params: { id: string; turnId: string } }>(
    '/api/chats/:id/queued/:turnId/cancel',
    { preHandler: requireUser },
    async (request, reply) => {
      const found = resolve(request.params.id, reply)
      if (found === null) return reply
      cancelQueuedTurn(found.chat.id, request.params.turnId)
      return reply.send({ ok: true })
    },
  )

  app.post<{ Params: { id: string } }>('/api/chats/:id/cancel', { preHandler: requireUser }, async (request, reply) => {
    const found = resolve(request.params.id, reply)
    if (found === null) return reply
    const { chat, client, upstream, driver } = found
    if (turns.abortTurn(chat.id)) {
      return reply.code(202).send({ ok: true })
    }
    if (chat.dshSessionId === null) return reply.code(409).send({ error: 'no_session' })
    try {
      if (driver === 'apiproxy' && upstream !== null) {
        await upstream.cancel(chat.dshSessionId)
      } else {
        await client.cancel(chat.dshSessionId)
      }
      return reply.send({ ok: true })
    } catch (error) {
      return reply.code(502).send({
        error: 'cancel_failed',
        detail: error instanceof GatewayError ? error.message
          : error instanceof UpstreamError ? error.message
            : String(error),
      })
    }
  })

  app.get<{ Params: { id: string } }>('/api/chats/:id/models', { preHandler: requireUser }, async (request, reply) => {
    const found = resolve(request.params.id, reply)
    if (found === null) return reply
    if (found.chat.dshSessionId === null) return reply.code(409).send({ error: 'no_session' })
    if (found.upstream?.modelCatalog === undefined) return reply.code(501).send({ error: 'model_selection_unsupported' })
    try {
      return reply.send({ catalog: await found.upstream.modelCatalog() })
    } catch (error) {
      return reply.code(502).send({ error: 'model_catalog_failed', detail: errorText(error) })
    }
  })

  app.post<{ Params: { id: string }; Body: unknown }>('/api/chats/:id/model', { preHandler: requireUser }, async (request, reply) => {
    const found = resolve(request.params.id, reply)
    if (found === null) return reply
    if (found.chat.dshSessionId === null) return reply.code(409).send({ error: 'no_session' })
    if (turns.hasRunningTurn(found.chat.id)) return reply.code(409).send({ error: 'chat_busy', detail: 'this session is running — switch the model after the current turn ends.' })
    if (found.upstream?.selectModel === undefined) return reply.code(501).send({ error: 'model_selection_unsupported' })
    const parsed = modelBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' })
    try {
      const model = await found.upstream.selectModel(found.chat.dshSessionId, {
        provider: parsed.data.provider,
        model: parsed.data.model,
        ...(parsed.data.reasoningEffort === undefined ? {} : { reasoningEffort: parsed.data.reasoningEffort }),
      })
      invalidateHistory(found.chat.dshSessionId)
      publish(found.chat.id, { kind: 'composer_state', model })
      return reply.send({ model })
    } catch (error) {
      return reply.code(502).send({ error: 'model_selection_failed', detail: errorText(error) })
    }
  })

  app.post<{ Params: { id: string }; Body: unknown }>('/api/chats/:id/sandbox-mode', { preHandler: requireUser }, async (request, reply) => {
    const found = resolve(request.params.id, reply)
    if (found === null) return reply
    if (found.chat.dshSessionId === null) return reply.code(409).send({ error: 'no_session' })
    if (turns.hasRunningTurn(found.chat.id)) return reply.code(409).send({ error: 'chat_busy', detail: 'this session is running — switch the access mode after the current turn ends.' })
    if (found.upstream?.canSetSandboxMode?.() !== true || found.upstream.setSandboxMode === undefined) return reply.code(501).send({ error: 'access_mode_unsupported' })
    const parsed = sandboxModeBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' })
    try {
      await found.upstream.setSandboxMode(found.chat.dshSessionId, parsed.data.mode)
      invalidateHistory(found.chat.dshSessionId)
      publish(found.chat.id, { kind: 'composer_state', accessMode: parsed.data.mode })
      // 成功钉入：清掉可能残留的延迟覆盖（直连成功 = 已生效），并记下展示真相。
      db.update(schema.chat).set({ accessModeOverride: null, accessMode: parsed.data.mode }).where(eq(schema.chat.id, found.chat.id)).run()
      // 全量沙箱切换留痕：用户决策 + 事后可追溯（2026-09-11 拍板）。
      if (parsed.data.mode === 'danger-full-access') {
        audit?.(request.currentUser?.username ?? 'unknown', 'sandbox_mode', `session ${found.chat.id} enabled the full-access sandbox (danger-full-access)`)
      }
      return reply.send({ accessMode: parsed.data.mode })
    } catch (error) {
      // 会话转冷（回合间隙宿主已卸载）：记下覆盖，下回合创建/唤醒时由 runner 钉入。
      const detail = errorText(error)
      if (detail.includes('session_not_live')) {
        db.update(schema.chat).set({ accessModeOverride: parsed.data.mode, accessMode: parsed.data.mode }).where(eq(schema.chat.id, found.chat.id)).run()
        publish(found.chat.id, { kind: 'composer_state', accessMode: parsed.data.mode })
        if (parsed.data.mode === 'danger-full-access') {
          audit?.(request.currentUser?.username ?? 'unknown', 'sandbox_mode', `session ${found.chat.id} requested the full-access sandbox (danger-full-access, effective next turn)`)
        }
        return reply.send({ accessMode: parsed.data.mode, deferred: true })
      }
      return reply.code(502).send({ error: 'access_mode_failed', detail })
    }
  })

  // ---- answering what the agent is blocked on -----------------------------

  /**
   * Answer, or decline, one interactive question.
   *
   * A thin pass-through on purpose: the gateway owns the pending question and the
   * validation of an answer against it, and duplicating either here would mean
   * two places deciding what a valid answer is. Everything this adds is the
   * session lookup and the browser's own authentication.
   */
  app.post<{ Params: { id: string; questionId: string }; Body: { answers?: unknown; decline?: unknown } }>(
    '/api/chats/:id/questions/:questionId',
    { preHandler: requireUser },
    async (request, reply) => {
      const found = resolve(request.params.id, reply)
      if (found === null) return reply
      const { chat, client, upstream, driver } = found
      if (chat.dshSessionId === null) return reply.code(409).send({ error: 'no_session' })
      const body = request.body ?? {}
      // 债务卡片链:应答成功后合成 resolved 帧——上游广播可能永远到不了
      // (runner 已死/断线窗口),不合成的话卡片在前端会一直开着。
      // 经 rememberLiveFrame:既从转录重放(liveFrames)移除卡片,又清 pendingCards。
      const closeQuestion = (outcome: string): void => {
        const resolved = { kind: 'question_resolved', questionId: request.params.questionId, outcome }
        rememberLiveFrame(chat.id, resolved)
        publish(chat.id, resolved)
      }
      try {
        if (driver === 'apiproxy' && upstream !== null) {
          // apiproxy: questionId is the rpcId from the mux frame.
          if (body.decline === true) {
            await upstream.declineQuestion(request.params.questionId, chat.dshSessionId)
            closeQuestion('cancelled')
            return reply.send({ ok: true, outcome: 'cancelled' })
          }
          if (!Array.isArray(body.answers)) return reply.code(400).send({ error: 'answers_required' })
          await upstream.answerQuestion(request.params.questionId, chat.dshSessionId, { answers: body.answers })
          closeQuestion('answered')
          return reply.send({ ok: true, outcome: 'answered' })
        } else {
          if (body.decline === true) {
            await client.declineQuestion(chat.dshSessionId, request.params.questionId)
            closeQuestion('cancelled')
            return reply.send({ ok: true, outcome: 'cancelled' })
          }
          if (!Array.isArray(body.answers)) return reply.code(400).send({ error: 'answers_required' })
          await client.answerQuestion(chat.dshSessionId, request.params.questionId, body.answers as QuestionAnswer[])
          closeQuestion('answered')
          return reply.send({ ok: true, outcome: 'answered' })
        }
      } catch (error) {
        // The gateway's own detail is passed through rather than flattened: a
        // rejected answer says exactly what was wrong with it, and that message
        // is the only thing that lets the person fix it.
        const status = error instanceof GatewayError && error.status === 404 ? 409
          : error instanceof UpstreamError ? 502
            : 502
        return reply.code(status).send({
          error: 'answer_failed',
          detail: errorText(error),
        })
      }
    },
  )

  /** Decide one permission prompt. `allowed-once` covers only the call in hand. */
  app.post<{ Params: { id: string; decisionId: string }; Body: { outcome?: unknown; approvalId?: unknown } }>(
    '/api/chats/:id/approvals/:decisionId',
    { preHandler: requireUser },
    async (request, reply) => {
      const found = resolve(request.params.id, reply)
      if (found === null) return reply
      const { chat, client, upstream, driver } = found
      if (chat.dshSessionId === null) return reply.code(409).send({ error: 'no_session' })
      const outcome = request.body?.outcome
      if (outcome !== 'allowed-once' && outcome !== 'rejected') return reply.code(400).send({ error: 'invalid_outcome' })
      // 债务卡片链:同 questions 路由——合成 resolved,卡片不依赖上游广播。
      const closeApproval = (approvalId: string | undefined): void => {
        const resolved = { kind: 'approval_resolved', decisionId: request.params.decisionId, ...(approvalId === undefined ? {} : { approvalId }), outcome }
        rememberLiveFrame(chat.id, resolved)
        publish(chat.id, resolved)
      }
      try {
        if (driver === 'apiproxy' && upstream !== null) {
          // apiproxy: decisionId is the rpcId from the mux frame; the respond
          // contract also requires the approvalId and sessionId to name the
          // exact pending request, so the browser echoes the approvalId the
          // approval_pending frame carried.
          const approvalId = request.body?.approvalId
          if (typeof approvalId !== 'string' || approvalId === '') return reply.code(400).send({ error: 'approval_id_required' })
          await upstream.decideApproval(request.params.decisionId, chat.dshSessionId, approvalId, outcome)
          closeApproval(approvalId)
        } else {
          await client.decideApproval(chat.dshSessionId, request.params.decisionId, outcome)
          closeApproval(undefined)
        }
        return reply.send({ ok: true, outcome })
      } catch (error) {
        const status = error instanceof GatewayError && error.status === 404 ? 409
          : error instanceof UpstreamError ? 502
            : 502
        return reply.code(status).send({
          error: 'decide_failed',
          detail: errorText(error),
        })
      }
    },
  )

  // ---- relay（债务 E2:SSE 事件流已下沉 chat/relay.ts） --------------------
  // 债务卡片链:SSE(重)连时重放挂起卡片帧——断流窗口丢掉的 question/approval
  // 帧借此回来(转录帧不重放,reduce 非幂等)。
  registerRelayRoute(app, db, requireUser, pendingCardFrames)
}
