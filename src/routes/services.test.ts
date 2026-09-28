import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { mintApiKey } from '../auth/api-key.js'
import type { AppConfig, ResolvedEndpoint } from '../config.js'
import { schema, type Db } from '../db/index.js'
import { makeDbWithAgents, agentWith } from '../test-harness.js'
import { registerServiceRoutes, serviceRows } from './services.js'

/**
 * The outward-service overview (P2.5). What the operator has to be able to trust here is that the page
 * agrees with the dispatcher: the same liveness opinion, the same definition of load, and the same
 * quota counter -- a second opinion that drifts is worse than no page.
 */

/**
 * A hand-built endpoint: only the machine matters to this route (`spawn.host` is the machine id
 * placement uses), so the rest of ResolvedSpawnSpec is a stand-in. Typed as the real shape so the
 * fixture cannot drift away from `ResolvedEndpoint`.
 */
const ENDPOINT: ResolvedEndpoint = {
  id: 'svc-1',
  url: 'http://127.0.0.1:3201',
  driver: 'apiproxy',
  prefix: '/api-gw/v1/proxy',
  key: '',
  sandboxBase: null,
  sandboxKey: '',
  spawn: {
    managed: false,
    command: 'node',
    args: [],
    cwd: null,
    readyTimeoutMs: 30_000,
    detached: false,
    logFile: null,
    env: {},
    restart: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    runner: 'agent',
    host: 'box-1',
    docker: null,
  },
  access: null,
}
const SERVICE = {
  id: 'chat',
  label: 'Support',
  workers: ['svc-1'],
  surfaces: ['conversations'] as Array<'tasks' | 'conversations'>,
  knowledge: [{ host: '/srv/manual', mount: '/knowledge', readOnly: true }],
  count: 1,
  maxSessionsPerAgent: 4,
  permission: 'read' as const,
  sessionIdleHours: 24,
  placement: 'pin' as const,
  machines: ['box-1'],
  maxAgentsPerMachine: 4,
}

const config = (over: Partial<AppConfig> = {}): AppConfig => {
  const base = {
    listen: { host: '127.0.0.1', port: 8080 },
    endpoints: { 'svc-1': ENDPOINT },
    agents: {
      'svc-1': {
        ...agentWith({ id: 'svc-1', name: 'Support 1', workspacePath: '/srv/ws', endpoint: 'svc-1', public: true, sandboxMode: 'read-only' }),
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
      },
    },
    services: [SERVICE],
    runner: { timeoutMs: 1_000, silenceMs: 0, maxConsecutiveFailures: 3, dailyBudgetMicroUsd: null },
    databasePath: ':memory:',
    pricing: { rates: {}, peakWindows: [] },
    sessionSecret: 'x'.repeat(32),
    initialUser: { username: 'admin', password: null },
    warnings: [],
    ...over,
  }
  // One cast at the boundary: the fixture varies `services`/`agents`, and spelling out every derived
  // field of AppConfig in a test would be a second definition of the loader's output.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  return base as unknown as AppConfig
}

const chat = (db: Db, id: string, agentId: string, removedAt: number | null = null): void => {
  db.insert(schema.chat)
    .values({ id, agentId, dshSessionId: null, title: null, createdAt: 0, lastActiveAt: 0, removedAt, accessModeOverride: null, accessMode: null })
    .run()
}

const run = (db: Db, id: string, agentId: string, state: string, apiKeyId: string | null = null, startedAt = Date.now()): void => {
  db.insert(schema.run).values({ id, agentId, apiKeyId, chatId: null, sourceChatId: null, conflict: null, cronId: null, dshSessionId: null, trigger: 'api', idempotencyKey: null, state, resultSummary: null, startedAt, endedAt: null, error: null, commitHash: null }).run()
}

test('service overview: live conversations and queued turns are reported per agent, archived ones are not counted', () => {
  const db = makeDbWithAgents([{ id: 'svc-1' }])
  chat(db, 'live-1', 'svc-1')
  chat(db, 'live-2', 'svc-1')
  chat(db, 'archived', 'svc-1', Date.now())
  run(db, 'queued', 'svc-1', 'running')
  run(db, 'finished', 'svc-1', 'done')

  const [row] = serviceRows({ db, config: config(), isOnline: () => true })

  assert.equal(row?.agents[0]?.sessions, 2, 'an archived conversation does not hold a slot (the idle reclaim must show up here)')
  assert.equal(row?.agents[0]?.queueDepth, 1, 'only unfinished turns are queue depth')
  assert.equal(row?.capacity.inUse, 2)
  assert.equal(row?.capacity.queued, 1)
})

