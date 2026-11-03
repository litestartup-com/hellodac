import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'
import { and, eq } from 'drizzle-orm'
import { schema, type Db } from '../db/index.js'
import type { AppConfig, ResolvedAgent, ResolvedEndpoint } from '../config.js'
import { DEFAULT_PRICING } from '../pricing.js'
// The gateway driver is retired: the internal routes now hand the endpoint's SessionDriver plug
// straight to runAgent, so the whole file runs on the scripted in-memory fake (no HTTP anywhere).
import { FakeSessionDriver, type FakeScript } from '../session-driver/fake.js'
import type { SessionDriver } from '../session-driver/port.js'
import { registerInternalRoutes } from './internal.js'
import type { Scheduler } from '../cron/schedule.js'
// Debt C3: agent construction / temp dirs / the test DB consolidate into the test harness.
import { agentWith, makeDbWithAgents, tempDir } from '../test-harness.js'

const BRAIN_TOKEN = 'brain-token-42'

// The gate reads process.env per request; set it once for the whole file and
// let individual tests toggle it (never delete it, or the rest 503).
process.env.BRAIN_TOKEN = BRAIN_TOKEN

/** The endpoint fixture: an apiproxy driver on a loopback URL (the fake never touches HTTP). */
const endpointFixture = (): ResolvedEndpoint => ({
  id: 'A',
  url: 'http://127.0.0.1:3080',
  driver: 'apiproxy',
  prefix: '/api',
  key: 'test-key',
  sandboxBase: null,
  sandboxKey: '',
  spawn: null,
  access: null,
})

const agentFor = (workspacePath: string): ResolvedAgent =>
  agentWith({ id: 'personal', name: 'Personal', workspacePath })

// One successful turn over the port: a priced message frame plus a clean turn_end.
const SUCCESS: FakeScript = {
  frames: [
    { kind: 'message', seq: 0, text: 'ok', reasoning: null, usage: { inputTokens: 10, outputTokens: 5 } },
    { kind: 'turn_end', seq: 1, turn: 1, reason: 'completed', detail: null },
  ],
}

interface Harness {
  app: FastifyInstance
  db: Db
  /** The port fake wired as endpoint A's plug (the observation surface: created/prompts recordings). */
  upstream: FakeSessionDriver
  config: AppConfig
  workspace: string
}

/**
 * Boot the internal routes against a FakeSessionDriver map.
 *
 * opts.omitUpstream leaves endpoint A WITHOUT a plug -- the way an endpoint whose driver was never
 * wired looks after the gateway retirement; the prompt/dispatch routes must answer 500
 * endpoint_not_configured for it.
 */
const boot = (script: FakeScript = SUCCESS, opts: { omitUpstream?: boolean } = {}): Harness => {
  // Debt C3: the test DB + temp dirs consolidate into the test harness.
  const workspace = tempDir('internal-ws')
  const db = makeDbWithAgents([{ id: 'personal', name: 'Personal', workspacePath: workspace }])
  const agent = agentFor(workspace)
  const config: AppConfig = {
    listen: { host: '127.0.0.1', port: 0 },
    endpoints: { A: endpointFixture() },
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
  const upstream = new FakeSessionDriver('A', script)
  const upstreamClients = new Map<string, SessionDriver>(
    opts.omitUpstream === true ? [] : [['A', upstream]],
  )
  const schedulerStub = { reload: () => {}, nextRunAt: () => null, problemFor: () => null } as unknown as Scheduler
  registerInternalRoutes(app, config, db, upstreamClients, schedulerStub)
  return { app, db, upstream, config, workspace }
}

const authed = (headers: Record<string, string> = {}): Record<string, string> => ({
  'x-brain-token': BRAIN_TOKEN,
  ...headers,
})

test('the brain gate fails closed: no token, wrong token, non-loopback, disabled', async () => {
  const { app } = boot()
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
  const { app } = boot()
  const res = await app.inject({ method: 'GET', url: '/api/internal/agents', headers: authed() })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.agents.length, 1)
  assert.equal(body.agents[0]?.id, 'personal')
  assert.equal(body.agents[0]?.busy, false)
  assert.equal(body.agents[0]?.chatCount, 0)
})

