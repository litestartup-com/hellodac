import assert from 'node:assert/strict'
import { test } from 'node:test'
import { eq } from 'drizzle-orm'
import type { AppConfig, ResolvedAgent } from '../config.js'
import { schema, type Db } from '../db/index.js'
import type { GatewayClient } from '../gateway/client.js'
import { DEFAULT_PRICING } from '../pricing.js'
import { type RunOutcome } from '../runner.js'
import { Scheduler, missedBetween, scheduleProblem, type CronDeps } from './schedule.js'
// 债务 C3:makeDb/agentFor 收敛进 test-harness(本地保留别名,行为不变)。
import { makeDb as makeHarnessDb, personalAgent } from '../test-harness.js'

const AGENT: ResolvedAgent = { ...personalAgent('/tmp/ws') }

const configWith = (over: Partial<AppConfig['runner']> = {}): AppConfig => ({
  listen: { host: '127.0.0.1', port: 0 },
  endpoints: { A: { id: 'A', url: 'http://127.0.0.1:1', driver: 'gateway', prefix: '/api-gw/v1', key: 'k', sandboxBase: null, sandboxKey: '', spawn: null, access: null } },
  agents: { personal: AGENT },
  runner: { timeoutMs: 1000, silenceMs: 0, maxConsecutiveFailures: 3, dailyBudgetMicroUsd: null, ...over },
  databasePath: ':memory:',
  pricing: DEFAULT_PRICING,
  sessionSecret: 'x'.repeat(32),
  initialUser: { username: 'admin', password: null },
  warnings: [],
})

const makeDb = (): Db => makeHarnessDb().db

interface SeedCron {
  id?: string
  schedule?: string
  enabled?: number
  createdAt?: number
  lastRunAt?: number | null
  consecutiveFailures?: number
}

const seedCron = (db: Db, over: SeedCron = {}): string => {
  const id = over.id ?? 'c1'
  db.insert(schema.cron)
    .values({
      id,
      agentId: 'personal',
      name: `job-${id}`,
      schedule: over.schedule ?? '0 8 * * *',
      timezone: 'Asia/Shanghai',
      prompt: 'write the weekly review',
      enabled: over.enabled ?? 1,
      consecutiveFailures: over.consecutiveFailures ?? 0,
      lastRunAt: over.lastRunAt ?? null,
      createdAt: over.createdAt ?? Date.now(),
    })
    .run()
  return id
}

const silent = { info: () => {}, warn: () => {}, error: () => {} }

const outcome = (over: Partial<RunOutcome> = {}): RunOutcome => ({
  runId: 'r1',
  state: 'done',
  sessionId: 's1',
  summary: 'ok',
  usage: null,
  costMicroUsd: null,
  peakCostMicroUsd: null,
  provider: null,
  model: null,
  reason: 'completed',
  error: null,
  toolCalls: 0,
  durationMs: 5,
  commit: null,
  changedFiles: [],
  snapshotSkipped: null,
  conflict: null,
  ...over,
})

const deps = (db: Db, over: Partial<CronDeps> = {}): CronDeps => ({
  db,
  config: configWith(),
  clients: new Map<string, GatewayClient>([['A', {} as GatewayClient]]),
  log: silent,
  ...over,
})

const cronRow = (db: Db, id: string): typeof schema.cron.$inferSelect =>
  db.select().from(schema.cron).where(eq(schema.cron.id, id)).all()[0] as typeof schema.cron.$inferSelect

const runsFor = (db: Db, id: string): (typeof schema.run.$inferSelect)[] =>
  db.select().from(schema.run).where(eq(schema.run.cronId, id)).all()

// --- pattern validation ------------------------------------------------------

test('a pattern that can never fire again is rejected rather than loaded', () => {
  // 30 February parses fine and simply never happens. Accepting it would give a
  // schedule that looks active in the UI and silently never runs.
  assert.notEqual(scheduleProblem('0 0 30 2 *', 'Asia/Shanghai'), null)
  assert.equal(scheduleProblem('0 8 * * *', 'Asia/Shanghai'), null)
  assert.notEqual(scheduleProblem('not a cron', 'Asia/Shanghai'), null)
  assert.notEqual(scheduleProblem('0 8 * * *', 'Mars/Olympus_Mons'), null)
})

test('one unschedulable row does not stop the others from loading', () => {
  const db = makeDb()
  seedCron(db, { id: 'bad', schedule: 'total nonsense' })
  seedCron(db, { id: 'good', schedule: '0 8 * * *' })
  const s = new Scheduler(deps(db))
  s.start()
  try {
    assert.equal(s.activeCount(), 1, 'the good one still loaded')
    assert.notEqual(s.problemFor('bad'), null, 'the bad one is reported, not thrown')
    assert.equal(s.problemFor('good'), null)
  } finally {
    s.stop()
  }
})

