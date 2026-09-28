import { test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { openDb, schema, type Db } from '../db/index.js'
import { mintApiKey, type ApiKey } from '../auth/api-key.js'
import { activeRunsForKey, checkRunQuota, runsUsedToday, startOfLocalDay } from './quota.js'

/**
 * Daily quota and concurrency counting (design doc manager/topics/public-api.md §5).
 *
 * Stated convention: **the day boundary = the manager host's local day**, exactly matching the spend page
 * (`strftime(..., 'localtime')`, `dayRangeMs`) -- if the quota used another time zone, the "how much have I used
 * today" figure in the UI would not agree with whether you get blocked, which costs far more to debug than the theoretical purity is worth.
 *
 * Fixtures use real key rows: `run.api_key_id` has a foreign key, and the test incidentally pins down "spend must hang off a real key".
 */
const db = (): Db => {
  const d = openDb(':memory:').db
  // run.agent_id has a foreign key to agent(id): the fixture incidentally pins down "work must hang off a real agent".
  d.insert(schema.agent)
    .values({ id: 'worker-1', name: 'worker-1', workspacePath: '.', endpoint: 'A', preset: null, gitRemote: null, public: 0, createdAt: Date.now() })
    .run()
  return d
}

const mint = (d: Db, name: string, quotaRunsDay: number | null = null): ApiKey =>
  mintApiKey(d, { name, scopes: ['tasks:write'], scopeServices: ['*'], quotaRunsDay, createdBy: 'admin' }).key

const addRun = (d: Db, id: string, apiKeyId: string | null, startedAt: number, state = 'done'): void => {
  d.insert(schema.run)
    .values({
      id,
      agentId: 'worker-1',
      apiKeyId,
      chatId: null,
      sourceChatId: null,
      conflict: null,
      cronId: null,
      dshSessionId: null,
      trigger: 'api',
      idempotencyKey: null,
      state,
      resultSummary: null,
      startedAt,
      endedAt: null,
      error: null,
      commitHash: null,
    })
    .run()
}

test('day boundary = the host local midnight', () => {
  const noon = new Date(2026, 8, 27, 12, 30, 0).getTime() // 2026-09-27 12:30 local
  const start = startOfLocalDay(noon)
  assert.equal(new Date(start).getHours(), 0)
  assert.equal(new Date(start).getDate(), 27)
  assert.ok(start <= noon)
  assert.ok(start + 86_400_000 > noon)
})

test('daily quota counting: only runs of this key from today onward count (cross-day, other keys and nameless keys do not)', () => {
  const d = db()
  const now = new Date(2026, 8, 27, 12, 0, 0).getTime()
  const midnight = startOfLocalDay(now)
  const k1 = mint(d, 'k1')
  const k2 = mint(d, 'k2')

  addRun(d, 'r-today-1', k1.id, midnight + 1000)
  addRun(d, 'r-today-2', k1.id, now)
  addRun(d, 'r-yesterday', k1.id, midnight - 1) // the last millisecond of yesterday
  addRun(d, 'r-other-key', k2.id, now)
  addRun(d, 'r-no-key', null, now)

  assert.equal(runsUsedToday(d, k1.id, now), 2)
  assert.equal(runsUsedToday(d, k2.id, now), 1)
})

test('quota verdict: unlimited / under / over, and an overrun reports the reset time', () => {
  const d = db()
  const now = new Date(2026, 8, 27, 12, 0, 0).getTime()

  const unlimited = checkRunQuota(d, mint(d, 'unlimited', null), now)
  assert.equal(unlimited.ok, true)
  if (unlimited.ok) {
    assert.equal(unlimited.limit, null)
    assert.equal(unlimited.remaining, null)
  }

  const capped = mint(d, 'capped', 3)
  addRun(d, 'a', capped.id, now - 1000)
  addRun(d, 'b', capped.id, now - 2000)
  const under = checkRunQuota(d, capped, now)
  assert.equal(under.ok, true)
  if (under.ok) assert.equal(under.remaining, 1)

  addRun(d, 'c', capped.id, now - 3000)
  const over = checkRunQuota(d, capped, now)
  assert.equal(over.ok, false)
  if (!over.ok && over.reason === 'quota_exceeded') {
    assert.equal(over.used, 3)
    assert.equal(over.limit, 3)
    assert.equal(over.resetsAt, startOfLocalDay(now) + 86_400_000, 'the reset time = the next local midnight')
    assert.ok(over.resetsAt > now)
  } else {
    assert.fail(`expected quota_exceeded, got ${JSON.stringify(over)}`)
  }
})

test('concurrency ceiling: rejected once running work fills it up (terminal states do not hold a slot)', () => {
  const d = db()
  const now = Date.now()
  const k = mint(d, 'busy')
  assert.equal(k.maxConcurrency, 4, 'default concurrency is 4')

  addRun(d, 'p1', k.id, now, 'pending')
  addRun(d, 'p2', k.id, now, 'running')
  assert.equal(activeRunsForKey(d, k.id), 2)
  assert.equal(checkRunQuota(d, k, now).ok, true, 'there is still room')

  addRun(d, 'p3', k.id, now, 'running')
  addRun(d, 'p4', k.id, now, 'pending')
  const full = checkRunQuota(d, k, now)
  assert.equal(full.ok, false)
  if (!full.ok && full.reason === 'concurrency_exceeded') {
    assert.equal(full.active, 4)
    assert.equal(full.limit, 4)
  } else {
    assert.fail(`expected concurrency_exceeded, got ${JSON.stringify(full)}`)
  }

  // a terminal state frees the slot
  d.update(schema.run).set({ state: 'done' }).where(eq(schema.run.id, 'p1')).run()
  assert.equal(activeRunsForKey(d, k.id), 3)
  assert.equal(checkRunQuota(d, k, now).ok, true)
})
