import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type preHandlerHookHandler } from 'fastify'
import { eq } from 'drizzle-orm'
import type { AppConfig } from '../config.js'
import { openDb, schema, type Db } from '../db/index.js'
import { registerApiKeyRoutes } from './keys.js'

/**
 * The key-management surface (the admin side): session auth + plaintext returned once + service-name validation + full auditing.
 * The customer surface (port 8081, /v1) has its own set in public-api/routes.test.ts; the two do not share authentication.
 */
const config: AppConfig = {
  listen: { host: '127.0.0.1', port: 8080 },
  endpoints: {},
  agents: {},
  services: [
    { id: 'support', label: 'Support', workers: ['worker-1'], surfaces: ['tasks', 'conversations'], knowledge: [] },
  ],
  runner: { timeoutMs: 1000, silenceMs: 0, maxConsecutiveFailures: 3, dailyBudgetMicroUsd: null },
  databasePath: ':memory:',
  pricing: { rates: {}, peakWindows: [] },
  sessionSecret: 'x'.repeat(32),
  initialUser: { username: 'admin', password: null },
  warnings: [],
}

const noAuth: preHandlerHookHandler = async () => {}
const denyAuth: preHandlerHookHandler = async (_request, reply) => {
  await reply.code(401).send({ error: 'unauthorized' })
}

const build = (db: Db, requireUser: preHandlerHookHandler = noAuth) => {
  const app = Fastify()
  registerApiKeyRoutes(app, config, db, requireUser)
  return app
}

const create = (app: ReturnType<typeof build>, body: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/api/keys', payload: body })

test('the key-management surface: an unauthenticated call is stopped by requireUser (admin identity, not a key)', async () => {
  const { db } = openDb(':memory:')
  const res = await build(db, denyAuth).inject({ method: 'GET', url: '/api/keys' })
  assert.equal(res.statusCode, 401)
})

test('the key-management surface: create returns the plaintext once + lands an audit entry; the list carries no plaintext', async () => {
  const { db } = openDb(':memory:')
  const app = build(db)

  const created = await create(app, { name: 'Billing service', services: ['support'], scopes: ['services:read', 'tasks:write'], quotaRunsDay: 50 })
  assert.equal(created.statusCode, 201, created.body)
  const body = created.json() as { token: string; key: { id: string; name: string; quotaRunsDay: number | null } }
  assert.match(body.token, /^dac_[0-9a-f]{12}_/)
  assert.equal(body.key.name, 'Billing service')
  assert.equal(body.key.quotaRunsDay, 50)

  const listed = await app.inject({ method: 'GET', url: '/api/keys' })
  const list = listed.json() as { keys: Array<Record<string, unknown>>; services: Array<{ id: string }>; publicApi: { status: string } }
  assert.equal(list.keys.length, 1)
  // The secret alphabet has no `_` in it (see the TOKEN_RE comment in src/auth/api-key.ts), so splitting on the
  // delimiter is exact: what comes out is the full 43-character secret, rather than the shortened one that
  // happened to match by accident on 2026-09-27.
  assert.ok(!JSON.stringify(list).includes(body.token.split('_')[2] ?? 'x'), 'the list must not carry plaintext')
  assert.deepEqual(list.services.map((s) => s.id), ['support'], 'the create form draws its services from the config')
  assert.equal(typeof list.publicApi.status, 'string', 'the surface state comes back with the list (whether it is up has to be visible)')

  const audits = db.select().from(schema.auditLog).all()
  assert.equal(audits.length, 1)
  assert.equal(audits[0]?.kind, 'api_key_created')
  assert.match(audits[0]?.detail ?? '', /Billing service/)
})

test('the key-management surface: a mistyped service name = 400 (otherwise what goes out is a key that gets into no service)', async () => {
  const { db } = openDb(':memory:')
  const res = await create(build(db), { name: 'x', services: ['suport'] })
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().error, 'unknown_service')
  assert.match(String(res.json().detail), /suport/)
})

