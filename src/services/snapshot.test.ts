import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb, schema, type Db } from '../db/index.js'
import type { AppConfig, ResolvedAgent, ResolvedEndpoint } from '../config.js'
import { LOCAL_MACHINE, loadMachineFacts } from './snapshot.js'

/**
 * 负载快照：把已有四路数据拼成放置器的输入（service-model.md §4）。
 * 重点验证"缺数据"与"混放"这两类边界——它们决定放置器是允许还是拒绝一台机器。
 */
const agent = (id: string, endpoint: string, isPublic: boolean): ResolvedAgent => ({
  id,
  name: id,
  endpoint,
  workspacePath: '/w',
  public: isPublic,
  preset: null,
  sandboxMode: null,
  gitRemote: null,
  provider: null,
  model: null,
  validate: null,
})

const endpoint = (host: string | null): ResolvedEndpoint =>
  ({
    url: 'http://127.0.0.1:3080',
    driver: 'apiproxy',
    prefix: '/api',
    key: 'k',
    sandboxBase: null,
    sandboxKey: null,
    spawn: { runner: host === null ? 'process' : 'agent', host, managed: true, command: 'node', args: [], cwd: null, readyTimeoutMs: 1000, detached: false, logFile: null, env: {}, restart: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 }, docker: null },
    access: null,
  }) as unknown as ResolvedEndpoint

const config = (agents: ResolvedAgent[], endpoints: Record<string, ResolvedEndpoint>, services: AppConfig['services'] = []): AppConfig => ({
  listen: { host: '127.0.0.1', port: 8080 },
  endpoints,
  agents: Object.fromEntries(agents.map((a) => [a.id, a])),
  services,
  runner: { timeoutMs: 1000, silenceMs: 0, maxConsecutiveFailures: 3, dailyBudgetMicroUsd: null },
  databasePath: ':memory:',
  pricing: { rates: {}, peakWindows: [] },
  sessionSecret: 'x'.repeat(32),
  initialUser: { username: 'admin', password: null },
  warnings: [],
})

const addMachine = (db: Db, id: string, lastSeenAt: number | null, revoked = false): void => {
  db.insert(schema.agentMachine)
    .values({ id, hostname: id, os: 'linux', arch: 'x64', nodeVersion: '22', tokenHash: 'h', joinedAt: 0, lastSeenAt, revokedAt: revoked ? 1 : null, prevTokenHash: null, prevSetAt: null, agentVersion: null })
    .run()
}

const addMetric = (db: Db, agentId: string, at: number, cpuPercent: number, memTotal: number, memUsed: number, diskFree: number): void => {
  db.insert(schema.agentMetric)
    .values({ agentId, at, cpuPercent, memTotal, memUsed, diskTotal: 100_000_000_000, diskFree, uptime: 1, platform: 'linux' })
    .run()
}

test('单机自装: 本机永远是 online、指标缺失、对内 agent 标记为真', () => {
  const { db } = openDb(':memory:')
  const cfg = config([agent('personal', 'A', false)], { A: endpoint(null) })
  const facts = loadMachineFacts({ db, config: cfg })
  assert.equal(facts.length, 1)
  assert.equal(facts[0]?.id, LOCAL_MACHINE)
  assert.equal(facts[0]?.online, true, 'manager 在跑即本机在线')
  assert.equal(facts[0]?.cpuFreePercent, undefined, '本机没有 agent_metric → 指标缺失，不是 0')
  assert.equal(facts[0]?.hasPrivateAgents, true)
  assert.equal(facts[0]?.agentCount, 1)
})

test('agent 机器: 在线看心跳新鲜度；指标取最新一行并反算空闲', () => {
  const { db } = openDb(':memory:')
  const now = 1_800_000_000_000
  const cfg = config(
    [agent('w1', 'R', true), agent('w2', 'DEAD', true)],
    { R: endpoint('agent-alive'), DEAD: endpoint('agent-stale') },
  )
  addMachine(db, 'agent-alive', now - 5_000)
  addMachine(db, 'agent-stale', now - 10 * 60_000)
  addMetric(db, 'agent-alive', now - 1_000, 125, 16_000_000_000, 4_000_000_000, 50_000_000_000) // 12.5% 忙
  addMetric(db, 'agent-alive', now - 90_000, 900, 16_000_000_000, 15_000_000_000, 1_000_000_000) // 更旧的一行，必须被忽略

  const facts = loadMachineFacts({ db, config: cfg, now })
  const alive = facts.find((f) => f.id === 'agent-alive')
  const stale = facts.find((f) => f.id === 'agent-stale')
  assert.equal(alive?.online, true)
  assert.equal(alive?.cpuFreePercent, 87.5, '忙 12.5% → 空闲 87.5%')
  assert.equal(alive?.memFreeBytes, 12_000_000_000, '空闲内存 = 总量 − 已用')
  assert.equal(alive?.diskFreeBytes, 50_000_000_000)
  assert.equal(stale?.online, false, '心跳过期 → 离线（放置器会一票否决）')
  assert.equal(stale?.cpuFreePercent, undefined, '没有指标行 → 缺失')
})

test('会话数按 agent 归属到机器，已归档的不算', () => {
  const { db } = openDb(':memory:')
  const cfg = config(
    [agent('w1', 'R', true), agent('w2', 'R', true)],
    { R: endpoint('agent-1') },
  )
  addMachine(db, 'agent-1', Date.now())
  db.insert(schema.agent).values({ id: 'w1', name: 'w1', workspacePath: '/w', endpoint: 'R', preset: null, gitRemote: null, public: 1, createdAt: 0 }).run()
  db.insert(schema.agent).values({ id: 'w2', name: 'w2', workspacePath: '/w', endpoint: 'R', preset: null, gitRemote: null, public: 1, createdAt: 0 }).run()
  const chat = (id: string, agentId: string, removedAt: number | null): void => {
    db.insert(schema.chat).values({ id, agentId, dshSessionId: null, title: null, createdAt: 0, lastActiveAt: 0, removedAt, accessModeOverride: null, accessMode: null }).run()
  }
  chat('c1', 'w1', null)
  chat('c2', 'w2', null)
  chat('c3', 'w1', 1) // 已归档

  const facts = loadMachineFacts({ db, config: cfg })
  assert.equal(facts[0]?.sessions, 2, '只数未归档会话')
  assert.equal(facts[0]?.agentCount, 2)
})

test('混放检测: 同机上有别的服务的 agent → services 列出两个（放置器据此一票否决）', () => {
  const { db } = openDb(':memory:')
  const service = (id: string, workers: string[]) => ({
    id,
    label: id,
    workers,
    surfaces: ['tasks'] as Array<'tasks' | 'conversations'>,
    knowledge: [],
  })
  const cfg = config(
    [agent('w1', 'R', true), agent('w2', 'R', true)],
    { R: endpoint('agent-1') },
    [service('support', ['w1']), service('report', ['w2'])],
  )
  const facts = loadMachineFacts({ db, config: cfg })
  assert.deepEqual(facts[0]?.services.sort(), ['report', 'support'], '两个服务挤一台机器 → 快照如实反映')
  assert.equal(facts[0]?.hasPrivateAgents, false, '全是对外 agent')
})
