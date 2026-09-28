/**
 * A key's daily quota and concurrency count (design: internal design library `manager/topics/public-api.md` §5).
 *
 * **The day boundary is the manager host's local day**, the same rule as the spend page
 * (`strftime(..., 'localtime')`, `dayRangeMs` in `usage/store.ts`) and as docs/adr/0002's 'months are
 * local': with a second timezone for quota, 'how much was used today' would not match the block.
 *
 * Counting keeps no separate accumulator: the `run` rows are the ledger (`api_key_id` + `started_at`,
 * served by the `run_api_key` index), so a counter can never drift away from the truth.
 */
import { and, eq, gte, inArray, sql } from 'drizzle-orm'
import { schema, type Db } from '../db/index.js'
import type { ApiKey } from '../auth/api-key.js'

const DAY_MS = 86_400_000

/** Local midnight on the host (same source as `new Date(y, m, d)`, hence the same bucketing as the spend page). */
export const startOfLocalDay = (now: number = Date.now()): number => {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** How many jobs this key dispatched today (failures and running ones included -- **the quota counts dispatches, not successes**). */
export const runsUsedToday = (db: Db, apiKeyId: string, now: number = Date.now()): number => {
  const rows = db
    .select({ n: sql<number>`COUNT(*)`.as('n') })
    .from(schema.run)
    .where(and(eq(schema.run.apiKeyId, apiKeyId), gte(schema.run.startedAt, startOfLocalDay(now))))
    .all()
  return rows[0]?.n ?? 0
}

/** Jobs this key has running right now (pending/running) -- used for the concurrency cap. */
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
 * The admission check before a dispatch. The check and the actual run-row insert happen in one
 * process and one tick (single process + a synchronous driver), so there is no check-then-use race;
 * even a slight overshoot under extreme concurrency only runs one extra job, never breaks the books.
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

/** For `GET /v1/usage` to display: this key's usage today plus the remaining quota. */
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
