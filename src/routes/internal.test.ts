import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { and, eq } from 'drizzle-orm'
import { schema, type Db } from '../db/index.js'
import type { AppConfig, ResolvedAgent, ResolvedEndpoint } from '../config.js'
import { DEFAULT_PRICING } from '../pricing.js'
import { GatewayClient } from '../gateway/client.js'
import { startFakeGateway, type FakeGateway, type FakeScript } from '../gateway/fake.js'
import { registerInternalRoutes } from './internal.js'
import type { Scheduler } from '../cron/schedule.js'
// Debt C3: agent construction / temp dirs / the test DB consolidate into the test harness.
import { agentWith, makeDbWithAgents, tempDir } from '../test-harness.js'

const API_KEY = 'test-key'
const BRAIN_TOKEN = 'brain-token-42'

// The gate reads process.env per request; set it once for the whole file and
// let individual tests toggle it (never delete it, or the rest 503).
process.env.BRAIN_TOKEN = BRAIN_TOKEN

const endpoint = (gw: FakeGateway): ResolvedEndpoint => ({
  id: 'A',
  url: gw.url,
  driver: 'gateway',
  prefix: gw.prefix,
  key: API_KEY,
  sandboxBase: null,
  sandboxKey: '',
  spawn: null, access: null,
})

const agentFor = (workspacePath: string): ResolvedAgent =>
  agentWith({ id: 'personal', name: 'Personal', workspacePath })

const SUCCESS: FakeScript = {
  frames: [
    { kind: 'message', text: 'ok', reasoning: null, usage: { inputTokens: 10, outputTokens: 5 } },
    { kind: 'turn_end', turn: 1, reason: 'completed', detail: null },
  ],
}

interface Harness {
  app: ReturnType<typeof Fastify>
  db: Db
  gw: FakeGateway
  config: AppConfig
}

const gateways: FakeGateway[] = []

const boot = async (script: FakeScript): Promise<Harness> => {
  const gw = await startFakeGateway(script, API_KEY)
  gateways.push(gw)
  // Debt C3: the test DB + temp dirs consolidate into the test harness.
  const workspace = tempDir('internal-ws')
  const db = makeDbWithAgents([{ id: 'personal', name: 'Personal', workspacePath: workspace }])
  const agent = agentFor(workspace)
  const ep = endpoint(gw)
  const config: AppConfig = {
    listen: { host: '127.0.0.1', port: 0 },
    endpoints: { A: ep },
    agents: { personal: agent },
    runner: { timeoutMs: 10_000, silenceMs: 0, maxConsecutiveFailures: 3, dailyBudgetMicroUsd: null },
    databasePath: ':memory:',
    pricing: DEFAULT_PRICING,
    sessionSecret: 'x'.repeat(32),
    initialUser: { username: 'admin', password: null },
    warnings: [],
  }
  // trustProxy=true matches production: request.ip takes X-Forwarded-For (the public client),
  // while the gate has to look at the socket peer -- the viaProxy case exists for exactly that gap.
  const app = Fastify({ trustProxy: true })
  const clients = new Map([['A', new GatewayClient(ep)]])
  const schedulerStub = { reload: () => {}, nextRunAt: () => null, problemFor: () => null } as unknown as Scheduler
  registerInternalRoutes(app, config, db, clients, new Map(), schedulerStub)
  return { app, db, gw, config }
}

after(async () => {
  await Promise.all(gateways.map((g) => g.close()))
})

const authed = (headers: Record<string, string> = {}): Record<string, string> => ({
  'x-brain-token': BRAIN_TOKEN,
  ...headers,
})

test('the brain gate fails closed: no token, wrong token, non-loopback, disabled', async () => {
  const { app } = await boot(SUCCESS)
  try {
    process.env.BRAIN_TOKEN = ''
    const disabled = await app.inject({ method: 'GET', url: '/api/internal/agents', headers: authed() })
    assert.equal(disabled.statusCode, 503)
  } finally {
    process.env.BRAIN_TOKEN = BRAIN_TOKEN
  }

  const missing = await app.inject({ method: 'GET', url: '/api/internal/agents' })
  assert.equal(missing.statusCode, 401)

  const wrong = await app.inject({ method: 'GET', url: '/api/internal/agents', headers: authed({ 'x-brain-token': 'nope' }) })
  assert.equal(wrong.statusCode, 401)

  const remote = await app.inject({
    method: 'GET',
    url: '/api/internal/agents',
    headers: authed(),
    remoteAddress: '203.0.113.9',
  })
  assert.equal(remote.statusCode, 403)

  // Hive plan 2 P6: in container form the brain sits on the Hive's internal network (172.x) -- a private source plus a valid token is let through
  const hiveNode = await app.inject({
    method: 'GET',
    url: '/api/internal/agents',
    headers: authed(),
    remoteAddress: '172.20.0.2',
  })
  assert.equal(hiveNode.statusCode, 200)

  const privateNoToken = await app.inject({
    method: 'GET',
    url: '/api/internal/agents',
    remoteAddress: '172.20.0.2',
  })
  assert.equal(privateNoToken.statusCode, 401, 'a private source must still carry a valid token')

  // Reverse-proxy case: the forwarding header carries the public client IP and the direct peer is an internal nginx/node -> it must be let through
  const viaProxy = await app.inject({
    method: 'GET',
    url: '/api/internal/agents',
    headers: { ...authed(), 'x-forwarded-for': '203.0.113.9' },
    remoteAddress: '172.20.0.5',
  })
  assert.equal(viaProxy.statusCode, 200, 'trust the direct peer, not the forwarding header')
})

