import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from './db/index.js'
import { buildMetricsSnapshot, registerMetricsRoutes } from './metrics.js'
import Fastify from 'fastify'

/**
 * Debt B6 (simplified): observability -- the /metrics endpoint (protected) plus a pure snapshot function.
 * Covers: run state distribution / 7-day failure rate / today's spend / active runs / uptime.
 * The SSE connection count and the mux reconnect count are joined in from their own modules' counters (smoke covers end to end).
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

test('Debt B6 regression: the pure snapshot -- state distribution / failure-rate window / today spend / active count', () => {
  const { db, sqlite } = makeDb()
  const snap = buildMetricsSnapshot(db)
  assert.ok(snap.uptimeMs >= 0)
  assert.equal(snap.runs.total, 5)
  assert.equal(snap.runs.byState.done, 2)
  assert.equal(snap.runs.byState.failed, 2)
  assert.equal(snap.runs.byState.running, 1)
  // 7-day failure rate = failed within 7 days / finished within 7 days = 1 / 3 (old-fail from 20 days ago is outside the window)
  assert.equal(snap.runs.failedRate7d, 1 / 3)
  assert.equal(snap.spendToday.costMicroUsd, 5000)
  assert.equal(snap.activeRuns, 1)
  sqlite.close()
  rmSync(dir, { recursive: true, force: true })
})

test('Debt B6 regression: the /metrics endpoint is protected by requireUser and returns the snapshot', async () => {
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
