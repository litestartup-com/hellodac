import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import { sql } from 'drizzle-orm'
import type { Db } from './db/index.js'
import { daySpend, currentDay } from './usage/store.js'
import { openChatRelays } from './routes/chat.js'
import { getMuxReconnects } from './upstream/mux.js'

/**
 * Debt B6 (simplified): the first step of observability -- a /metrics endpoint plus a pure snapshot function.
 *
 * This simplified version covers the few numbers cost control and troubleshooting need most: the run state
 * distribution, the 7-day failure rate, today's spend (unpriced gaps included), active runs, SSE connections
 * and the mux reconnect count. Propagating requestId is fastify genReqId's job (wired in index.ts); the
 * structured run/turn event stream and the per-turn cost ceiling are still to come under B6.
 */

export interface MetricsSnapshot {
  uptimeMs: number
  runs: {
    total: number
    byState: Record<string, number>
    /** Failure rate of terminal runs over the last 7 days (0-1, null when there is no sample). */
    failedRate7d: number | null
  }
  spendToday: { costMicroUsd: number; unpriced: number }
  activeRuns: number
  sseConnections: number
  muxReconnects: number
}

const bootAt = Date.now()

export const buildMetricsSnapshot = (db: Db): MetricsSnapshot => {
  const rows = db.all<{ state: string; count: number }>(sql`SELECT state, COUNT(*) AS count FROM run GROUP BY state`)
  const byState: Record<string, number> = {}
  let total = 0
  for (const row of rows) {
    byState[row.state] = row.count
    total += row.count
  }
  const failed7d = db.all<{ failed: number | null; settled: number | null }>(sql`
    SELECT
      SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN state IN ('done', 'failed') THEN 1 ELSE 0 END) AS settled
    FROM run WHERE started_at >= ${Date.now() - 7 * 86_400_000}
  `)
  const f = failed7d[0]
  const failedRate7d = f !== undefined && f.settled !== null && f.settled > 0 ? (f.failed ?? 0) / f.settled : null
  const spend = daySpend(db, currentDay())
  return {
    uptimeMs: Date.now() - bootAt,
    runs: { total, byState, failedRate7d },
    spendToday: spend,
    activeRuns: byState['running'] ?? 0,
    sseConnections: openChatRelays(),
    muxReconnects: getMuxReconnects(),
  }
}

export const registerMetricsRoutes = (app: FastifyInstance, db: Db, requireUser: preHandlerHookHandler): void => {
  app.get('/metrics', { preHandler: requireUser }, async (_request, reply) => {
    return reply.send(buildMetricsSnapshot(db))
  })
}
