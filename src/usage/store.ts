import { and, desc, eq, gte, lt, sql, type SQL } from 'drizzle-orm'
import { schema, type Db } from '../db/index.js'

/**
 * Spend, read back out of the ledger.
 *
 * Debt E16: the reasoning behind the two cross-cutting rules (a missing rate is not zero /
 * a month is local) now lives in docs/adr/0002-usage-accounting-rules.md; the source only points there.
 */

/** `strftime` over an epoch-milliseconds column, in local time. */
const localBucket = (format: string): SQL<string> =>
  sql.raw(`strftime('${format}', at / 1000, 'unixepoch', 'localtime')`) as SQL<string>

/**
 * Debt B5: bucket filtering no longer uses strftime (the index goes unused, so it full-scans) --
 * the local month/day bucket becomes a half-open epoch-millisecond interval, and `at >= start AND at < end`
 * hits the usage_at index. Exactly equivalent to strftime '%Y-%m'/'%Y-%m-%d' bucketing in local-time semantics.
 */
export const monthRangeMs = (month: string): { start: number; end: number } => {
  const [y, m] = month.split('-').map(Number)
  return { start: new Date(y ?? 0, (m ?? 1) - 1, 1).getTime(), end: new Date(y ?? 0, m ?? 1, 1).getTime() }
}

export const dayRangeMs = (day: string): { start: number; end: number } => {
  const [y, m, d] = day.split('-').map(Number)
  return { start: new Date(y ?? 0, (m ?? 1) - 1, d ?? 1).getTime(), end: new Date(y ?? 0, (m ?? 1) - 1, (d ?? 1) + 1).getTime() }
}

export interface SpendTotals {
  runs: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  /** Sum of known costs, in micro-USD. A floor when `unpriced` is above zero. */
  costMicroUsd: number
  /** The part of `costMicroUsd` billed at the peak rate. */
  peakCostMicroUsd: number
  /** Records whose model had no configured rate, so their cost is unknown. */
  unpriced: number
}

export interface AgentSpend extends SpendTotals {
  agentId: string
}

export interface ModelSpend extends SpendTotals {
  provider: string | null
  model: string | null
}

export interface DailySpend {
  day: string
  costMicroUsd: number
  peakCostMicroUsd: number
  unpriced: number
}

/**
 * Debt E9: aggregate column fragments -- from raw text (AGGREGATES) to drizzle fragments: the table
 * reference is generated and qualified by drizzle from the schema, so a join can no longer silently
 * resolve an unqualified column name to the wrong table; types follow the builder, no hand-written RawTotals generic.
 *
 * `SUM(cost)` skips NULLs, which is exactly right -- an unknown cost must not
 * be added in as zero -- but it also means the total alone cannot tell you
 * whether anything was missing. That is what the `unpriced` counter is for.
 */
const totalsSelection = () => ({
  runs: sql<number>`COUNT(DISTINCT ${schema.usageRecord.runId})`.as('runs'),
  inputTokens: sql<number>`COALESCE(SUM(${schema.usageRecord.inputTokens}), 0)`.as('inputTokens'),
  outputTokens: sql<number>`COALESCE(SUM(${schema.usageRecord.outputTokens}), 0)`.as('outputTokens'),
  cacheReadTokens: sql<number>`COALESCE(SUM(${schema.usageRecord.cacheRead}), 0)`.as('cacheReadTokens'),
  costMicroUsd: sql<number>`COALESCE(SUM(${schema.usageRecord.cost}), 0)`.as('costMicroUsd'),
  peakCostMicroUsd: sql<number>`COALESCE(SUM(${schema.usageRecord.peakCost}), 0)`.as('peakCostMicroUsd'),
  unpriced: sql<number>`SUM(CASE WHEN ${schema.usageRecord.cost} IS NULL THEN 1 ELSE 0 END)`.as('unpriced'),
})

type TotalsRow = {
  runs: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  costMicroUsd: number
  peakCostMicroUsd: number
  unpriced: number
}

const toTotals = (r: TotalsRow | undefined): SpendTotals => ({
  runs: r?.runs ?? 0,
  inputTokens: r?.inputTokens ?? 0,
  outputTokens: r?.outputTokens ?? 0,
  cacheReadTokens: r?.cacheReadTokens ?? 0,
  costMicroUsd: r?.costMicroUsd ?? 0,
  peakCostMicroUsd: r?.peakCostMicroUsd ?? 0,
  unpriced: r?.unpriced ?? 0,
})

/** Months that have any recorded usage, newest first. */
export const spendMonths = (db: Db): string[] => {
  const rows = db
    .selectDistinct({ month: localBucket('%Y-%m') })
    .from(schema.usageRecord)
    .orderBy(desc(localBucket('%Y-%m')))
    .all()
  return rows.map((r) => r.month)
}