test('agents list: shape and busy flag', async () => {
  const { app } = await boot(SUCCESS)
  const res = await app.inject({ method: 'GET', url: '/api/internal/agents', headers: authed() })
  assert.equal(res.statusCode, 200)
  const body = res.json() as { agents: Array<{ id: string; busy: boolean; chatCount: number }> }
  assert.equal(body.agents.length, 1)
  assert.equal(body.agents[0]?.id, 'personal')
  assert.equal(body.agents[0]?.busy, false)
  assert.equal(body.agents[0]?.chatCount, 0)
})

test('agent detail and empty board read', async () => {
  const { app } = await boot(SUCCESS)
  const detail = await app.inject({ method: 'GET', url: '/api/internal/agents/personal', headers: authed() })
  assert.equal(detail.statusCode, 200)
  const body = detail.json() as { id: string; endpoint: { driver: string } }
  assert.equal(body.id, 'personal')
  assert.equal(body.endpoint.driver, 'gateway')

  const board = await app.inject({ method: 'GET', url: '/api/internal/agents/personal/board', headers: authed() })
  assert.equal(board.statusCode, 200)
  // An uninitialised workspace reads as an empty model, not an error.
  assert.ok(Array.isArray((board.json() as { pages: unknown[] }).pages))

  const missing = await app.inject({ method: 'GET', url: '/api/internal/agents/nope', headers: authed() })
  assert.equal(missing.statusCode, 404)
})

test('dispatch: unknown agent 404, success runs with trigger=brain, concurrent dispatches all land', async () => {
  const { app, db, gw } = await boot(SUCCESS)

  const missing = await app.inject({
    method: 'POST',
    url: '/api/internal/dispatch',
    headers: authed(),
    payload: { agentId: 'nope', prompt: 'hi' },
  })
  assert.equal(missing.statusCode, 404)

  // source_chat_id has a FK to chat: the brain dispatches from its own chat, so
  // the row exists in the real flow.
  db.insert(schema.chat)
    .values({
      id: 'brain-chat-1',
      agentId: 'personal',
      dshSessionId: null,
      title: 'brain chat',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      removedAt: null,
    })
    .run()

  const ok = await app.inject({
    method: 'POST',
    url: '/api/internal/dispatch',
    headers: authed(),
    payload: { agentId: 'personal', prompt: 'write one line', sourceChatId: 'brain-chat-1' },
  })
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body))
  const outcome = ok.json() as { state: string }
  assert.equal(outcome.state, 'done')
  const runRow = db.select().from(schema.run).where(eq(schema.run.agentId, 'personal')).all()[0]
  assert.equal(runRow?.trigger, 'brain')
  assert.equal(runRow?.sourceChatId, 'brain-chat-1')

  // Hive P5.4: no more busy rejection -- concurrent dispatches to the same agent just run in parallel,
  // both dispatches succeed and each leaves its own row.
  gw.setScript(SUCCESS)
  const [c1, c2] = await Promise.all([
    app.inject({
      method: 'POST',
      url: '/api/internal/dispatch',
      headers: authed(),
      payload: { agentId: 'personal', prompt: 'write one more line' },
    }),
    app.inject({
      method: 'POST',
      url: '/api/internal/dispatch',
      headers: authed(),
      payload: { agentId: 'personal', prompt: 'write yet another line' },
    }),
  ])
  assert.equal(c1.statusCode, 200)
  assert.equal(c2.statusCode, 200)
  assert.equal((c1.json() as { state: string }).state, 'done')
  assert.equal((c2.json() as { state: string }).state, 'done')
  const live = db.select().from(schema.run).where(and(eq(schema.run.agentId, 'personal'), eq(schema.run.state, 'done'))).all()
  assert.ok(live.length >= 3, `concurrent dispatches all landed (${live.length} runs)`)
})

