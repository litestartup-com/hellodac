import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import type { AppConfig } from '../config.js'
import { openDb, type Db } from '../db/index.js'
import { DEFAULT_PRICING } from '../pricing.js'
import { registerUsageRoutes } from './usage.js'

/**
 * 债务 C2:usage 路由此前零覆盖。覆盖:默认月/指定月/非法月 400/
 * byModel 的 rateConfigured 标志/byAgent 名称兜底/peak 窗口映射。
 */

const setup = (): { dir: string; db: Db; app: ReturnType<typeof Fastify>; cleanup: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-route-'))
  const dbPath = join(dir, 'test.db')
  const { db, sqlite } = openDb(dbPath)
  sqlite.prepare(`INSERT INTO agent (id, name, workspace_path, endpoint, public, created_at) VALUES ('personal', '个人', '.', 'A', 0, 1)`).run()
  sqlite.prepare(`INSERT INTO run (id, agent_id, trigger, state, started_at) VALUES ('r1', 'personal', 'manual', 'done', 1)`).run()
  sqlite
    .prepare(
      `INSERT INTO usage_record (run_id, provider, model, input_tokens, output_tokens, cost, at)
       VALUES ('r1', 'p', 'deepseek-v4-flash', 100, 200, 1000, ${Date.now()})`,
    )
    .run()
  const config: AppConfig = {
    listen: { host: '127.0.0.1', port: 0 },
    endpoints: {},
    agents: { personal: { id: 'personal', name: '个人', endpoint: 'A', workspacePath: dir, public: false, preset: null, gitRemote: null, provider: null, model: null, sandboxMode: null, validate: null } },
    runner: { timeoutMs: 1_000, silenceMs: 0, maxConsecutiveFailures: 3, dailyBudgetMicroUsd: null },
    databasePath: dbPath,
    pricing: DEFAULT_PRICING,
    sessionSecret: 'x'.repeat(32),
    initialUser: { username: 'admin', password: null },
    warnings: [],
  }
  const app = Fastify()
  registerUsageRoutes(app, config, db, async () => undefined)
  const cleanup = (): void => {
    sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  }
  return { dir, db, app, cleanup }
}

test('债务 C2: /api/usage 返回月账结构,非法月 400', async () => {
  const { app, cleanup } = setup()
  const ok = await app.inject({ method: 'GET', url: '/api/usage' })
  assert.equal(ok.statusCode, 200)
  const body = ok.json() as {
    month: string
    months: string[]
    totals: { runs: number; costMicroUsd: number }
    byAgent: Array<{ agentId: string; name: string }>
    byModel: Array<{ model: string | null; rateConfigured: boolean }>
    byDay: unknown[]
    peakWindowsUtc: Array<{ start: string; end: string }>
  }
  assert.match(body.month, /^\d{4}-\d{2}$/)
  assert.ok(body.months.length >= 1)
  assert.equal(body.totals.runs, 1)
  assert.equal(body.totals.costMicroUsd, 1000)
  assert.deepEqual(body.byAgent.map((a) => a.name), ['个人'], 'agent 名从 config 兜底')
  const flash = body.byModel.find((m) => m.model === 'deepseek-v4-flash')
  assert.ok(flash !== undefined && flash.rateConfigured, '默认价格表里 flash 已配置')
  assert.equal(body.byDay.length, 1)
  assert.equal(body.peakWindowsUtc.length, DEFAULT_PRICING.peakWindows.length)

  const bad = await app.inject({ method: 'GET', url: '/api/usage?month=2026-9' })
  assert.equal(bad.statusCode, 400)
  const badBody = bad.json() as { error: string }
  assert.equal(badBody.error, 'invalid_month')

  await app.close()
  cleanup()
})

test('债务 C2: 指定历史月返回该月(无数据 = 零)', async () => {
  const { app, cleanup } = setup()
  const res = await app.inject({ method: 'GET', url: '/api/usage?month=2020-01' })
  assert.equal(res.statusCode, 200)
  const body = res.json() as { month: string; totals: { runs: number } }
  assert.equal(body.month, '2020-01')
  assert.equal(body.totals.runs, 0)
  await app.close()
  cleanup()
})
