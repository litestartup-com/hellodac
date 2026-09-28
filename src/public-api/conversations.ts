/**
 * 对外会话（口径：内部设计库 `manager/topics/CONCEPTS-ALIGNED.md` §4.2/§6）。
 *
 * 这里的函数都是**纯的**：输入 = 配置、钥匙、数据库里读出来的负载事实；输出 = 该用哪个
 * 服务、该挑哪个 agent、该复用哪个会话、以及怎么把结果讲给调用方。凡是需要读库/发网络的
 * 部分都留在路由层，于是"分发给谁"这件事可以单测、可以在界面上预演、可以事后复算。
 *
 * 一次调用的完整判断顺序（每一步都能单独解释）：
 *   1. 服务：请求里点名（钥匙只允许一个服务时可省）→ 必须在这把钥匙的范围内；
 *   2. 粘性：带外部用户 id 且已有活会话 → 直接复用，**不重新分发**（换 agent = 客户失忆）；
 *   3. 配额：日次数与并发上限（没有余额就没有下一步）；
 *   4. 分发：在该服务的 agent 里挑最闲的（会话数 → 队列 → 最近耗时；平手轮询）；
 *   5. 满载/无人：如实告诉调用方（429/503 + 重试提示），排队与否由调用方决定。
 */
import { allowsService, hasScope, type ApiKey } from '../auth/api-key.js'
import type { AppConfig, ResolvedService } from '../config.js'
import { pickWorker, type DispatchRequest, type WorkerFacts } from '../services/dispatch.js'

export type ConversationRejection =
  /** 请求没点名服务，而钥匙允许不止一个。 */
  | { kind: 'service_required' }
  | { kind: 'unknown_service'; service: string }
  | { kind: 'service_not_allowed'; service: string }
  | { kind: 'scope_missing'; scope: string }
  | { kind: 'quota_exhausted'; limit: number; used: number }
  | { kind: 'concurrency_exhausted'; limit: number; active: number }
  | { kind: 'all_busy'; retryAfterSeconds: number; capacity: number; inUse: number }
  | { kind: 'no_agent_online' }
  | { kind: 'agent_unavailable'; agentId: string }

export type ServiceResolution =
  | { ok: true; service: ResolvedService }
  | { ok: false; reason: ConversationRejection }

/**
 * 选出这次调用要用哪个服务。
 *
 * 钥匙允许几个服务就要求调用方点名（`service` 字段）——"你没说是哪个"必须是明确错误，
 * 而不是替他挑一个：挑错服务等于把客服的请求送进报表 agent。
 */
export const resolveService = (config: AppConfig, key: ApiKey, requested: string | undefined): ServiceResolution => {
  const allowed = (config.services ?? []).filter((service) => allowsService(key, service.id))
  const wanted = requested?.trim()
  if (wanted === undefined || wanted === '') {
    if (allowed.length === 1) {
      const only = allowed[0]
      if (only !== undefined) return { ok: true, service: only }
    }
    // 服务名不在钥匙范围内时，对外只回"不允许"，不回"有没有这个服务"（不给探测者情报）。
    return { ok: false, reason: { kind: 'service_required' } }
  }
  const named = (config.services ?? []).find((service) => service.id === wanted)
  if (named === undefined) return { ok: false, reason: { kind: 'unknown_service', service: wanted } }
  if (!allowsService(key, named.id)) return { ok: false, reason: { kind: 'service_not_allowed', service: wanted } }
  return { ok: true, service: named }
}

/** 粘性锚点：同一把钥匙 + 调用方自己的用户 id = 同一个会话。 */
export interface StickyAnchor {
  apiKeyId: string
  externalUserId: string
}

export interface ExistingConversation {
  chatId: string
  agentId: string
  dshSessionId: string | null
}

/** 服务当前的负载事实（每个 agent 一条），由调用方从库里读好。 */
export interface ServiceLoad {
  agentId: string
  online: boolean
  /** 该 agent 上还活着的对外会话数。 */
  sessions: number
  /** 本会话队列里排着的回合数（同会话串行）。 */
  queueDepth: number
  /** 最近一轮耗时（毫秒）；没有实测数据 = undefined。 */
  lastTurnMs?: number
}

