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
// Debt C3: the agent builder with parameters + the two-agent test database + temp directories all moved into the test harness.
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
  _clearProbeCache() // Debt B4: a probe cache left over between tests would pollute assertions about shapes of the same id
  // Debt C3: the two-agent test database moved into the test harness.
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
  // Hive plan 2 P1: a failed probe leaves the version field null, so it raises no false alarm
  assert.equal(body.endpoints[0]!.dshVersion, null)
  assert.equal(body.endpoints[0]!.dshCompatible, null)
  // Debt D5: the manager's own version exposed (a single source of truth injected at build time)
  assert.match(body.managerVersion, /^\d+\.\d+\.\d+$/, 'managerVersion must be readable')
  await app.close()
})

test('Debt B4 regression: polling again within the TTL reuses the cached probe instead of fanning out per request', async () => {
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
  assert.equal(probes, 1, 'a second poll within the TTL must reuse the cache, not probe again (the old code fanned out per request = 2)')
  _clearProbeCache()
  await app.inject({ method: 'GET', url: '/api/status' })
  assert.equal(probes, 2, 'probing resumes once the TTL has expired')
  await app.close()
})

test('Fleet M1 pilot regression: the compatibility signal goes through the matrix -- a 0.1.5-rc.2 verified row must be compatible (the old logic === COMPAT_DSH_VERSION reported a false alarm)', async () => {
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
  assert.equal(body.endpoints[0]!.dshCompatible, true, '0.1.5-rc.2 is in a verified row of the matrix, so compatibility must be true')
  await app.close()
})