test('Hive P5.1: brain dispatch stops at the daily budget, and lifts when the cap is off', async () => {
  const { app, db, config } = await boot(SUCCESS)
  // One over-budget brain dispatch spent today
  const now = Date.now()
  db.insert(schema.run)
    .values({
      id: 'r-budget',
      agentId: 'personal',
      chatId: null,
      sourceChatId: null,
      cronId: null,
      dshSessionId: null,
      trigger: 'brain',
      idempotencyKey: null,
      state: 'done',
      resultSummary: 'x',
      startedAt: now,
      endedAt: now,
      error: null,
      commitHash: null,
    })
    .run()
  db.insert(schema.usageRecord)
    .values({
      runId: 'r-budget',
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      inputTokens: 1000,
      outputTokens: 100,
      cacheRead: null,
      cacheWrite: null,
      reasoningTokens: null,
      cost: 1_500_000,
      peakCost: 0,
      at: now,
    })
    .run()

  config.brainDailyBudgetMicroUsd = 1_000_000 // a $1 cap, $1.5 already spent
  const denied = await app.inject({
    method: 'POST',
    url: '/api/internal/dispatch',
    headers: authed(),
    payload: { agentId: 'personal', prompt: 'write one line' },
  })
  assert.equal(denied.statusCode, 409)
  const deniedBody = denied.json() as { error: string; detail: string }
  assert.equal(deniedBody.error, 'brain_budget_exhausted')
  assert.match(deniedBody.detail, /1\.50/)

  // With the cap off, dispatch is let through again
  config.brainDailyBudgetMicroUsd = null
  const ok = await app.inject({
    method: 'POST',
    url: '/api/internal/dispatch',
    headers: authed(),
    payload: { agentId: 'personal', prompt: 'write one line' },
  })
  assert.equal(ok.statusCode, 200)
})

test('Hive P5.3: internal prompt continues an existing chat, serialised per session', async () => {
  const { app, db } = await boot(SUCCESS)
  db.insert(schema.chat)
    .values({
      id: 'c-reuse',
      agentId: 'personal',
      dshSessionId: null,
      title: 'weekly report',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      removedAt: null,
    })
    .run()

  const ok = await app.inject({
    method: 'POST',
    url: '/api/internal/chats/c-reuse/prompt',
    headers: authed(),
    payload: { text: 'continue the weekly report' },
  })
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body))
  const outcome = ok.json() as { state: string; runId: string }
  assert.equal(outcome.state, 'done')
  const runRow = db.select().from(schema.run).where(eq(schema.run.id, outcome.runId)).all()[0]
  assert.equal(runRow?.trigger, 'brain')
  assert.equal(runRow?.chatId, 'c-reuse')
  const chatRow = db.select().from(schema.chat).where(eq(schema.chat.id, 'c-reuse')).all()[0]
  assert.ok(chatRow?.dshSessionId !== null && chatRow?.dshSessionId !== undefined, 'first turn binds the session')

  // Serialised within a chat: 409 while that chat has a turn running
  const now = Date.now()
  db.insert(schema.run)
    .values({
      id: 'r-live',
      agentId: 'personal',
      chatId: 'c-reuse',
      sourceChatId: null,
      cronId: null,
      dshSessionId: null,
      trigger: 'manual',
      idempotencyKey: null,
      state: 'running',
      resultSummary: null,
      startedAt: now,
      endedAt: null,
      error: null,
      commitHash: null,
    })
    .run()
  const busy = await app.inject({
    method: 'POST',
    url: '/api/internal/chats/c-reuse/prompt',
    headers: authed(),
    payload: { text: 'continue one more sentence' },
  })
  assert.equal(busy.statusCode, 409)
  assert.equal((busy.json() as { error: string }).error, 'chat_busy')

  const missing = await app.inject({
    method: 'POST',
    url: '/api/internal/chats/nope/prompt',
    headers: authed(),
    payload: { text: 'x' },
  })
  assert.equal(missing.statusCode, 404)
})

test('crons: drafted disabled by default, duplicate name 409, bad schedule 400', async () => {  const { app, db } = await boot(SUCCESS)
  const ok = await app.inject({
    method: 'POST',
    url: '/api/internal/crons',
    headers: authed(),
    payload: { agentId: 'personal', name: 'brain-drafted', schedule: '30 21 * * *', prompt: 'retrospective' },
  })
  assert.equal(ok.statusCode, 201)
  const body = ok.json() as { id: string; enabled: boolean }
  assert.equal(body.enabled, false)
  const row = db.select().from(schema.cron).where(eq(schema.cron.id, body.id)).all()[0]
  assert.equal(row?.enabled, 0)

  const dup = await app.inject({
    method: 'POST',
    url: '/api/internal/crons',
    headers: authed(),
    payload: { agentId: 'personal', name: 'brain-drafted', schedule: '30 21 * * *', prompt: 'x' },
  })
  assert.equal(dup.statusCode, 409)

  const bad = await app.inject({
    method: 'POST',
    url: '/api/internal/crons',
    headers: authed(),
    payload: { agentId: 'personal', name: 'bad', schedule: 'not a cron', prompt: 'x' },
  })
  assert.equal(bad.statusCode, 400)
})
