import assert from 'node:assert/strict'
import { test } from 'node:test'
import Fastify, { type FastifyInstance } from 'fastify'
import type { AppConfig, ResolvedAgent } from '../config.js'
import type { Db } from '../db/index.js'
import { GatewayClient } from '../gateway/client.js'
import { UpstreamClient } from '../upstream/client.js'
import { FakeSessionDriver } from '../session-driver/fake.js'
import { DEFAULT_PRICING } from '../pricing.js'
import { _clearProbeCache, registerStatusRoutes } from './status.js'
// 债务 C3:带参 agent 构造 + 双 agent 测试库 + 临时目录收敛进 test-harness。
import { agentWith, makeDbWithAgents, tempDir } from '../test-harness.js'

/**
 * The agent detail aggregate.
 *
 * Two agents on one endpoint, and that endpoint deliberately dead: this is the
 * exact configuration the sidebar reports misleadingly (both dots red for one
 * broken DSH process), so it is the one the panel has to explain.
 */

const agentFor = (id: string, name: string, workspacePath: string, isPublic = false): ResolvedAgent =>
  agentWith({ id, name, workspacePath, public: isPublic })

const boot = (): { app: FastifyInstance; db: Db } => {
  _clearProbeCache() // 债务 B4:探测缓存跨测试残留会污染同 id 的不同形态断言
  // 债务 C3:双 agent 测试库收敛进 test-harness。
  const workspace = tempDir('route-status-ws')
  const db = makeDbWithAgents([
    { id: 'personal', workspacePath: workspace },
    { id: 'company', workspacePath: workspace },
  ])

  const config: AppConfig = {
    listen: { host: '127.0.0.1', port: 0 },
    // Port 1 is never listening, so health() fails the way a stopped DSH does.
    endpoints: { A: { id: 'A', url: 'http://127.0.0.1:1', driver: 'gateway', prefix: '/api-gw/v1', key: 'k', sandboxBase: null, sandboxKey: '', spawn: null, access: null } },
    agents: {
      personal: agentFor('personal', 'Personal', workspace),
      company: agentFor('company', 'Company', workspace),
    },
    runner: { timeoutMs: 10_000, silenceMs: 0, maxConsecutiveFailures: 3, dailyBudgetMicroUsd: null },
    databasePath: ':memory:',
    pricing: DEFAULT_PRICING,
    sessionSecret: 'x'.repeat(32),
    initialUser: { username: 'admin', password: null },
    warnings: ['endpoint "A" is shared by 2 agents (personal, company).'],
  }

  const app = Fastify()
  const clients = new Map([['A', new GatewayClient(config.endpoints.A!)]])
  registerStatusRoutes(app, config, db, clients, async () => undefined, new Map())
  return { app, db }
}

test('agent details name who else shares the endpoint', async () => {
  const { app } = boot()
  const response = await app.inject({ method: 'GET', url: '/api/agents/personal' })
  assert.equal(response.statusCode, 200)
  const body = response.json()

  assert.equal(body.agent.id, 'personal')
  // A dead endpoint is a reported state, not a 500: the panel exists to say why.
  assert.equal(body.endpoint.reachable, false)
  assert.ok(body.endpoint.error !== null, 'the reason the endpoint is unreachable is included')
  assert.deepEqual(
    body.sharedWith.map((a: { id: string }) => a.id),
    ['company'],
  )
  // The boot warning about a shared sandbox root has to be visible for as long
  // as it is true, not only in the log at startup.
  assert.equal(body.warnings.length, 1)
  assert.deepEqual(body.chats, { active: 0, archived: 0 })
  assert.equal(body.month.runs, 0)
  assert.deepEqual(body.runs, [])
  await app.close()
})

test('an agent that is not configured is a 404, not an empty panel', async () => {
  const { app } = boot()
  const response = await app.inject({ method: 'GET', url: '/api/agents/nope' })
  assert.equal(response.statusCode, 404)
  await app.close()
})

