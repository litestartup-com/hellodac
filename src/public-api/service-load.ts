/**
 * 服务负载（对外分发的输入）：每个 agent 现在有多忙。
 *
 * 三个数字全部从**已有表**读出来，不新增采集（口径 §4 的负载口径）：
 * - 会话数：`chat` 里该 agent 未移除的会话（对外与对内都算——机器是同一台，不能只看对外）；
 * - 队列深度：该 agent 上 pending/running 的回合（同会话串行，排着的就是队列）；
 * - 最近耗时：该 agent 最近一个跑完回合的时长（毫秒）。
 *
 * "在线"不在库里：端点探活是运行时状态，由调用方（wiring 层）注入，所以这里只算数字，
 * 在线判断留给上层——判活的口径只有一处（supervisor/客户端探活），避免两套真相。
 */
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import type { ResolvedService } from '../config.js'
import { schema, type Db } from '../db/index.js'
import type { ServiceLoad } from './conversations.js'

export interface LoadReaderOptions {
  db: Db
  /** 该 agent 现在是否可达（由 wiring 层用同一套探活口径回答）。 */
  isOnline: (agentId: string) => boolean
  /** 最近 N 个已结束回合里取最后一个的时长；缺省 200 条足够覆盖“最近一轮”。 */
  recentRunLimit?: number
}

export const loadServiceLoad = (service: ResolvedService, options: LoadReaderOptions): ServiceLoad[] => {
  const { db, isOnline } = options
  const agents = [...service.workers]
  if (agents.length === 0) return []

  // 活着的会话（含对内会话：同一台机器的资源是共享的）。
  const sessionRows = db
    .select({ agentId: schema.chat.agentId })
    .from(schema.chat)
    .where(and(isNull(schema.chat.removedAt), inArray(schema.chat.agentId, agents)))
    .all()
  const sessions = new Map<string, number>()
  for (const row of sessionRows) sessions.set(row.agentId, (sessions.get(row.agentId) ?? 0) + 1)

  // 排着的回合 = 该 agent 上还没跑完的 run。
  const queueRows = db
    .select({ agentId: schema.run.agentId })
    .from(schema.run)
    .where(and(inArray(schema.run.agentId, agents), inArray(schema.run.state, ['pending', 'running'])))
    .all()
  const queue = new Map<string, number>()
  for (const row of queueRows) queue.set(row.agentId, (queue.get(row.agentId) ?? 0) + 1)

  const lastTurn = new Map<string, number>()
  for (const agentId of agents) {
    const row = db
      .select({ startedAt: schema.run.startedAt, endedAt: schema.run.endedAt })
      .from(schema.run)
      .where(and(eq(schema.run.agentId, agentId), eq(schema.run.state, 'done')))
      .orderBy(desc(schema.run.startedAt))
      .limit(options.recentRunLimit ?? 20)
      .all()
      .find((candidate) => candidate.endedAt !== null && candidate.endedAt > candidate.startedAt)
    if (row?.endedAt != null) lastTurn.set(agentId, row.endedAt - row.startedAt)
  }

  return agents.map((agentId) => {
    const load: ServiceLoad = {
      agentId,
      online: isOnline(agentId),
      sessions: sessions.get(agentId) ?? 0,
      queueDepth: queue.get(agentId) ?? 0,
    }
    const last = lastTurn.get(agentId)
    return last === undefined ? load : { ...load, lastTurnMs: last }
  })
}

/** 同一把钥匙在各 agent 上的活会话数（分发时用于"同一调用方尽量分散"）。 */
export const keySessionsByAgent = (db: Db, apiKeyId: string, agents: string[]): Record<string, number> => {
  if (agents.length === 0) return {}
  const rows = db
    .select({ agentId: schema.chat.agentId })
    .from(schema.chat)
    .where(and(eq(schema.chat.apiKeyId, apiKeyId), isNull(schema.chat.removedAt), inArray(schema.chat.agentId, agents)))
    .all()
  const counts: Record<string, number> = {}
  for (const row of rows) counts[row.agentId] = (counts[row.agentId] ?? 0) + 1
  return counts
}
