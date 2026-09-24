/**
 * Pure-function translation layer between the apiproxy wire format and the
 * manager's own types.
 *
 * Two directions:
 * 1. mux frame payload / history entry → manager's HistoryEvent (same shape as GatewayEvent)
 * 2. manager inputs → apiproxy RPC params
 *
 * 债务 E16:wire 现实核实笔记已迁设计库事实卡 dsh-facts.md §9(translate 段)。
 * 本模块自实现 gateway eventPayload 的子集,不 import dsh-api-gateway(两仓解耦)。
 */

import { z } from 'zod'
import type { HistoryEvent } from '../gateway/client.js'
import { normalizeUsage, type TokenUsage, type GatewayFrame } from '../gateway/stream.js'

// ---- mux frame → HistoryEvent ----

/**
 * 债务 E8:帧体判别 schema——替代手工 `Record<string, unknown>` 拍平。
 * 形状逐帧对照 wire 现实(dsh-facts.md §9;dsh-api-gateway answerer/streams
 * 源码实证):payload.type 与信封 method 一致;未知帧型不在此判别之列
 * (session/subscribed、stream/error、session/queue、session/jobs 由信封层处理
 * 或丢弃),故判别联合无 catch-all——已知帧型形状不符 = fail-loud 丢弃,不猜。
 */

const questionItemSchema = z.object({ id: z.string(), question: z.string() }).passthrough()

const sessionEventFrameSchema = z.object({
  type: z.literal('session/event'),
  sessionId: z.string(),
  /** 事件深形状由 eventPayload 映射(返回 null = 无 wire 形式)。 */
  event: z.unknown(),
  view: z.unknown().optional(),
}).passthrough()

const projectionFrameSchema = z.object({
  type: z.literal('session/projection'),
  sessionId: z.string(),
  key: z.string(),
  value: z.unknown(),
  seq: z.number().optional(),
}).passthrough()

const questionRequestedFrameSchema = z.object({
  type: z.literal('question/requested'),
  sessionId: z.string(),
  questions: z.array(questionItemSchema),
}).passthrough()

const questionResolvedFrameSchema = z.object({
  type: z.literal('question/resolved'),
  sessionId: z.string(),
  questionRpcId: z.string(),
  outcome: z.string(),
}).passthrough()

const approvalRequestedFrameSchema = z.object({
  type: z.literal('approval/requested'),
  sessionId: z.string(),
  approvalId: z.string(),
  toolName: z.string(),
  callId: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
}).passthrough()

const approvalResolvedFrameSchema = z.object({
  type: z.literal('approval/resolved'),
  sessionId: z.string(),
  approvalId: z.string(),
  outcome: z.string(),
}).passthrough()

export const muxFrameSchema = z.discriminatedUnion('type', [
  sessionEventFrameSchema,
  projectionFrameSchema,
  questionRequestedFrameSchema,
  questionResolvedFrameSchema,
  approvalRequestedFrameSchema,
  approvalResolvedFrameSchema,
])

/** 债务 E8:判别后的帧体联合类型(替代旧 loose interface)。 */
export type MuxFrame = z.infer<typeof muxFrameSchema>

/** 已知帧型严格判别;形状不符或未知帧型返回 null(由调用方丢弃)。 */
export const parseMuxPayload = (payload: unknown): MuxFrame | null => {
  const parsed = muxFrameSchema.safeParse(payload)
  return parsed.success ? parsed.data : null
}

// ---- event mapping (mirrors dsh-api-gateway/src/events.ts) ----

const extractBlocks = (content: unknown): { text: string; reasoning: string } => {
  let text = ''
  let reasoning = ''
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block !== null && typeof block === 'object') {
        const b = block as Record<string, unknown>
        if (b.type === 'text') text += String(b.text)
        else if (b.type === 'reasoning') reasoning += String(b.text)
      }
    }
  }
  return { text, reasoning }
}

// 债务 E5:用量归一化不再本地复制(原 normalizeUsage 与 stream.ts 的
// normalizeUsage 逐字重复,连 OPTIONAL_USAGE_KEYS 都两份)——直接复用 gateway
// 侧单一实现,两侧行为永远一致。