/** Debt E15: the dollar <-> micro-dollar factor (the one source in the money domain, no more scattered 1e6 literals). */
export const USD_TO_MICRO = 1_000_000

export const monthTotals = (db: Db, month: string): SpendTotals => {
  const range = monthRangeMs(month)
  const rows = db
    .select(totalsSelection())
    .from(schema.usageRecord)
    .where(and(gte(schema.usageRecord.at, range.start), lt(schema.usageRecord.at, range.end)))
    .all()
  return toTotals(rows[0])
}

/**
 * Spend per agent for a month.
 *
 * The agent is reached through `run`, since `usage_record` only knows its run.
 * Debt E9: a drizzle join generates fully qualified column names -- the old hand-written SQL
 * relied on adding a table prefix to every column by hand, and one miss is a silently wrong answer.
 */
export const monthByAgent = (db: Db, month: string): AgentSpend[] => {
  const range = monthRangeMs(month)
  const rows = db
    .select({ agentId: schema.run.agentId, ...totalsSelection() })
    .from(schema.usageRecord)
    .innerJoin(schema.run, eq(schema.run.id, schema.usageRecord.runId))
    .where(and(gte(schema.usageRecord.at, range.start), lt(schema.usageRecord.at, range.end)))
    .groupBy(schema.run.agentId)
    // The ordering uses the bare alias (raw): drizzle's sql template adds quotes, and SQLite then
    // reads it as a column name rather than a SELECT alias ("no such column: costMicroUsd").
    .orderBy(sql.raw('costMicroUsd DESC, runs DESC'))
    .all()
  return rows.map((r) => ({ agentId: r.agentId, ...toTotals(r) }))
}

export const monthByModel = (db: Db, month: string): ModelSpend[] => {
  const range = monthRangeMs(month)
  const rows = db
    .select({ provider: schema.usageRecord.provider, model: schema.usageRecord.model, ...totalsSelection() })
    .from(schema.usageRecord)
    .where(and(gte(schema.usageRecord.at, range.start), lt(schema.usageRecord.at, range.end)))
    .groupBy(schema.usageRecord.provider, schema.usageRecord.model)
    .orderBy(sql.raw('costMicroUsd DESC, runs DESC'))
    .all()
  return rows.map((r) => ({ provider: r.provider, model: r.model, ...toTotals(r) }))
}

/** One bucket per day that has usage, oldest first, for a bar chart. */
export const monthByDay = (db: Db, month: string): DailySpend[] => {
  const range = monthRangeMs(month)
  const rows = db
    .select({
      day: localBucket('%Y-%m-%d').as('day'),
      costMicroUsd: sql<number>`COALESCE(SUM(${schema.usageRecord.cost}), 0)`.as('costMicroUsd'),
      peakCostMicroUsd: sql<number>`COALESCE(SUM(${schema.usageRecord.peakCost}), 0)`.as('peakCostMicroUsd'),
      unpriced: sql<number>`SUM(CASE WHEN ${schema.usageRecord.cost} IS NULL THEN 1 ELSE 0 END)`.as('unpriced'),
    })
    .from(schema.usageRecord)
    .where(and(gte(schema.usageRecord.at, range.start), lt(schema.usageRecord.at, range.end)))
    .groupBy(localBucket('%Y-%m-%d'))
    .orderBy(localBucket('%Y-%m-%d'))
    .all()
  return rows.map((r) => ({ day: r.day, costMicroUsd: r.costMicroUsd, peakCostMicroUsd: r.peakCostMicroUsd, unpriced: r.unpriced }))
}

/**
 * Spend for one local day, which is what a daily budget has to be measured on.
 *
 * Deliberately a floor: unpriced rows are excluded from the money and counted
 * separately. A budget guard that treated an unknown cost as zero would keep
 * spending happily through the exact situation where it cannot see the bill --
 * so the caller is told, and refuses to run rather than guessing.
 */
export const daySpend = (db: Db, day: string): { costMicroUsd: number; unpriced: number } => {
  const range = dayRangeMs(day)
  const rows = db
    .select({
      costMicroUsd: sql<number>`COALESCE(SUM(${schema.usageRecord.cost}), 0)`.as('costMicroUsd'),
      unpriced: sql<number>`SUM(CASE WHEN ${schema.usageRecord.cost} IS NULL THEN 1 ELSE 0 END)`.as('unpriced'),
    })
    .from(schema.usageRecord)
    .where(and(gte(schema.usageRecord.at, range.start), lt(schema.usageRecord.at, range.end)))
    .all()
  return { costMicroUsd: rows[0]?.costMicroUsd ?? 0, unpriced: rows[0]?.unpriced ?? 0 }
}

/** Today in the same local-time terms the day buckets use. */
export const currentDay = (now: number = Date.now()): string => {
  const d = new Date(now)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** The current month in the same local-time terms the buckets use. */
export const currentMonth = (now: number = Date.now()): string => {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