test('agent detail and empty board read', async () => {
  const { app } = boot()
  const detail = await app.inject({ method: 'GET', url: '/api/internal/agents/personal', headers: authed() })
  assert.equal(detail.statusCode, 200)
  const body = detail.json()
  assert.equal(body.id, 'personal')
  // The gateway driver is retired: 'apiproxy' is the only driver the detail panel can report.
  assert.equal(body.endpoint.driver, 'apiproxy')

  const board = await app.inject({ method: 'GET', url: '/api/internal/agents/personal/board', headers: authed() })
  assert.equal(board.statusCode, 200)
  // An uninitialised workspace reads as an empty model, not an error.
  assert.ok(Array.isArray((board.json()).pages))

  const missing = await app.inject({ method: 'GET', url: '/api/internal/agents/nope', headers: authed() })
  assert.equal(missing.statusCode, 404)
})

test('dispatch: unknown agent 404, success runs with trigger=brain, concurrent dispatches all land', async () => {
  const { app, db, upstream, workspace } = boot()

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
  const outcome = ok.json()
  assert.equal(outcome.state, 'done')
  const runRow = db.select().from(schema.run).where(eq(schema.run.agentId, 'personal')).all()[0]
  assert.equal(runRow?.trigger, 'brain')
  assert.equal(runRow?.sourceChatId, 'brain-chat-1')
  // The runAgent invocation shape, observed on the port: the route handed THIS endpoint's
  // SessionDriver to runAgent, which created a session on the agent workspace and sent the prompt.
  assert.deepEqual(upstream.created, [{ cwd: workspace, preset: null }])
  assert.deepEqual(upstream.prompts, ['write one line'])

  // Hive P5.4: no more busy rejection -- concurrent dispatches to the same agent just run in parallel,
  // both dispatches succeed and each leaves its own row. (The fake pumps its script on every prompt,
  // so one driver instance serves all of them -- each dispatch creates its own session.)
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
  assert.equal((c1.json()).state, 'done')
  assert.equal((c2.json()).state, 'done')
  const live = db.select().from(schema.run).where(and(eq(schema.run.agentId, 'personal'), eq(schema.run.state, 'done'))).all()
  assert.ok(live.length >= 3, `concurrent dispatches all landed (${live.length} runs)`)
  assert.equal(upstream.created.length, 3, 'each concurrent dispatch created its own session through the port')
  assert.equal(upstream.prompts.length, 3)
})

test('Hive P5.1: brain dispatch stops at the daily budget, and lifts when the cap is off', async () => {
  const { app, db, config } = boot()
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
  const deniedBody = denied.json()
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
  const { app, db, upstream } = boot()
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
  const outcome = ok.json()
  assert.equal(outcome.state, 'done')
  const runRow = db.select().from(schema.run).where(eq(schema.run.id, outcome.runId)).all()[0]
  assert.equal(runRow?.trigger, 'brain')
  assert.equal(runRow?.chatId, 'c-reuse')
  const chatRow = db.select().from(schema.chat).where(eq(schema.chat.id, 'c-reuse')).all()[0]
  assert.ok(chatRow?.dshSessionId !== null && chatRow?.dshSessionId !== undefined, 'first turn binds the session')
  assert.deepEqual(upstream.prompts, ['continue the weekly report'], 'the prompt went through the endpoint SessionDriver')

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
  assert.equal((busy.json()).error, 'chat_busy')

  const missing = await app.inject({
    method: 'POST',
    url: '/api/internal/chats/nope/prompt',
    headers: authed(),
    payload: { text: 'x' },
  })
  assert.equal(missing.statusCode, 404)
})