const chunkJson = (chunk: unknown): Record<string, unknown> | null => {
  if (chunk === null || typeof chunk !== 'object') return null
  const c = chunk as Record<string, unknown>
  switch (c.type) {
    case 'text-delta': return { type: 'text-delta', text: String(c.text) }
    case 'reasoning-delta': return { type: 'reasoning-delta', text: String(c.text) }
    case 'tool-call-delta': return { type: 'tool-call-delta', id: c.id == null ? null : String(c.id), name: c.name == null ? null : String(c.name), argumentsDelta: String(c.argumentsDelta ?? '') }
    case 'usage': return { type: 'usage', usage: normalizeUsage(c.usage) }
    case 'finish': return { type: 'finish', reason: (c.reason as Record<string, unknown>)?.kind ? String((c.reason as Record<string, unknown>).kind) : 'unknown' }
    default: return null
  }
}

/**
 * Maps a raw session-log event (from mux or history) to a manager HistoryEvent.
 * Returns `null` for event types that have no wire form (e.g. internal bookkeeping).
 */
export const eventPayload = (event: unknown): HistoryEvent | null => {
  if (event === null || typeof event !== 'object') return null
  const e = event as Record<string, unknown>
  const data = (e.data ?? null) as Record<string, unknown> | null
  const seq = typeof e.seq === 'number' ? e.seq : 0
  switch (e.type) {
    case 'user/message':
      return { kind: 'user', seq, messageId: data?.id ? String(data.id) : null, text: extractBlocks(data?.content).text }
    case 'assistant/chunk': {
      const c = chunkJson(data?.chunk)
      if (c === null) return null
      return { kind: 'chunk', seq, chunk: c }
    }
    case 'assistant/message': {
      const parts = extractBlocks((data?.message as Record<string, unknown>)?.content)
      return { kind: 'message', seq, text: parts.text, reasoning: parts.reasoning !== '' ? parts.reasoning : null, usage: normalizeUsage(data?.usage) }
    }
    case 'tool/call':
      return { kind: 'tool_call', seq, name: data ? String(data.name) : '', arguments: data ? String(data.arguments) : '' }
    case 'tool/result': {
      const message = data?.message as Record<string, unknown> | undefined
      const block = message && Array.isArray(message.content) ? message.content[0] as Record<string, unknown> | null : null
      return {
        kind: 'tool_result',
        seq,
        isError: Boolean(data && ((data).error || (block && block.isError))),
        text: block?.content ? extractBlocks(block.content).text : '',
      }
    }
    case 'approval/asked':
      return { kind: 'approval_asked', seq, id: data?.id ? String(data.id) : '', toolName: data?.toolName ? String(data.toolName) : '', callId: data?.callId ? String(data.callId) : null, reason: data?.reason ? String(data.reason) : null }
    case 'approval/decided':
      return { kind: 'approval_decided', seq, id: data?.id ? String(data.id) : '', outcome: data?.outcome ? String(data.outcome) : 'unknown' }
    case 'approval/policy':
      return { kind: 'approval_policy', seq, policy: data?.policy ? String(data.policy) : 'unknown', source: data?.source ? String(data.source) : null }
    case 'turn/start':
      return { kind: 'turn_start', seq, turn: data?.turn ?? null }
    case 'turn/end': {
      const reason = (data?.reason ?? null) as Record<string, unknown> | null
      let detail = null
      if (reason?.kind === 'error' && reason.error) {
        const err = reason.error as Record<string, unknown>
        detail = { message: String(err.message ?? ''), code: String(err.code ?? '') }
      }
      if (reason?.kind === 'aborted' && reason.reason) {
        const r = reason.reason as Record<string, unknown>
        detail = { cause: String(r.kind ?? '') }
      }
      return { kind: 'turn_end', seq, turn: data?.turn ?? null, reason: reason ? String(reason.kind) : 'unknown', detail }
    }
    default:
      return null
  }
}

/**
 * Maps a batch of raw events (from `session.history`) to HistoryEvent[].
 * Drops events with no wire form.
 */
export const mapEvents = (events: readonly unknown[]): HistoryEvent[] => {
  const out: HistoryEvent[] = []
  for (const event of events) {
    const mapped = eventPayload(event)
    if (mapped !== null) out.push(mapped)
  }
  return out
}

/**
 * Extracts a HistoryEvent from a mux `session/event` frame.
 * Returns `null` for non-event frames or unmappable events.
 */
export const muxFrameToEvent = (frame: MuxFrame): HistoryEvent | null => {
  if (frame.type !== 'session/event' || frame.event === undefined) return null
  return eventPayload(frame.event)
}