test('an apiproxy endpoint gets a row probed via host.describe, not /health', async () => {
  _clearProbeCache()
  const workspace = tempDir('route-status-apx-ws')
  const db = makeDbWithAgents([{ id: 'personal', workspacePath: workspace }])
  const config: AppConfig = {
    listen: { host: '127.0.0.1', port: 0 },
    // Port 1 never listens: host.describe fails, and the row must still exist.
    endpoints: { A: { id: 'A', url: 'http://127.0.0.1:1', driver: 'apiproxy', prefix: '/api', key: '', sandboxBase: null, sandboxKey: '', spawn: null, access: null } },
    agents: { personal: agentFor('personal', 'Personal', workspace) },
    runner: { timeoutMs: 10_000, silenceMs: 0, maxConsecutiveFailures: 3, dailyBudgetMicroUsd: null },
    databasePath: ':memory:',
    pricing: DEFAULT_PRICING,
    sessionSecret: 'x'.repeat(32),
    initialUser: { username: 'admin', password: null },
    warnings: [],
  }
  const app = Fastify()
  const upstream = new UpstreamClient(config.endpoints.A!)
  const upstreamClients = new Map([['A', upstream]])
  registerStatusRoutes(app, config, db, new Map(), async () => undefined, upstreamClients)

  const response = await app.inject({ method: 'GET', url: '/api/status' })
  assert.equal(response.statusCode, 200)
  const body = response.json()
  assert.equal(body.endpoints.length, 1)
  assert.equal(body.endpoints[0]!.id, 'A')
  assert.equal(body.endpoints[0]!.driver, 'apiproxy')
  assert.equal(body.endpoints[0]!.reachable, false)
  assert.ok(body.endpoints[0]!.error !== null, 'the unreachable reason is included')
  // 蜂群2计划 P1：探测失败时版本字段为 null，不产生虚假告警
  assert.equal(body.endpoints[0]!.dshVersion, null)
  assert.equal(body.endpoints[0]!.dshCompatible, null)
  // 债务 D5：manager 自身版本暴露（构建期注入的单一真相源）
  assert.match(body.managerVersion, /^\d+\.\d+\.\d+$/, 'managerVersion 必须可读')
  await app.close()
})

test('债务 B4 回归: TTL 内重复轮询复用缓存探测,不每请求扇出', async () => {
  _clearProbeCache()
  const workspace = tempDir('route-status-cache-ws')
  const db = makeDbWithAgents([{ id: 'personal', workspacePath: workspace }])
  const config: AppConfig = {
    listen: { host: '127.0.0.1', port: 0 },
    endpoints: { A: { id: 'A', url: 'http://127.0.0.1:1', driver: 'apiproxy', prefix: '/api', key: '', sandboxBase: null, sandboxKey: '', spawn: null, access: null } },
    agents: { personal: agentFor('personal', 'Personal', workspace) },
    runner: { timeoutMs: 10_000, silenceMs: 0, maxConsecutiveFailures: 3, dailyBudgetMicroUsd: null },
    databasePath: ':memory:',
    pricing: DEFAULT_PRICING,
    sessionSecret: 'x'.repeat(32),
    initialUser: { username: 'admin', password: null },
    warnings: [],
  }
  const app = Fastify()
  let probes = 0
  const fake = new FakeSessionDriver('A', { frames: [], probeVersion: '0.1.1-rc.2' })
  fake.probeVersion = async (): Promise<string> => {
    probes += 1
    return '0.1.1-rc.2'
  }
  const upstreamClients = new Map([['A', fake]])
  registerStatusRoutes(app, config, db, new Map(), async () => undefined, upstreamClients)

  await app.inject({ method: 'GET', url: '/api/status' })
  await app.inject({ method: 'GET', url: '/api/status' })
  assert.equal(probes, 1, 'TTL 内第二次轮询必须复用缓存,不得再探测(旧代码每请求扇出 = 2 次)')
  _clearProbeCache()
  await app.inject({ method: 'GET', url: '/api/status' })
  assert.equal(probes, 2, 'TTL 过期后恢复探测')
  await app.close()
})

test('舰队 M1 试点回归: 兼容性信号走矩阵——0.1.5-rc.2 verified 行必须 compatible（旧逻辑 === COMPAT_DSH_VERSION 误报）', async () => {
  _clearProbeCache()
  const workspace = tempDir('route-status-matrix-ws')
  const db = makeDbWithAgents([{ id: 'personal', workspacePath: workspace }])
  const config: AppConfig = {
    listen: { host: '127.0.0.1', port: 0 },
    endpoints: { A: { id: 'A', url: 'http://127.0.0.1:1', driver: 'apiproxy', prefix: '/api', key: '', sandboxBase: null, sandboxKey: '', spawn: null, access: null } },
    agents: { personal: agentFor('personal', 'Personal', workspace) },
    runner: { timeoutMs: 10_000, silenceMs: 0, maxConsecutiveFailures: 3, dailyBudgetMicroUsd: null },
    databasePath: ':memory:',
    pricing: DEFAULT_PRICING,
    sessionSecret: 'x'.repeat(32),
    initialUser: { username: 'admin', password: null },
    warnings: [],
  }
  const app = Fastify()
  const fake = new FakeSessionDriver('A', { frames: [], probeVersion: '0.1.5-rc.2' })
  fake.probeVersion = async (): Promise<string> => '0.1.5-rc.2'
  const upstreamClients = new Map([['A', fake]])
  registerStatusRoutes(app, config, db, new Map(), async () => undefined, upstreamClients)

  const response = await app.inject({ method: 'GET', url: '/api/status' })
  const body = response.json()
  assert.equal(body.endpoints[0]!.dshVersion, '0.1.5-rc.2')
  assert.equal(body.endpoints[0]!.dshCompatible, true, '0.1.5-rc.2 在矩阵 verified 行内，兼容性必须为 true')
  await app.close()
})