// --- no catch-up -------------------------------------------------------------

test('missedBetween counts the occurrences in the gap and nothing after now', () => {
  const tz = 'UTC'
  // A daily 08:00 job, three days of downtime.
  const since = Date.parse('2026-03-01T09:00:00Z')
  const now = Date.parse('2026-03-04T07:00:00Z')
  // 08:00 on the 2nd, 3rd -- the 4th has not happened yet at 07:00.
  assert.equal(missedBetween('0 8 * * *', tz, since, now), 2)
})

test('a downtime gap records exactly one missed row, not one per occurrence', () => {
  const db = makeDb()
  const dayAgo = Date.now() - 26 * 60 * 60 * 1000
  // Half-hourly over 26 hours: 52 occurrences passed, one row written.
  seedCron(db, { schedule: '*/30 * * * *', lastRunAt: dayAgo, createdAt: dayAgo })
  const s = new Scheduler(deps(db))
  s.start()
  s.stop()

  const rows = runsFor(db, 'c1')
  assert.equal(rows.length, 1, 'one row for the whole gap, not 52')
  assert.equal(rows[0]?.state, 'missed')
  assert.match(String(rows[0]?.error), /Not caught up on purpose/)
  // The count still has to be honest: 52 were owed, even though none are run.
  assert.match(String(rows[0]?.error), /missed 52 scheduled run/)
})

test('a gap too long to enumerate is reported as a floor, not a wrong number', () => {
  const db = makeDb()
  const dayAgo = Date.now() - 26 * 60 * 60 * 1000
  // Every minute for 26 hours is over 1500 occurrences. Counting them exactly at
  // boot would stall startup for a number nobody needs precisely.
  seedCron(db, { schedule: '* * * * *', lastRunAt: dayAgo, createdAt: dayAgo })
  const s = new Scheduler(deps(db))
  s.start()
  s.stop()
  assert.match(String(runsFor(db, 'c1')[0]?.error), /missed 100\+ scheduled run/)
})

test('restarting again does not log the same gap twice', () => {
  const db = makeDb()
  const dayAgo = Date.now() - 26 * 60 * 60 * 1000
  seedCron(db, { schedule: '0 8 * * *', lastRunAt: dayAgo, createdAt: dayAgo })

  const first = new Scheduler(deps(db))
  first.start()
  first.stop()
  const second = new Scheduler(deps(db))
  second.start()
  second.stop()

  assert.equal(runsFor(db, 'c1').length, 1, 'the second boot found no new gap')
})

test('a disabled schedule is not reported as having missed anything', () => {
  const db = makeDb()
  const dayAgo = Date.now() - 26 * 60 * 60 * 1000
  seedCron(db, { enabled: 0, schedule: '0 8 * * *', lastRunAt: dayAgo, createdAt: dayAgo })
  const s = new Scheduler(deps(db))
  s.start()
  s.stop()
  assert.equal(runsFor(db, 'c1').length, 0, 'switched off means nothing was owed')
})

// --- failure counting --------------------------------------------------------

test('consecutive failures auto-disable the schedule and say who did it', async () => {
  const db = makeDb()
  seedCron(db)
  const s = new Scheduler(
    deps(db, { runTurn: async () => outcome({ state: 'failed', error: 'gateway refused' }) }),
  )

  await s.attempt('c1')
  assert.equal(cronRow(db, 'c1').consecutiveFailures, 1)
  assert.equal(cronRow(db, 'c1').enabled, 1, 'one failure is not enough')

  await s.attempt('c1')
  await s.attempt('c1')

  const row = cronRow(db, 'c1')
  assert.equal(row.consecutiveFailures, 3)
  assert.equal(row.enabled, 0, 'disabled at the ceiling')
  // The distinction that matters: the operator must be able to tell this was not
  // their own doing, and why.
  assert.match(String(row.disabledReason), /automatically after 3 consecutive failures/)
  assert.match(String(row.disabledReason), /gateway refused/)
  assert.equal(row.lastError, 'gateway refused')
  s.stop()
})

test('a success clears the failure count and the stale error', async () => {
  const db = makeDb()
  seedCron(db, { consecutiveFailures: 2 })
  const s = new Scheduler(deps(db, { runTurn: async () => outcome() }))
  const result = await s.attempt('c1')
  assert.equal(result.ran, true)
  assert.equal(result.state, 'done')

  const row = cronRow(db, 'c1')
  assert.equal(row.consecutiveFailures, 0, 'one success resets the streak')
  assert.equal(row.lastError, null, 'the old error is not left sitting there')
  assert.equal(row.lastState, 'done')
  s.stop()
})