/**
 * Extracts a GatewayFrame (for the SSE relay) from a mux `session/event` frame.
 * This is the same as muxFrameToEvent but typed as GatewayFrame for the relay.
 */
export const muxFrameToGatewayFrame = (frame: MuxFrame): GatewayFrame | null => {
  const event = muxFrameToEvent(frame)
  if (event === null) return null
  return event
}

// ---- manager input → apiproxy params ----

/**
 * Build params for `session.create`.
 * apiproxy auto-installs model selection (P4 confirmed), so provider/model
 * are NOT passed. cwd is the workspace path.
 */
export const createSessionParams = (opts: { cwd: string; preset?: string | null }): Record<string, unknown> => ({
  cwd: opts.cwd,
  ...(opts.preset != null ? { agentPreset: opts.preset } : {}),
})

/**
 * Build params for `session.prompt`.
 * mode:'queue' means "add to inbox, let the agent decide when to process".
 * This also serves as attach/resume for cold sessions (P3 confirmed).
 */
export const promptParams = (sessionId: string, text: string): Record<string, unknown> => ({
  sessionId,
  mode: 'queue',
  content: [{ type: 'text', text }],
})

/** Build params for `session.cancel`. */
export const cancelParams = (sessionId: string): Record<string, unknown> => ({
  sessionId,
})

/** Build params for `session.history`. */
export const historyParams = (sessionId: string): Record<string, unknown> => ({
  sessionId,
})

/** Build params for `session.list`. */
export const listSessionsParams = (): Record<string, unknown> => ({})

// ---- projection extraction ----

/**
 * Extracts token usage from a `session/projection` mux frame.
 * Returns null if the frame is not a projection or has no tokenUsage.
 */
export const extractProjectionUsage = (frame: MuxFrame): { sessionId: string; usage: TokenUsage } | null => {
  if (frame.type !== 'session/projection') return null
  if (frame.key !== 'tokenUsage') return null
  const usage = normalizeUsage(frame.value)
  if (usage === null) return null
  return { sessionId: frame.sessionId, usage }
}

/**
 * Extracts title from a `session/projection` mux frame.
 */
export const extractProjectionTitle = (frame: MuxFrame): { sessionId: string; title: string } | null => {
  if (frame.type !== 'session/projection') return null
  if (frame.key !== 'title' || typeof frame.value !== 'string' || frame.value === '') return null
  return { sessionId: frame.sessionId, title: frame.value }
}

// ---- goal 投影 → Ongoing Goal 条（2026-09-11：DSH web 的 GoalBar 同源数据） ----

/**
 * 宿主 `goal` 投影的 wire 形状（GoalProjection | null）中 manager 需要的部分。
 * phase=complete 时前端不渲染；blockedReason 仅 phase=blocked 时非空。
 */
export interface UpstreamGoal {
  id: string
  objective: string
  phase: 'active' | 'paused' | 'blocked' | 'complete'
  blockedReason: string | null
}

/** 宿主 `goal` 投影的 wire 形状（GoalProjection | null）中 manager 需要的部分（债务 E8:投影判别 schema）。 */
const goalSchema = z.object({
  id: z.string(),
  objective: z.string(),
  phase: z.enum(['active', 'paused', 'blocked', 'complete']),
  blockedReason: z.object({ message: z.string().optional() }).passthrough().nullable().optional(),
}).passthrough()

/** 解析 goal 投影 wire 值；形状不符返回 null（前端视为无目标）。 */
export const goalOf = (value: unknown): UpstreamGoal | null => {
  const parsed = goalSchema.safeParse(value)
  if (!parsed.success) return null
  const { id, objective, phase, blockedReason } = parsed.data
  return { id, objective, phase, blockedReason: blockedReason?.message ?? null }
}

/**
 * `session/projection` key=goal 帧 → `{kind:'goal'}` GatewayFrame；
 * 其它 key 或形状不符返回 null（dispatch 丢弃）。
 */
export const goalProjectionFrame = (payload: MuxFrame): GatewayFrame | null => {
  if (payload.type !== 'session/projection' || payload.key !== 'goal') return null
  const seq = typeof payload.seq === 'number' ? payload.seq : 0
  return { kind: 'goal', seq, goal: goalOf(payload.value) }
}

// ---- mux 问答/授权帧 → GatewayFrame（供 runner 与浏览器消费） ----