test('the key-management surface: a missing name or an illegal scope = 400; revoking an unknown id = 404, and revoking twice is idempotent', async () => {
  const { db } = openDb(':memory:')
  const app = build(db)

  assert.equal((await create(app, { services: ['support'] })).statusCode, 400)
  assert.equal((await create(app, { name: 'x', services: ['support'], scopes: ['root:all'] })).statusCode, 400)

  const created = await create(app, { name: 'y', services: ['support'] })
  const id = (created.json() as { key: { id: string } }).key.id
  assert.equal((await app.inject({ method: 'POST', url: `/api/keys/${id}/revoke` })).statusCode, 200)
  assert.equal((await app.inject({ method: 'POST', url: `/api/keys/${id}/revoke` })).statusCode, 200, 'revoking twice is idempotent')
  assert.equal((await app.inject({ method: 'POST', url: '/api/keys/ffffffffffff/revoke' })).statusCode, 404)

  const kinds = db.select().from(schema.auditLog).all().map((r) => r.kind)
  assert.ok(kinds.includes('api_key_revoked'))
})

const insertRun = (db: Db, over: Partial<Record<string, unknown>> & { id: string; apiKeyId: string }): void => {
  // run.agent_id is a real FK: the fixture needs the agent row before any run row.
  const hasAgent = db.select({ id: schema.agent.id }).from(schema.agent).where(eq(schema.agent.id, 'worker-1')).all().length > 0
  if (!hasAgent) {
    db.insert(schema.agent)
      .values({ id: 'worker-1', name: 'Worker', workspacePath: '.', endpoint: 'A', preset: null, gitRemote: null, public: 0, createdAt: 0 })
      .run()
  }
  db.insert(schema.run)
    .values({
      id: over.id,
      agentId: 'worker-1',
      apiKeyId: over.apiKeyId,
      chatId: null,
      sourceChatId: null,
      conflict: null,
      cronId: null,
      dshSessionId: null,
      trigger: 'api',
      idempotencyKey: null,
      state: typeof over.state === 'string' ? over.state : 'done',
      resultSummary: null,
      // Date.now() rather than a relative offset: "an hour ago" crosses the local-midnight boundary
      // when the suite runs between 00:00 and 01:00, and "today" would silently stop meaning today.
      startedAt: typeof over.startedAt === 'number' ? over.startedAt : Date.now(),
      endedAt: typeof over.endedAt === 'number' ? over.endedAt : Date.now(),
      error: null,
      commitHash: null,
    })
    .run()
}

test('the key detail: one key sees its own usage, calls and turns -- never another key\'s', async () => {
  const { db } = openDb(':memory:')
  const app = build(db)

  const mine = (await create(app, { name: 'Mine', services: ['support'] })).json() as { key: { id: string } }
  const other = (await create(app, { name: 'Other', services: ['support'] })).json() as { key: { id: string } }

  // My key: two finished runs today (one with cost), one call logged.
  insertRun(db, { id: 'mine-1', apiKeyId: mine.key.id })
  insertRun(db, { id: 'mine-2', apiKeyId: mine.key.id, state: 'running', endedAt: null })
  db.insert(schema.usageRecord)
    .values({ runId: 'mine-1', provider: 'deepseek-official', model: 'deepseek-v4-flash', inputTokens: 10, outputTokens: 5, cost: 123, peakCost: 0, at: Date.now() })
    .run()
  db.insert(schema.auditLog).values({ at: Date.now(), actor: `api_key:${mine.key.id}`, kind: 'api_call', detail: 'GET /v1/usage → 200' }).run()
  // The other key's activity must not leak in.
  insertRun(db, { id: 'other-1', apiKeyId: other.key.id })
  db.insert(schema.auditLog).values({ at: Date.now(), actor: `api_key:${other.key.id}`, kind: 'api_call', detail: 'GET /v1/services → 200' }).run()

  const res = await app.inject({ method: 'GET', url: `/api/keys/${mine.key.id}` })
  assert.equal(res.statusCode, 200)
  const body = res.json() as {
    key: { id: string; name: string; usedToday: number; active: number; serviceLabels: string[] }
    recentCalls: Array<{ at: number; detail: string }>
    recentRuns: Array<{ id: string; state: string; costMicroUsd: number | null }>
  }

  assert.equal(body.key.name, 'Mine')
  assert.equal(body.key.usedToday, 2, 'today\'s usage is counted from the run ledger')
  assert.equal(body.key.active, 1, 'the in-flight count is what the concurrency cap acts on')
  assert.deepEqual(body.key.serviceLabels, ['Support'], 'the detail says which service this key may enter')
  assert.deepEqual(body.recentCalls.map((c) => c.detail), ['GET /v1/usage → 200'], 'only this key\'s outward calls are listed')
  assert.deepEqual(body.recentRuns.map((r) => r.id).sort(), ['mine-1', 'mine-2'], 'only this key\'s turns are listed')
  assert.equal(body.recentRuns.find((r) => r.id === 'mine-1')?.costMicroUsd, 123, 'the turn carries its cost from the ledger')
})