test('蜂群 P5.4：并发时代不再有 busy 跳过——cron 回合与任何回合一样直接跑', async () => {
  const db = makeDb()
  seedCron(db, { consecutiveFailures: 0 })
  let called = 0
  const s = new Scheduler(
    deps(db, {
      runTurn: async () => {
        called += 1
        return outcome()
      },
    }),
  )
  // 同一时刻两次 attempt（两个并发回合）：两次都真正执行，一次都不被跳过。
  const [a, b] = await Promise.all([s.attempt('c1'), s.attempt('c1')])
  assert.equal(a.ran, true)
  assert.equal(b.ran, true)
  assert.equal(called, 2)
  s.stop()
})

test('a schedule switched off between load and fire does not run', async () => {
  const db = makeDb()
  seedCron(db, { enabled: 0 })
  let called = false
  const s = new Scheduler(
    deps(db, {
      runTurn: async () => {
        called = true
        return outcome()
      },
    }),
  )
  const result = await s.attempt('c1')
  assert.equal(called, false, 'the row is re-read, not trusted from load time')
  assert.equal(result.skipped, 'disabled')
  s.stop()
})

// --- daily budget ------------------------------------------------------------

const seedUsage = (db: Db, cost: number | null): void => {
  db.insert(schema.run)
    .values({ id: `r-${Math.random()}`, agentId: 'personal', trigger: 'cron', state: 'done', startedAt: Date.now() })
    .run()
  const runId = db.select().from(schema.run).all()[0]?.id as string
  db.insert(schema.usageRecord)
    .values({
      runId,
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      inputTokens: 1000,
      outputTokens: 100,
      cacheRead: 0,
      cacheWrite: 0,
      cost,
      peakCost: 0,
      at: Date.now(),
    })
    .run()
}

test('scheduled runs stop at the daily budget, without counting as failures', async () => {
  const db = makeDb()
  seedCron(db)
  seedUsage(db, 5_000_000) // $5 spent today
  let called = false
  const s = new Scheduler(
    deps(db, {
      config: configWith({ dailyBudgetMicroUsd: 2_000_000 }), // $2 ceiling
      runTurn: async () => {
        called = true
        return outcome()
      },
    }),
  )
  const result = await s.attempt('c1')

  assert.equal(called, false, 'no gateway call was made')
  assert.equal(result.skipped, 'budget')
  assert.match(String(result.message), /daily budget/)
  // Working as configured is not a defect, so it must not creep toward the
  // auto-disable ceiling.
  assert.equal(cronRow(db, 'c1').consecutiveFailures, 0)
  assert.equal(cronRow(db, 'c1').enabled, 1)
  s.stop()
})

test('an unpriced record today blocks the budget check instead of reading as zero', async () => {
  const db = makeDb()
  seedCron(db)
  seedUsage(db, null) // tokens recorded, cost unknown
  let called = false
  const s = new Scheduler(
    deps(db, {
      config: configWith({ dailyBudgetMicroUsd: 2_000_000 }),
      runTurn: async () => {
        called = true
        return outcome()
      },
    }),
  )
  const result = await s.attempt('c1')

  // SUM(cost) skips NULL, so today would have looked free. Spending on against a
  // ceiling you cannot measure is the failure mode a budget exists to prevent.
  assert.equal(called, false)
  assert.equal(result.skipped, 'unmeasurable')
  assert.match(String(result.message), /no configured rate/)
  s.stop()
})

test('no configured budget means no ceiling, and an unpriced record changes nothing', async () => {
  const db = makeDb()
  seedCron(db)
  seedUsage(db, null)
  const s = new Scheduler(deps(db, { runTurn: async () => outcome() }))
  const result = await s.attempt('c1')
  assert.equal(result.ran, true, 'without a budget there is nothing to be unable to measure')
  s.stop()
})

test('run-now overrides both the disabled flag and the budget', async () => {
  const db = makeDb()
  seedCron(db, { enabled: 0 })
  seedUsage(db, 99_000_000)
  let called = false
  const s = new Scheduler(
    deps(db, {
      config: configWith({ dailyBudgetMicroUsd: 1_000_000 }),
      runTurn: async () => {
        called = true
        return outcome()
      },
    }),
  )
  // You asked for this one explicitly and are watching it happen; the budget
  // guards unattended spend, not your own hands.
  const result = await s.attempt('c1', true)
  assert.equal(called, true)
  assert.equal(result.ran, true)
  s.stop()
})
