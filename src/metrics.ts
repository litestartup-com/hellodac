import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import { sql } from 'drizzle-orm'
import type { Db } from './db/index.js'
import { daySpend, currentDay } from './usage/store.js'
import { openChatRelays } from './routes/chat.js'
import { getMuxReconnects } from './upstream/mux.js'

/**
 * 债务 B6(简化版):可观测性第一脚——/metrics 端点 + 快照纯函数。
 *
 * 本简化版覆盖成本控制与排障最需要的几个数:run 状态分布、7 天失败率、
 * 当日花费(含未定价缺口)、活跃 run、SSE 连接数、mux 重连计数。
 * requestId 贯通由 fastify genReqId(index.ts 接线)负责;结构化 run/turn
 * 事件流与单回合成本上限仍是 B6 的后续。
 */

export interface MetricsSnapshot {
  uptimeMs: number
  runs: {
    total: number
    byState: Record<string, number>
    /** 最近 7 天内已终局 run 的失败率(0-1,无样本 = null)。 */
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