test('prompt and dispatch answer 500 endpoint_not_configured when the endpoint has no SessionDriver', async () => {
  // The gateway retirement made the plug mandatory: an endpoint missing from the upstream map
  // cannot run a turn, and the routes say so instead of falling back to anything.
  const { app, db } = boot(SUCCESS, { omitUpstream: true })

  const dispatch = await app.inject({
    method: 'POST',
    url: '/api/internal/dispatch',
    headers: authed(),
    payload: { agentId: 'personal', prompt: 'write one line' },
  })
  assert.equal(dispatch.statusCode, 500)
  assert.equal((dispatch.json()).error, 'endpoint_not_configured')

  db.insert(schema.chat)
    .values({
      id: 'c-nowhere',
      agentId: 'personal',
      dshSessionId: null,
      title: 'orphan chat',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      removedAt: null,
    })
    .run()
  const prompt = await app.inject({
    method: 'POST',
    url: '/api/internal/chats/c-nowhere/prompt',
    headers: authed(),
    payload: { text: 'continue' },
  })
  assert.equal(prompt.statusCode, 500)
  assert.equal((prompt.json()).error, 'endpoint_not_configured')
})

test('crons: drafted disabled by default, duplicate name 409, bad schedule 400', async () => {
  const { app, db } = boot()
  const ok = await app.inject({
    method: 'POST',
    url: '/api/internal/crons',
    headers: authed(),
    payload: { agentId: 'personal', name: 'brain-drafted', schedule: '30 21 * * *', prompt: 'retrospective' },
  })
  assert.equal(ok.statusCode, 201)
  const body = ok.json()
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

test('approvals: the queue lists pending prompts and a decision resolves them through the port', async () => {
  const { app, db, upstream } = boot()
  db.insert(schema.run).values({
    id: 'run-approval-1', agentId: 'personal', trigger: 'brain', state: 'running',
    startedAt: Date.now(), dshSessionId: 'sess-1',
  }).run()
  db.insert(schema.approvalQueue).values({
    id: 'd-1', runId: 'run-approval-1', agentId: 'personal', approvalId: 'a-1',
    toolName: 'bash', reason: null, state: 'pending', outcome: null,
    createdAt: Date.now(), resolvedAt: null,
  }).run()

  const listed = await app.inject({ method: 'GET', url: '/api/internal/approvals', headers: authed() })
  assert.equal(listed.statusCode, 200)
  const approvals = listed.json().approvals as Array<{ id: string; state: string }>
  assert.equal(approvals.length, 1)
  assert.equal(approvals[0]?.id, 'd-1')

  const decided = await app.inject({
    method: 'POST',
    url: '/api/internal/approvals/d-1',
    headers: authed(),
    payload: { outcome: 'allowed-once' },
  })
  assert.equal(decided.statusCode, 200, decided.body)
  assert.deepEqual(upstream.decided, [
    { rpcId: 'd-1', sessionId: 'sess-1', approvalId: 'a-1', outcome: 'allowed-once' },
  ])

  const rows = db.select().from(schema.approvalQueue).where(eq(schema.approvalQueue.id, 'd-1')).all()
  assert.equal(rows[0]?.state, 'resolved')
  assert.equal(rows[0]?.outcome, 'allowed-once')
  assert.ok(typeof rows[0]?.resolvedAt === 'number')

  const again = await app.inject({
    method: 'POST',
    url: '/api/internal/approvals/d-1',
    headers: authed(),
    payload: { outcome: 'rejected' },
  })
  assert.equal(again.statusCode, 409, 'a decided prompt cannot be decided twice')
})

test('approvals: an unknown decision id and an invalid outcome are refused', async () => {
  const { app } = boot()
  const bad = await app.inject({
    method: 'POST',
    url: '/api/internal/approvals/nope',
    headers: authed(),
    payload: { outcome: 'whatever' },
  })
  assert.equal(bad.statusCode, 400)

  const missing = await app.inject({
    method: 'POST',
    url: '/api/internal/approvals/nope',
    headers: authed(),
    payload: { outcome: 'allowed-once' },
  })
  assert.equal(missing.statusCode, 404)
})
