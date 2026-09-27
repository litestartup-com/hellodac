/**
 * 钥匙的日配额与并发计数（设计稿：内部设计库 `manager/topics/public-api.md` §5）。
 *
 * **日界线 = manager 主机本地日**，与花费页（`strftime(..., 'localtime')`、
 * `usage/store.ts` 的 `dayRangeMs`）同一口径，也与 docs/adr/0002 的"月是本地"一致：
 * 配额若另用一个时区，界面显示的"今天用了多少"就会和拦不拦你对不上。
 *
 * 计数不做独立累加器：`run` 行本身就是账本（`api_key_id` + `started_at`，走
 * `run_api_key` 索引），因此不存在计数器与真相漂移的问题。
 */
import { and, eq, gte, inArray, sql } from 'drizzle-orm'
import { schema, type Db } from '../db/index.js'
import type { ApiKey } from '../auth/api-key.js'

const DAY_MS = 86_400_000

/** 主机本地日零点（与 `new Date(y, m, d)` 同源，故与花费页分桶等价）。 */
export const startOfLocalDay = (now: number = Date.now()): number => {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 本钥匙今天已经派出去几个活（含失败/在跑的——**配额按"派出去"算，不按成功算**）。 */
export const runsUsedToday = (db: Db, apiKeyId: string, now: number = Date.now()): number => {
  const rows = db
    .select({ n: sql<number>`COUNT(*)`.as('n') })
    .from(schema.run)
    .where(and(eq(schema.run.apiKeyId, apiKeyId), gte(schema.run.startedAt, startOfLocalDay(now))))
    .all()
  return rows[0]?.n ?? 0
}

/** 本钥匙当前在跑的活（pending/running）——并发上限用。 */
export const activeRunsForKey = (db: Db, apiKeyId: string): number => {
  const rows = db
    .select({ n: sql<number>`COUNT(*)`.as('n') })
    .from(schema.run)
    .where(and(eq(schema.run.apiKeyId, apiKeyId), inArray(schema.run.state, ['pending', 'running'])))
    .all()
  return rows[0]?.n ?? 0
}

export type QuotaVerdict =
  | { ok: true; used: number; limit: number | null; remaining: number | null; active: number }
  | { ok: false; reason: 'quota_exceeded'; used: number; limit: number; resetsAt: number }
  | { ok: false; reason: 'concurrency_exceeded'; active: number; limit: number }

/**
 * 派活前的准入判定。判定与真正的 run 行插入在同一进程同一 tick 内完成
 * （单进程 + 同步驱动），因此不存在检查-使用竞态；即便极端并发下略微超出，
 * 也只会多跑一个活，不会破坏账目。
 */
export const checkRunQuota = (db: Db, key: ApiKey, now: number = Date.now()): QuotaVerdict => {
  const used = runsUsedToday(db, key.id, now)
  if (key.quotaRunsDay !== null && used >= key.quotaRunsDay) {
    return { ok: false, reason: 'quota_exceeded', used, limit: key.quotaRunsDay, resetsAt: startOfLocalDay(now) + DAY_MS }
  }
  const active = activeRunsForKey(db, key.id)
  if (active >= key.maxConcurrency) {
    return { ok: false, reason: 'concurrency_exceeded', active, limit: key.maxConcurrency }
  }
  return {
    ok: true,
    used,
    limit: key.quotaRunsDay,
    remaining: key.quotaRunsDay === null ? null : key.quotaRunsDay - used,
    active,
  }
}

/** 供 `GET /v1/usage` 展示：本钥匙本日用量 + 配额余量。 */
export const quotaSnapshot = (
  db: Db,
  key: ApiKey,
  now: number = Date.now(),
): { used: number; limit: number | null; remaining: number | null; active: number; resetsAt: number } => {
  const used = runsUsedToday(db, key.id, now)
  return {
    used,
    limit: key.quotaRunsDay,
    remaining: key.quotaRunsDay === null ? null : Math.max(0, key.quotaRunsDay - used),
    active: activeRunsForKey(db, key.id),
    resetsAt: startOfLocalDay(now) + DAY_MS,
  }
}
