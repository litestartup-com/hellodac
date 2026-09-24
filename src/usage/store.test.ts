import assert from 'node:assert/strict'
import { test } from 'node:test'
import { schema, type Db } from '../db/index.js'
import { currentMonth, monthByAgent, monthByDay, monthByModel, monthTotals, spendMonths } from './store.js'
// 债务 C3:双 agent 测试库收敛进 test-harness。
import { makeDbWithAgents } from '../test-harness.js'

const makeDb = (): Db => makeDbWithAgents([{ id: 'personal' }, { id: 'company' }])

/** Local time, because the month buckets are local. */
const at = (y: number, m: number, d: number, h = 12): number => new Date(y, m - 1, d, h).getTime()

let runSeq = 0
const record = (
  db: Db,
  opts: { agentId: string; at: number; cost: number | null; peakCost?: number | null; model?: string; input?: number; output?: number },
): void => {
  runSeq += 1
  const runId = `run-${runSeq}`
  db.insert(schema.run)
    .values({
      id: runId,
      agentId: opts.agentId,
      chatId: null,
      cronId: null,
      dshSessionId: null,
      trigger: 'manual',
      idempotencyKey: null,
      state: 'done',
      resultSummary: null,
      startedAt: opts.at,
      endedAt: opts.at,
      error: null,
    })
    .run()
  db.insert(schema.usageRecord)
    .values({
      runId,
      provider: 'deepseek-official',
      model: opts.model ?? 'deepseek-v4-pro',
      inputTokens: opts.input ?? 1000,
      outputTokens: opts.output ?? 100,
      cacheRead: null,
      cacheWrite: null,
      reasoningTokens: null,
      cost: opts.cost,
      peakCost: opts.peakCost ?? 0,
      at: opts.at,
    })
    .run()
}

const MONTH = '2026-08'

test('an unpriced run contributes tokens but is never counted as zero cost', () => {
  const db = makeDb()
  record(db, { agentId: 'personal', at: at(2026, 8, 3), cost: 1_000_000, input: 500 })
  record(db, { agentId: 'personal', at: at(2026, 8, 4), cost: null, model: 'unreleased', input: 700 })

  const totals = monthTotals(db, MONTH)
  assert.equal(totals.costMicroUsd, 1_000_000, 'the known cost, not diluted by the unknown one')
  assert.equal(totals.unpriced, 1, 'and the gap is reported rather than hidden')
  assert.equal(totals.inputTokens, 1200, 'tokens are counted either way')
  assert.equal(totals.runs, 2)
})

test('spend is attributed to the agent that ran it', () => {
  // usage_record only knows its run, so the agent comes through a join. Both
  // tables have an `id`, which is exactly the shape that silently returns the
  // wrong rows when a column is left unqualified.
  const db = makeDb()
  record(db, { agentId: 'personal', at: at(2026, 8, 3), cost: 300 })
  record(db, { agentId: 'personal', at: at(2026, 8, 4), cost: 200 })
  record(db, { agentId: 'company', at: at(2026, 8, 5), cost: 700 })

  const rows = monthByAgent(db, MONTH)
  assert.equal(rows.length, 2)
  // Ordered by cost, so company leads.
  assert.equal(rows[0]?.agentId, 'company')
  assert.equal(rows[0]?.costMicroUsd, 700)
  assert.equal(rows[0]?.runs, 1)
  assert.equal(rows[1]?.agentId, 'personal')
  assert.equal(rows[1]?.costMicroUsd, 500)
  assert.equal(rows[1]?.runs, 2)
})

test('the peak share is carried through the totals', () => {
  const db = makeDb()
  record(db, { agentId: 'personal', at: at(2026, 8, 3), cost: 1000, peakCost: 1000 })
  record(db, { agentId: 'personal', at: at(2026, 8, 4), cost: 1000, peakCost: 0 })

  const totals = monthTotals(db, MONTH)
  assert.equal(totals.costMicroUsd, 2000)
  assert.equal(totals.peakCostMicroUsd, 1000, 'half the spend was at the peak rate')
})

test('models are grouped so an unpriced one can be named', () => {
  const db = makeDb()
  record(db, { agentId: 'personal', at: at(2026, 8, 3), cost: 500 })
  record(db, { agentId: 'personal', at: at(2026, 8, 4), cost: null, model: 'unreleased' })

  const rows = monthByModel(db, MONTH)
  assert.equal(rows.length, 2)
  const unpriced = rows.find((r) => r.model === 'unreleased')
  assert.equal(unpriced?.unpriced, 1)
  assert.equal(unpriced?.costMicroUsd, 0, 'no money is claimed for it')
})

test('other months are excluded and listed separately', () => {
  const db = makeDb()
  record(db, { agentId: 'personal', at: at(2026, 8, 3), cost: 100 })
  record(db, { agentId: 'personal', at: at(2026, 7, 30), cost: 900 })

  assert.equal(monthTotals(db, MONTH).costMicroUsd, 100)
  assert.equal(monthTotals(db, '2026-07').costMicroUsd, 900)
  assert.deepEqual(spendMonths(db), ['2026-08', '2026-07'])
})

test('days are bucketed in local time, so a late evening run stays on its own date', () => {
  const db = makeDb()
  record(db, { agentId: 'personal', at: at(2026, 8, 3, 23), cost: 100 })
  record(db, { agentId: 'personal', at: at(2026, 8, 4, 1), cost: 200 })

  const days = monthByDay(db, MONTH)
  assert.deepEqual(
    days.map((d) => [d.day, d.costMicroUsd]),
    [
      ['2026-08-03', 100],
      ['2026-08-04', 200],
    ],
  )
})

test('the current month matches the bucket format', () => {
  assert.equal(currentMonth(new Date(2026, 7, 30).getTime()), '2026-08')
  assert.match(currentMonth(), /^\d{4}-\d{2}$/)
})