/** 该服务在某个 agent 上的会话数（含其他钥匙开的）——负载口径与对内一致。 */
export interface DispatchInput {
  service: ResolvedService
  load: ServiceLoad[]
  /** 本钥匙在各 agent 上已有的会话数（同一调用方尽量分散）。 */
  keySessionsByAgent?: Record<string, number>
  /** 轮询种子：让平手时轮流坐庄（同一秒内的并发请求不会全压同一个 agent）。 */
  rotationSeed?: number
}

export type DispatchOutcome =
  | { ok: true; agentId: string; sessions: number; full: string[] }
  | { ok: false; reason: ConversationRejection }

export const dispatchConversation = (input: DispatchInput): DispatchOutcome => {
  const request: DispatchRequest = {
    workers: input.load.map(
      (item): WorkerFacts => ({
        agentId: item.agentId,
        online: item.online,
        sessions: item.sessions,
        queueDepth: item.queueDepth,
        ...(item.lastTurnMs === undefined ? {} : { lastTurnMs: item.lastTurnMs }),
      }),
    ),
    maxSessionsPerAgent: input.service.maxSessionsPerAgent ?? 4,
    ...(input.keySessionsByAgent === undefined ? {} : { keySessionsByAgent: input.keySessionsByAgent }),
    ...(input.rotationSeed === undefined ? {} : { rotationSeed: input.rotationSeed }),
  }
  const picked = pickWorker(request)
  if (picked.ok) return { ok: true, agentId: picked.agentId, sessions: picked.sessions, full: picked.full }

  if (picked.reason === 'no_worker_online') return { ok: false, reason: { kind: 'no_agent_online' } }
  // 满载不是错误而是容量：如实回报容量与在用量，并按"每 agent 4 会话"给一个粗糙但
  // 可用的重试建议（调用方据此退避；精确预测要等某个会话结束，manager 不猜）。
  return {
    ok: false,
    reason: {
      kind: 'all_busy',
      capacity: picked.capacity,
      inUse: picked.inUse,
      retryAfterSeconds: 5,
    },
  }
}

/** 配额与并发的准入判断（数字从哪里来由调用方决定：都是 DB 计数）。 */
export const checkAdmission = (
  key: ApiKey,
  usage: { runsToday: number; activeRuns: number },
): ConversationRejection | null => {
  if (!hasScope(key, 'conversations:write')) {
    return { kind: 'scope_missing', scope: 'conversations:write' }
  }
  if (key.quotaRunsDay !== null && usage.runsToday >= key.quotaRunsDay) {
    return { kind: 'quota_exhausted', limit: key.quotaRunsDay, used: usage.runsToday }
  }
  if (usage.activeRuns >= key.maxConcurrency) {
    return { kind: 'concurrency_exhausted', limit: key.maxConcurrency, active: usage.activeRuns }
  }
  return null
}

/** 拒绝原因 → HTTP 状态与给人看的说明（对外措辞，不泄漏内部结构）。 */
export const rejectAsHttp = (
  reason: ConversationRejection,
): { status: number; body: Record<string, unknown>; retryAfterSeconds?: number } => {
  switch (reason.kind) {
    case 'scope_missing':
      return { status: 403, body: { error: 'forbidden', detail: `this key is missing scope ${reason.scope}` } }
    case 'service_required':
      return { status: 400, body: { error: 'service_required', detail: 'this key may call several services; name one in "service"' } }
    case 'unknown_service':
      return { status: 404, body: { error: 'unknown_service', detail: `no service named ${reason.service}` } }
    case 'service_not_allowed':
      return { status: 403, body: { error: 'service_not_allowed', detail: `this key may not call ${reason.service}` } }
    case 'quota_exhausted':
      return { status: 429, body: { error: 'quota_exhausted', used: reason.used, limit: reason.limit } }
    case 'concurrency_exhausted':
      return { status: 429, body: { error: 'too_many_in_flight', active: reason.active, limit: reason.limit } }
    case 'all_busy':
      return {
        status: 429,
        body: { error: 'all_agents_busy', capacity: reason.capacity, inUse: reason.inUse },
        retryAfterSeconds: reason.retryAfterSeconds,
      }
    case 'no_agent_online':
      return { status: 503, body: { error: 'no_agent_online', detail: 'this service currently has no reachable agent' } }
    case 'agent_unavailable':
      return { status: 503, body: { error: 'agent_unavailable', agent: reason.agentId } }
  }
}
