import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import type { AppConfig } from '../config.js'
import { registerWorkspaceRoutes } from './workspace.js'

/** Debt C2: the workspace routes (agent workspace inspection + note-data reading) had zero coverage before. */

const setup = (): { app: ReturnType<typeof Fastify>; dir: string; cleanup: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), 'workspace-route-'))
  const config: AppConfig = {
    listen: { host: '127.0.0.1', port: 0 },
    endpoints: {},
    agents: { personal: { id: 'personal', name: 'Personal', endpoint: 'A', workspacePath: dir, public: false, preset: null, gitRemote: null, provider: null, model: null, sandboxMode: null, validate: null } },
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

test('Debt C2: an unknown agent 404s; an empty workspace inspects as 200 with its problems visible', async () => {
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
  // An empty directory = not a git repository: the inspection must report that plainly (rather than 500 or pretending to be healthy)
  assert.equal(body.git.isRepo, false)
  assert.ok(Array.isArray(body.blockers) && body.blockers.length > 0, 'a non-git workspace must have blockers')
  assert.equal(body.noteData.present, false)

  const nd = await app.inject({ method: 'GET', url: '/api/agents/personal/notedata' })
  assert.equal(nd.statusCode, 200)
  const ndBody = nd.json() as { loaded: string[]; problems: unknown[]; violations: unknown[]; data: unknown }
  assert.deepEqual(ndBody.loaded, [], 'an empty directory has no note-data')
  assert.deepEqual(ndBody.violations, [], 'no data means no violations')
  await app.close()
  cleanup()
})

test('Debt C2: notedata for an unknown agent 404s the same way', async () => {
  const { app, cleanup } = setup()
  const missing = await app.inject({ method: 'GET', url: '/api/agents/nope/notedata' })
  assert.equal(missing.statusCode, 404)
  await app.close()
  cleanup()
})
