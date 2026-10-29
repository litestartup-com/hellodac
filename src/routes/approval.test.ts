import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { schema, type Db } from '../db/index.js'
import type { AppConfig, ResolvedAgent, ResolvedEndpoint } from '../config.js'
import { DEFAULT_PRICING } from '../pricing.js'
import { FakeSessionDriver } from '../session-driver/fake.js'
import type { SessionDriver } from '../session-driver/port.js'
import { registerApprovalRoutes } from './approval.js'
import { agentWith, makeDbWithAgents, tempDir } from '../test-harness.js'

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

interface Harness {
  app: FastifyInstance
  db: Db
  upstream: FakeSessionDriver
}

const boot = (): Harness => {
  const workspace = tempDir('approval-ws')
  const db = makeDbWithAgents([{ id: 'personal', name: 'Personal', workspacePath: workspace }])
  const agent: ResolvedAgent = agentWith({ id: 'personal', name: 'Personal', workspacePath: workspace })
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
  const app = Fastify()
  const upstream = new FakeSessionDriver('A', { frames: [] })
  const upstreamClients = new Map<string, SessionDriver>([['A', upstream]])
  registerApprovalRoutes(app, config, db, async () => undefined, upstreamClients)
  return { app, db, upstream }
}

const seedPending = (db: Db): void => {
  db.insert(schema.run).values({
    id: 'run-approval-1', agentId: 'personal', trigger: 'brain', state: 'running',
    startedAt: Date.now(), dshSessionId: 'sess-1',
  }).run()
  db.insert(schema.approvalQueue).values({
    id: 'd-1', runId: 'run-approval-1', agentId: 'personal', approvalId: 'a-1',
    toolName: 'bash', reason: null, state: 'pending', outcome: null,
    createdAt: Date.now(), resolvedAt: null,
  }).run()
}

test('the web door lists pending prompts and decides them through the same shared path', async () => {
  const { app, db, upstream } = boot()
  seedPending(db)

  const listed = await app.inject({ method: 'GET', url: '/api/approvals' })
  assert.equal(listed.statusCode, 200)
  const approvals = listed.json().approvals as Array<{ id: string; state: string }>
  assert.equal(approvals.length, 1)
  assert.equal(approvals[0]?.id, 'd-1')

  const decided = await app.inject({ method: 'POST', url: '/api/approvals/d-1', payload: { outcome: 'allowed-once' } })
  assert.equal(decided.statusCode, 200, decided.body)
  assert.deepEqual(upstream.decided, [
    { rpcId: 'd-1', sessionId: 'sess-1', approvalId: 'a-1', outcome: 'allowed-once' },
  ])

  const rows = db.select().from(schema.approvalQueue).where(eq(schema.approvalQueue.id, 'd-1')).all()
  assert.equal(rows[0]?.state, 'resolved')
  assert.equal(rows[0]?.outcome, 'allowed-once')

  const audit = db.select().from(schema.auditLog).all()
  assert.equal(audit.length, 1)
  assert.equal(audit[0]?.kind, 'approval_decide')
  assert.match(audit[0]?.detail ?? '', /d-1/)

  const again = await app.inject({ method: 'POST', url: '/api/approvals/d-1', payload: { outcome: 'rejected' } })
  assert.equal(again.statusCode, 409, 'a decided prompt cannot be decided twice')
})

test('the web door refuses an invalid outcome, an unknown id and a prompt without a session', async () => {
  const { app, db } = boot()
  seedPending(db)

  const bad = await app.inject({ method: 'POST', url: '/api/approvals/nope', payload: { outcome: 'whatever' } })
  assert.equal(bad.statusCode, 400)

  const missing = await app.inject({ method: 'POST', url: '/api/approvals/nope', payload: { outcome: 'allowed-once' } })
  assert.equal(missing.statusCode, 404)

  db.insert(schema.approvalQueue).values({
    id: 'd-nosession', runId: 'run-gone', agentId: 'personal', approvalId: 'a-x',
    toolName: 'bash', reason: null, state: 'pending', outcome: null,
    createdAt: Date.now(), resolvedAt: null,
  }).run()
  const nosession = await app.inject({ method: 'POST', url: '/api/approvals/d-nosession', payload: { outcome: 'allowed-once' } })
  assert.equal(nosession.statusCode, 409)
})
