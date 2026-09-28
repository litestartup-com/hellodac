import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FastifyInstance } from 'fastify'
import { mintApiKey, revokeApiKey, type ApiKey, type KeyScope } from '../auth/api-key.js'
import { openDb, schema, type Db } from '../db/index.js'
import type { AppConfig } from '../config.js'
import { buildPublicApiApp } from './listener.js'

/**
 * The security contract of the `/v1` surface (design manager/topics/public-api.md §3/§5/§11): keys
 * only, never session cookies; an unauthorised call reveals nothing about existence; minimal fields.
 */
const config = (over: Partial<AppConfig> = {}): AppConfig => ({
  listen: { host: '127.0.0.1', port: 8080 },
  endpoints: {},
  agents: {},
  services: [
    { id: 'support', label: 'Enterprise support', workers: ['worker-1'], surfaces: ['tasks', 'conversations'], knowledge: [] },
    { id: 'report', label: 'Reporting service', workers: ['worker-2'], surfaces: ['tasks'], knowledge: [] },
  ],
  runner: { timeoutMs: 1000, silenceMs: 0, maxConsecutiveFailures: 3, dailyBudgetMicroUsd: null },
  databasePath: ':memory:',
  pricing: { rates: {}, peakWindows: [] },
  sessionSecret: 'x'.repeat(32),
  initialUser: { username: 'admin', password: null },
  warnings: [],
  ...over,
})

const setup = (
  scopes: KeyScope[] = ['services:read', 'usage:read'],
  scopeServices: string[] = ['*'],
): { db: Db; app: FastifyInstance; key: ApiKey; token: string } => {
  const { db } = openDb(':memory:')
  const { token, key } = mintApiKey(db, { name: 'Test key', scopes, scopeServices, createdBy: 'admin' })
  return { db, app: buildPublicApiApp({ config: config(), db }), key, token }
}

const auth = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` })

test('/v1: no key / a malformed one / a session cookie all get 401 (the facade does not accept the backend identity)', async () => {
  const { app } = setup()
  const none = await app.inject({ method: 'GET', url: '/v1/services' })
  assert.equal(none.statusCode, 401)
  assert.equal(none.json().error, 'unauthorized')

  const malformed = await app.inject({ method: 'GET', url: '/v1/services', headers: auth('not-a-key') })
  assert.equal(malformed.statusCode, 401)

  // Key regression: a backend session cookie must be useless at the facade (the two doors do not recognise each other)
  const cookie = await app.inject({ method: 'GET', url: '/v1/services', headers: { cookie: 'mgr_sid=' + 'z'.repeat(43) } })
  assert.equal(cookie.statusCode, 401, 'a cookie is not an identity at the facade')
})

test('/v1: an unauthorised call (missing scope) gets 403 and reveals nothing about existence', async () => {
  const { app, token } = setup(['services:read'])
  const res = await app.inject({ method: 'GET', url: '/v1/usage', headers: auth(token) })
  assert.equal(res.statusCode, 403)
  assert.equal(res.json().error, 'insufficient_scope')
})

test('/v1/services: returns only the services this key may use and leaks no member (agent) info', async () => {
  const { app, token } = setup(['services:read'], ['support'])
  const res = await app.inject({ method: 'GET', url: '/v1/services', headers: auth(token) })
  assert.equal(res.statusCode, 200)
  const body: { services: Array<Record<string, unknown>> } = res.json()
  assert.equal(body.services.length, 1, 'support is the only one visible')
  assert.equal(body.services[0]?.id, 'support')
  assert.deepEqual(body.services[0]?.surfaces, ['tasks', 'conversations'])
  assert.ok(!('workers' in (body.services[0] ?? {})), 'member ids are operations info, not outward')
  assert.ok(!('knowledge' in (body.services[0] ?? {})), 'the manual mount path is not outward either')
})

test('/v1/services: a wildcard key sees every service', async () => {
  const { app, token } = setup(['services:read'], ['*'])
  const body: { services: Array<{ id: string }> } = (await app.inject({ method: 'GET', url: '/v1/services', headers: auth(token) })).json()
  assert.deepEqual(body.services.map((s) => s.id), ['support', 'report'])
})

test('/v1/usage: returns only its own account (today\'s quota and the running count)', async () => {
  const { app, token, key } = setup(['usage:read'])
  const res = await app.inject({ method: 'GET', url: '/v1/usage', headers: auth(token) })
  assert.equal(res.statusCode, 200)
  const body: { key: { id: string; scopes: string[] }; today: { used: number; remaining: number | null; active: number } } = res.json()
  assert.equal(body.key.id, key.id)
  assert.deepEqual(body.key.scopes, ['usage:read'])
  assert.equal(body.today.used, 0)
  assert.equal(body.today.active, 0)
  assert.equal(body.today.remaining, null, 'unlimited by default')
})

test('/v1: revoked keys get 401 at once with detail explaining why; the X-API-Key header works too', async () => {
  const { app, db, token, key } = setup()

  const viaHeader = await app.inject({ method: 'GET', url: '/v1/services', headers: { 'x-api-key': token } })
  assert.equal(viaHeader.statusCode, 200, 'X-API-Key equals Bearer (common behind a reverse proxy)')

  revokeApiKey(db, key.id)
  const revoked = await app.inject({ method: 'GET', url: '/v1/services', headers: auth(token) })
  assert.equal(revoked.statusCode, 401)
  assert.match(String(revoked.json().detail), /revoked/)
})

test('/v1/health: probes without auth (ops checking whether the facade is up)', async () => {
  const { app } = setup()
  const res = await app.inject({ method: 'GET', url: '/v1/health' })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().ok, true)
})

test('Audit: an authenticated call always leaves a row (actor=api_key:<id>); malformed leaves none (no table flooding)', async () => {
  const { app, db, token, key } = setup()
  await app.inject({ method: 'GET', url: '/v1/services', headers: auth(token) })
  await app.inject({ method: 'GET', url: '/v1/services', headers: auth('garbage') })

  const rows = db.select().from(schema.auditLog).all()
  assert.equal(rows.length, 1, 'only a call with an identifiable actor leaves a row')
  assert.equal(rows[0]?.actor, `api_key:${key.id}`)
  assert.match(rows[0]?.detail ?? '', /GET \/v1\/services → 200/)
})