/** 判别联合中 question/requested 变体的窄类型。 */
export type QuestionRequestedFrame = Extract<MuxFrame, { type: 'question/requested' }>
/** 判别联合中 question/resolved 变体的窄类型。 */
export type QuestionResolvedFrame = Extract<MuxFrame, { type: 'question/resolved' }>
/** 判别联合中 approval/requested 变体的窄类型。 */
export type ApprovalRequestedFrame = Extract<MuxFrame, { type: 'approval/requested' }>
/** 判别联合中 approval/resolved 变体的窄类型。 */
export type ApprovalResolvedFrame = Extract<MuxFrame, { type: 'approval/resolved' }>

/**
 * `question/requested` payload → question_asked GatewayFrame.
 * The envelope's rpcId is the id echoed back to `respond`, so it doubles as
 * the manager's questionId.
 */
export const questionRequestedFrame = (rpcId: string, payload: QuestionRequestedFrame): GatewayFrame => ({
  kind: 'question_asked',
  seq: 0,
  questionId: rpcId,
  questions: payload.questions,
})

/** `question/resolved` payload → question_resolved GatewayFrame. */
export const questionResolvedFrame = (payload: QuestionResolvedFrame): GatewayFrame => ({
  kind: 'question_resolved',
  seq: 0,
  questionId: payload.questionRpcId,
  outcome: payload.outcome,
})

/**
 * `approval/requested` payload → approval_pending GatewayFrame.
 * The envelope's rpcId is the id echoed back to `respond`; approvalId is
 * carried alongside so the respond payload can name the exact request.
 */
export const approvalRequestedFrame = (rpcId: string, payload: ApprovalRequestedFrame): GatewayFrame => ({
  kind: 'approval_pending',
  seq: 0,
  decisionId: rpcId,
  approvalId: payload.approvalId,
  toolName: payload.toolName,
  reason: payload.reason ?? null,
})

/**
 * `approval/resolved` payload → approval_resolved GatewayFrame.
 * The resolved frame names the approvalId, not the original rpcId, so the
 * caller supplies decisionId from its approvalId→rpcId map.
 */
export const approvalResolvedFrame = (payload: ApprovalResolvedFrame, decisionId: string | null): GatewayFrame => ({
  kind: 'approval_resolved',
  seq: 0,
  decisionId,
  approvalId: payload.approvalId,
  outcome: payload.outcome,
})

// ---- history / session.list 解包 ----

/**
 * `session.history` 的 value 是 `{ events:[{ event, view? }], hasMore, projections? }`。
 * 拆出每项的 `event`（裸 session 事件），供 mapEvents 消费。
 */
export const unwrapHistoryEvents = (value: unknown): unknown[] => {
  if (value === null || typeof value !== 'object') return []
  const v = value as Record<string, unknown>
  if (!Array.isArray(v.events)) return []
  const out: unknown[] = []
  for (const entry of v.events) {
    if (entry !== null && typeof entry === 'object') {
      out.push((entry as Record<string, unknown>).event)
    }
  }
  return out
}

/**
 * `session.list` 的 value 是 `{ items:[{ sessionId, updatedAt, running, blank, projections? }] }`。
 * title 位于 `projections.values.title`（投影块形如 `{ asOfSeq, values }`）。
 */
export interface SessionSummary {
  sessionId: string
  title?: string
  updatedAt: number | null
  running: boolean
  blank: boolean
}

/** 债务 E8:session.list 投影判别 schema（wire 形状见模块头注释）。 */
const sessionListItemSchema = z.object({
  sessionId: z.string(),
  updatedAt: z.number().optional(),
  running: z.boolean().optional(),
  blank: z.boolean().optional(),
  projections: z.object({
    values: z.object({ title: z.string().optional() }).passthrough(),
  }).passthrough().optional(),
}).passthrough()

export const mapSessionList = (value: unknown): SessionSummary[] => {
  const parsed = z.object({ items: z.array(sessionListItemSchema) }).passthrough().safeParse(value)
  if (!parsed.success) return []
  return parsed.data.items.map((s) => {
    const title = s.projections?.values.title
    return {
      sessionId: s.sessionId,
      ...(title === undefined ? {} : { title }),
      updatedAt: s.updatedAt ?? null,
      running: s.running ?? false,
      blank: s.blank ?? false,
    }
  })
}