test('service overview: capacity is what the service promises, and the reachable part is stated separately', () => {
  const db = makeDbWithAgents([{ id: 'svc-1' }, { id: 'svc-2' }])
  const second = { ...(config().agents['svc-1'] as AppConfig['agents'][string]), id: 'svc-2', name: 'Support 2', endpoint: 'svc-2' }
  const cfg = config({
    endpoints: { ...config().endpoints, 'svc-2': { ...ENDPOINT, id: 'svc-2', url: 'http://127.0.0.1:3202' } },
    agents: { ...config().agents, 'svc-2': second },
    services: [{ ...SERVICE, workers: ['svc-1', 'svc-2'], count: 2 }],
  })
  // One agent reachable, the other not: the service promised 8 concurrent conversations, 4 are
  // actually reachable. Both numbers belong on the page -- "8" alone would be a promise nobody keeps.
  const [row] = serviceRows({ db, config: cfg, isOnline: (agentId) => agentId === 'svc-1' })

  assert.equal(row?.capacity.maxConcurrent, 8)
  assert.equal(row?.capacity.onlineMaxConcurrent, 4)
  assert.equal(row?.capacity.onlineAgents, 1)
  assert.equal(row?.capacity.declaredAgents, 2)
  assert.equal(row?.agents[1]?.online, false)
})

test('service overview: today\'s usage is counted per key, and a revoked key stays listed and attributable', () => {
  const db = makeDbWithAgents([{ id: 'svc-1' }])
  const { key: live } = mintApiKey(db, { name: 'Acme window', scopes: ['conversations:write'], scopeServices: ['chat'], createdBy: 'admin' })
  const { key: revoked } = mintApiKey(db, { name: 'Old window', scopes: ['conversations:write'], scopeServices: ['chat'], createdBy: 'admin' })
  const { key: otherService } = mintApiKey(db, { name: 'Reports', scopes: ['tasks:write'], scopeServices: ['report'], createdBy: 'admin' })

  run(db, 'today-1', 'svc-1', 'done', live.id)
  run(db, 'today-2', 'svc-1', 'running', live.id)
  run(db, 'yesterday', 'svc-1', 'done', live.id, Date.now() - 48 * 3_600_000)
  run(db, 'revoked-today', 'svc-1', 'done', revoked.id)
  run(db, 'other-service', 'svc-1', 'done', otherService.id)

  const [row] = serviceRows({ db, config: config(), isOnline: () => true })
  const liveRow = row?.keys.find((key) => key.id === live.id)
  assert.equal(liveRow?.usedToday, 2, 'only today\'s runs count, and only this key\'s')
  assert.equal(liveRow?.active, 1, 'the in-flight count is what the concurrency cap acts on')
  assert.ok(row?.keys.some((key) => key.id === revoked.id), 'a revoked key keeps its history on the page (money spent stays attributable)')
  assert.ok(!row?.keys.some((key) => key.id === otherService.id), 'a key scoped to another service is not listed here')
})

test('service overview: a worker missing from agents: is reported as missing, never as an invented row', () => {
  const db = makeDbWithAgents([{ id: 'svc-1' }])
  const cfg = config({ services: [{ ...SERVICE, workers: ['svc-1', 'ghost'] }] })

  const [row] = serviceRows({ db, config: cfg, isOnline: () => true })
  const ghost = row?.agents.find((agent) => agent.id === 'ghost')
  assert.ok(ghost !== undefined, 'the declared worker still gets a row')
  assert.equal(ghost?.online, false)
  assert.match(ghost?.endpoint ?? '', /missing/)
})

test('services route: the payload carries the rows and whether any live key exists', async () => {
  const db = makeDbWithAgents([{ id: 'svc-1' }])
  const app = Fastify()
  registerServiceRoutes(app, { db, config: config(), isOnline: () => true, requireUser: async () => undefined })

  // The response is JSON; the cast names what the page consumes (inject().json() is `any`, and
  // asserting the shape here is what makes a contract change fail this test).
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  const body = (await app.inject({ method: 'GET', url: '/api/services' })).json() as { services: unknown[]; keysExist: boolean }
  assert.equal(body.services.length, 1)
  assert.equal(body.keysExist, false, 'with no key at all the page has to say why every call would be a 401')

  mintApiKey(db, { name: 'Acme window', scopes: ['conversations:write'], scopeServices: ['chat'], createdBy: 'admin' })
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  const after = (await app.inject({ method: 'GET', url: '/api/services' })).json() as { keysExist: boolean }
  assert.equal(after.keysExist, true)
})