test('the key detail: an unknown key id answers 404 without leaking anything', async () => {
  const { db } = openDb(':memory:')
  const res = await build(db).inject({ method: 'GET', url: '/api/keys/ffffffffffff' })
  assert.equal(res.statusCode, 404)
  assert.equal(res.json().error, 'unknown_key')
})

test('the key edit: PATCH changes what was sent and nothing else -- the secret is never touched', async () => {
  const { db } = openDb(':memory:')
  const app = build(db)
  const created = await create(app, { name: 'Billing service', services: ['support'], scopes: ['services:read'], quotaRunsDay: 50 })
  const { key } = created.json() as { token: string; key: { id: string; name: string; rateLimitRpm: number } }
  const id = key.id
  const hashBefore = db.select({ keyHash: schema.apiKey.keyHash }).from(schema.apiKey).where(eq(schema.apiKey.id, id)).all()[0]?.keyHash

  const res = await app.inject({
    method: 'PATCH',
    url: `/api/keys/${id}`,
    payload: { name: 'Renamed', rateLimitRpm: 120, quotaRunsDay: 500 },
  })
  assert.equal(res.statusCode, 200, res.body)
  const edited = res.json() as { key: { id: string; name: string; rateLimitRpm: number; quotaRunsDay: number; scopes: string[] } }
  assert.equal(edited.key.name, 'Renamed')
  assert.equal(edited.key.rateLimitRpm, 120, 'the per-minute cap follows the edit')
  assert.equal(edited.key.quotaRunsDay, 500)
  assert.deepEqual(edited.key.scopes, ['services:read'], 'fields not sent stay as they were')

  // The secret survives an edit: the stored hash is byte-identical, so the customer is not locked out.
  const hashAfter = db.select({ keyHash: schema.apiKey.keyHash }).from(schema.apiKey).where(eq(schema.apiKey.id, id)).all()[0]?.keyHash
  assert.equal(hashAfter, hashBefore, 'editing must not rotate the secret')

  const kinds = db.select().from(schema.auditLog).all().map((r) => r.kind)
  assert.ok(kinds.includes('api_key_edited'), 'the edit leaves an audit trail')
})

test('the key edit: an unknown id is 404, and an illegal edit (service does not exist / bad scope) is refused', async () => {
  const { db } = openDb(':memory:')
  const app = build(db)

  assert.equal((await app.inject({ method: 'PATCH', url: '/api/keys/ffffffffffff', payload: { name: 'x' } })).statusCode, 404)

  const created = await create(app, { name: 'y', services: ['support'] })
  const id = (created.json() as { key: { id: string } }).key.id
  const badService = await app.inject({ method: 'PATCH', url: `/api/keys/${id}`, payload: { services: ['suport'] } })
  assert.equal(badService.statusCode, 400)
  assert.equal(badService.json().error, 'unknown_service')

  const badScope = await app.inject({ method: 'PATCH', url: `/api/keys/${id}`, payload: { scopes: ['root:all'] } })
  assert.equal(badScope.statusCode, 400)
})

