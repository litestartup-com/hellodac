import { test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { openDb, schema, type Db } from '../db/index.js'
import { mintApiKey, type ApiKey } from '../auth/api-key.js'
import { activeRunsForKey, checkRunQuota, runsUsedToday, startOfLocalDay } from './quota.js'

/**
 * 日配额与并发计数（设计稿 manager/topics/public-api.md §5）。
 *
 * 口径声明：**日界线 = manager 主机本地日**，与花费页（`strftime(..., 'localtime')`、
 * `dayRangeMs`）完全一致——配额若用另一个时区，界面显示的"今天用了多少"就会和
 * 拦不拦你对不上，排障成本远大于那点理论纯洁性。
 *
 * 夹具用真钥匙行：`run.api_key_id` 有外键，测试也顺带钉住"账目必须挂在真钥匙上"。
 */
const db = (): Db => {
  const d = openDb(':memory:').db
  // run.agent_id 有外键指向 agent(id)：夹具也顺带钉住"活必须挂在真 agent 上"。
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

test('日界线 = 主机本地日零点', () => {
  const noon = new Date(2026, 8, 27, 12, 30, 0).getTime() // 2026-09-27 12:30 本地
  const start = startOfLocalDay(noon)
  assert.equal(new Date(start).getHours(), 0)
  assert.equal(new Date(start).getDate(), 27)
  assert.ok(start <= noon)
  assert.ok(start + 86_400_000 > noon)
})

test('日配额计数: 只数本钥匙、本日之后的 run（跨日/他人/无名钥匙都不算）', () => {
  const d = db()
  const now = new Date(2026, 8, 27, 12, 0, 0).getTime()
  const midnight = startOfLocalDay(now)
  const k1 = mint(d, 'k1')
  const k2 = mint(d, 'k2')

  addRun(d, 'r-today-1', k1.id, midnight + 1000)
  addRun(d, 'r-today-2', k1.id, now)
  addRun(d, 'r-yesterday', k1.id, midnight - 1) // 昨天最后一毫秒
  addRun(d, 'r-other-key', k2.id, now)
  addRun(d, 'r-no-key', null, now)

  assert.equal(runsUsedToday(d, k1.id, now), 2)
  assert.equal(runsUsedToday(d, k2.id, now), 1)
})

test('配额判定: 不限 / 未超 / 已超 三态，超限给出重置时刻', () => {
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
    assert.equal(over.resetsAt, startOfLocalDay(now) + 86_400_000, '重置时刻 = 下一个本地零点')
    assert.ok(over.resetsAt > now)
  } else {
    assert.fail(`期望 quota_exceeded，实际 ${JSON.stringify(over)}`)
  }
})

test('并发上限: 在跑的活占满即拒（终态不占）', () => {
  const d = db()
  const now = Date.now()
  const k = mint(d, 'busy')
  assert.equal(k.maxConcurrency, 4, '默认并发 4')

  addRun(d, 'p1', k.id, now, 'pending')
  addRun(d, 'p2', k.id, now, 'running')
  assert.equal(activeRunsForKey(d, k.id), 2)
  assert.equal(checkRunQuota(d, k, now).ok, true, '还有余量')

  addRun(d, 'p3', k.id, now, 'running')
  addRun(d, 'p4', k.id, now, 'pending')
  const full = checkRunQuota(d, k, now)
  assert.equal(full.ok, false)
  if (!full.ok && full.reason === 'concurrency_exceeded') {
    assert.equal(full.active, 4)
    assert.equal(full.limit, 4)
  } else {
    assert.fail(`期望 concurrency_exceeded，实际 ${JSON.stringify(full)}`)
  }

  // 终态释放名额
  d.update(schema.run).set({ state: 'done' }).where(eq(schema.run.id, 'p1')).run()
  assert.equal(activeRunsForKey(d, k.id), 3)
  assert.equal(checkRunQuota(d, k, now).ok, true)
})
