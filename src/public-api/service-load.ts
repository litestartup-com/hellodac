/**
 * Service load: the input dispatch needs, i.e. how busy each agent of a service is.
 *
 * All three numbers come from tables that already exist; nothing new is collected
 * (load contract: CONCEPTS-ALIGNED.md §4):
 * - sessions: live chats of that agent (internal chats count too -- the machine is
 *   shared, so pretending only outward work matters would misreport the load);
 * - queue depth: pending/running runs on that agent (turns inside a conversation are
 *   serial, so whatever is queued behind is queue depth);
 * - last latency: duration of the most recently finished turn on that agent, in ms.
 *
 * Liveness is **not** in the database: whether an endpoint answers is runtime state, so
 * the caller (the wiring layer) injects it. That keeps one liveness opinion in the
 * system instead of two disagreeing ones.
 */
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import type { ResolvedService } from '../config.js'
import { schema, type Db } from '../db/index.js'
import type { ServiceLoad } from './conversations.js'

export interface LoadReaderOptions {
  db: Db
  /** Whether this agent is reachable right now (the wiring layer answers from its one liveness source). */
  isOnline: (agentId: string) => boolean
  /** How many recent finished runs to inspect for the last latency; 200 is plenty. */
  recentRunLimit?: number
}

export const loadServiceLoad = (service: ResolvedService, options: LoadReaderOptions): ServiceLoad[] => {
  const { db, isOnline } = options
  const agents = [...service.workers]
  if (agents.length === 0) return []

  // Live conversations, internal ones included: they occupy the same agents.
  const sessionRows = db
    .select({ agentId: schema.chat.agentId })
    .from(schema.chat)
    .where(and(isNull(schema.chat.removedAt), inArray(schema.chat.agentId, agents)))
    .all()
  const sessions = new Map<string, number>()
  for (const row of sessionRows) sessions.set(row.agentId, (sessions.get(row.agentId) ?? 0) + 1)

  // Queued work = runs on that agent that have not finished yet.
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

/** Live conversations this key holds per agent (dispatch spreads one caller's load out). */
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
