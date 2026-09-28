import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type preHandlerHookHandler } from 'fastify'
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
