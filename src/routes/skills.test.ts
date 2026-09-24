import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppConfig, ResolvedAgent } from '../config.js'
import { DEFAULT_PRICING } from '../pricing.js'
import { registerSkillsRoutes } from './skills.js'
// 债务 C3:带参 agent 构造收敛进 test-harness。
import { agentWith } from '../test-harness.js'

const agentFor = (id: string, name: string, workspacePath: string): ResolvedAgent =>
  agentWith({ id, name, workspacePath, endpoint: 'X' })

const configFor = (brainWs: string, personalWs: string): AppConfig => ({
  listen: { host: '127.0.0.1', port: 0 },
  endpoints: {},
  agents: {
    brain: agentFor('brain', '主脑', brainWs),
    personal: agentFor('personal', '个人', personalWs),
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
    writeFileSync(join(dir, 'SKILL.md'), '# 内部 API 手册\n\n给主脑用的端点手册。\n', 'utf8')
    // 没有 SKILL.md 的目录不是技能，不列出
    const stray = join(ws, '.skills', 'empty-dir')
    mkdirSync(stray, { recursive: true })
  }
  return ws
}

test('蜂群 P5.2: /api/skills lists each agent’s .skills with descriptions', async () => {
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
  assert.equal(brain?.skills[0]?.description, '内部 API 手册')
  assert.equal(brain?.skills[0]?.file, '.skills/brain-api/SKILL.md')
  // 非 git 工作区没有版本号
  assert.equal(brain?.version, null)

  const personal = body.agents.find((a: { agentId: string }) => a.agentId === 'personal')
  assert.deepEqual(personal?.skills, [])

  // 技能仓库未创建时是 null；已创建时是带版本的对象（本机 ~/.dac/skills 已建）
  const repo = body.repo as { version?: string } | null
  assert.ok(repo === null || (typeof repo === 'object' && typeof repo.version === 'string'))
  assert.ok(body.note.length > 0)
})
