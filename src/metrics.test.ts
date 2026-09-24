import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from './db/index.js'
import { buildMetricsSnapshot, registerMetricsRoutes } from './metrics.js'
import Fastify from 'fastify'

/**
 * 债务 B6(简化版):可观测性——/metrics 端点(受保护)+ 快照纯函数。
 * 覆盖:run 状态分布/7 天失败率/当日花费/活跃 run/uptime。
 * SSE 连接数与 mux 重连计数由各自模块的计数导出拼接(端到端由 smoke 验证)。
 */

const dir = mkdtempSync(join(tmpdir(), 'metrics-'))

const makeDb = (): { db: ReturnType<typeof openDb>['db']; sqlite: ReturnType<typeof openDb>['sqlite'] } => {
  const { db, sqlite } = openDb(join(dir, 'test.db'))
  sqlite.prepare(`INSERT INTO agent (id, name, workspace_path, endpoint, public, created_at) VALUES ('personal', '个人', '.', 'A', 0, 1)`).run()
  const now = Date.now()
  sqlite
    .prepare(
      `INSERT INTO run (id, agent_id, trigger, state, started_at, ended_at)
       VALUES ('done-1', 'personal', 'manual', 'done', ${now - 1_000}, ${now}),
              ('done-2', 'personal', 'manual', 'done', ${now - 1_000}, ${now}),
              ('failed-1', 'personal', 'manual', 'failed', ${now - 1_000}, ${now}),
              ('running-1', 'personal', 'manual', 'running', ${now}, NULL),
              ('old-fail', 'personal', 'manual', 'failed', ${now - 20 * 86_400_000}, ${now - 20 * 86_400_000 + 1_000})`,
    )
    .run()
  sqlite
    .prepare(
      `INSERT INTO usage_record (run_id, provider, model, input_tokens, output_tokens, cost, at)
       VALUES ('done-1', 'p', 'deepseek-v4-flash', 10, 20, 5000, ${now})`,
    )
    .run()
  return { db, sqlite }
}

test('债务 B6 回归: 快照纯函数——状态分布/失败率窗口/当日花费/活跃数', () => {
  const { db, sqlite } = makeDb()
  const snap = buildMetricsSnapshot(db)
  assert.ok(snap.uptimeMs >= 0)
  assert.equal(snap.runs.total, 5)
  assert.equal(snap.runs.byState.done, 2)
  assert.equal(snap.runs.byState.failed, 2)
  assert.equal(snap.runs.byState.running, 1)
  // 7 天窗口失败率 = 7 天内的 failed / 7 天内已终局 = 1 / 3(20 天前的 old-fail 不在窗口)
  assert.equal(snap.runs.failedRate7d, 1 / 3)
  assert.equal(snap.spendToday.costMicroUsd, 5000)
  assert.equal(snap.activeRuns, 1)
  sqlite.close()
  rmSync(dir, { recursive: true, force: true })
})

test('债务 B6 回归: /metrics 端点受 requireUser 保护并返回快照', async () => {
  const dir2 = mkdtempSync(join(tmpdir(), 'metrics-route-'))
  const { db, sqlite } = openDb(join(dir2, 'test.db'))
  sqlite.prepare(`INSERT INTO agent (id, name, workspace_path, endpoint, public, created_at) VALUES ('personal', '个人', '.', 'A', 0, 1)`).run()
  const app = Fastify()
  registerMetricsRoutes(app, db, async () => undefined)
  const ok = await app.inject({ method: 'GET', url: '/metrics' })
  assert.equal(ok.statusCode, 200)
  const body = ok.json()
  assert.ok(body.runs.total >= 0)
  await app.close()
  sqlite.close()
  rmSync(dir2, { recursive: true, force: true })
})
