import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppConfig, ResolvedAgent } from '../config.js'
import { DEFAULT_PRICING } from '../pricing.js'
import { registerSkillsRoutes } from './skills.js'
// Debt C3: agent construction with arguments converges into test-harness.
import { agentWith } from '../test-harness.js'

const agentFor = (id: string, name: string, workspacePath: string): ResolvedAgent =>
  agentWith({ id, name, workspacePath, endpoint: 'X' })

const configFor = (brainWs: string, personalWs: string): AppConfig => ({
  listen: { host: '127.0.0.1', port: 0 },
  endpoints: {},
  agents: {
    brain: agentFor('brain', 'Brain', brainWs),
    personal: agentFor('personal', 'Personal', personalWs),
  },
  runner: { timeoutMs: 1_000, silenceMs: 0, maxConsecutiveFailures: 3, dailyBudgetMicroUsd: null },
  databasePath: ':memory:',
  pricing: DEFAULT_PRICING,
  sessionSecret: 'x'.repeat(32),
  initialUser: { username: 'admin', password: null },
  warnings: [],
})

const fixture = (withSkill: boolean): string => {
  const ws = mkdtempSync(join(tmpdir(), 'skills-ws-'))
  if (withSkill) {
    const dir = join(ws, '.skills', 'brain-api')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '# Internal API manual\n\nEndpoint manual for the brain.\n', 'utf8')
    // A directory without SKILL.md is not a skill and is not listed
    const stray = join(ws, '.skills', 'empty-dir')
    mkdirSync(stray, { recursive: true })
  }
  return ws
}

test('Hive P5.2: /api/skills lists each agent’s .skills with descriptions', async () => {
  const brainWs = fixture(true)
  const personalWs = fixture(false)
  const app = Fastify()
  registerSkillsRoutes(app, configFor(brainWs, personalWs), async () => {})

  const res = await app.inject({ method: 'GET', url: '/api/skills' })
  assert.equal(res.statusCode, 200)
  const body = res.json()

  const brain = body.agents.find((a: { agentId: string }) => a.agentId === 'brain')
  assert.equal(brain?.skills.length, 1)
  assert.equal(brain?.skills[0]?.name, 'brain-api')
  assert.equal(brain?.skills[0]?.description, 'Internal API manual')
  assert.equal(brain?.skills[0]?.file, '.skills/brain-api/SKILL.md')
  // A non-git workspace has no version
  assert.equal(brain?.version, null)

  const personal = body.agents.find((a: { agentId: string }) => a.agentId === 'personal')
  assert.deepEqual(personal?.skills, [])

  // null while the skills repo does not exist, a versioned object once it does (built on this machine)
  const repo = body.repo as { version?: string } | null
  assert.ok(repo === null || (typeof repo === 'object' && typeof repo.version === 'string'))
  assert.ok(body.note.length > 0)
})
