import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import type { AppConfig } from '../config.js'
import { registerWorkspaceRoutes } from './workspace.js'

/** 债务 C2:workspace 路由(agent 工作区体检 + note-data 读取)此前零覆盖。 */

const setup = (): { app: ReturnType<typeof Fastify>; dir: string; cleanup: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), 'workspace-route-'))
  const config: AppConfig = {
    listen: { host: '127.0.0.1', port: 0 },
    endpoints: {},
    agents: { personal: { id: 'personal', name: '个人', endpoint: 'A', workspacePath: dir, public: false, preset: null, gitRemote: null, provider: null, model: null, sandboxMode: null, validate: null } },
    runner: { timeoutMs: 1_000, silenceMs: 0, maxConsecutiveFailures: 3, dailyBudgetMicroUsd: null },
    databasePath: ':memory:',
    pricing: { rates: {}, peakWindows: [] },
    sessionSecret: 'x'.repeat(32),
    initialUser: { username: 'admin', password: null },
    warnings: [],
  }
  const app = Fastify()
  registerWorkspaceRoutes(app, config, async () => undefined)
  return { app, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('债务 C2: 未知 agent 404;空工作区体检 200 且问题可见', async () => {
  const { app, cleanup } = setup()
  const missing = await app.inject({ method: 'GET', url: '/api/agents/nope/workspace' })
  assert.equal(missing.statusCode, 404)

  const ok = await app.inject({ method: 'GET', url: '/api/agents/personal/workspace' })
  assert.equal(ok.statusCode, 200)
  const body = ok.json() as {
    agent: { id: string; name: string }
    git: { isRepo: boolean; dirty: string[] }
    noteData: { present: boolean; loaded: string[]; problems: unknown[] }
    blockers: string[]
    problems: Array<{ file: string; reason: string }>
  }
  assert.equal(body.agent.id, 'personal')
  // 空目录 = 非 git 仓库:体检必须显性报告(而不是 500 或假装健康)
  assert.equal(body.git.isRepo, false)
  assert.ok(Array.isArray(body.blockers) && body.blockers.length > 0, '非 git 工作区必须有阻断项')
  assert.equal(body.noteData.present, false)

  const nd = await app.inject({ method: 'GET', url: '/api/agents/personal/notedata' })
  assert.equal(nd.statusCode, 200)
  const ndBody = nd.json() as { loaded: string[]; problems: unknown[]; violations: unknown[]; data: unknown }
  assert.deepEqual(ndBody.loaded, [], '空目录无 note-data')
  assert.deepEqual(ndBody.violations, [], '无数据无违规')
  await app.close()
  cleanup()
})

test('债务 C2: 未知 agent 的 notedata 同样 404', async () => {
  const { app, cleanup } = setup()
  const missing = await app.inject({ method: 'GET', url: '/api/agents/nope/notedata' })
  assert.equal(missing.statusCode, 404)
  await app.close()
  cleanup()
})
