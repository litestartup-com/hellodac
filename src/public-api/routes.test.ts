import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FastifyInstance } from 'fastify'
import { mintApiKey, revokeApiKey, type ApiKey, type KeyScope } from '../auth/api-key.js'
import { openDb, schema, type Db } from '../db/index.js'
import type { AppConfig } from '../config.js'
import { buildPublicApiApp } from './listener.js'

/**
 * `/v1` 面的安全契约（设计稿 manager/topics/public-api.md §3/§5/§11）：
 * 只认钥匙、不认会话 cookie；越权不说资源存在与否；对外只暴露必要字段。
 */
const config = (over: Partial<AppConfig> = {}): AppConfig => ({
  listen: { host: '127.0.0.1', port: 8080 },
  endpoints: {},
  agents: {},
  services: [
    { id: 'support', label: '企业智能客服', workers: ['worker-1'], surfaces: ['tasks', 'conversations'], knowledge: [] },
    { id: 'report', label: '报表服务', workers: ['worker-2'], surfaces: ['tasks'], knowledge: [] },
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
  const { token, key } = mintApiKey(db, { name: '测试钥匙', scopes, scopeServices, createdBy: 'admin' })
  return { db, app: buildPublicApiApp({ config: config(), db }), key, token }
}

const auth = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` })

test('/v1: 无钥匙 / 格式错 / 会话 cookie 一律 401（门面不认后台的身份）', async () => {
  const { app } = setup()
  const none = await app.inject({ method: 'GET', url: '/v1/services' })
  assert.equal(none.statusCode, 401)
  assert.equal(none.json().error, 'unauthorized')

  const malformed = await app.inject({ method: 'GET', url: '/v1/services', headers: auth('not-a-key') })
  assert.equal(malformed.statusCode, 401)

  // 关键回归：后台会话 cookie 在门面必须无效（两扇门不互认）
  const cookie = await app.inject({ method: 'GET', url: '/v1/services', headers: { cookie: 'mgr_sid=' + 'z'.repeat(43) } })
  assert.equal(cookie.statusCode, 401, 'cookie 不是门面的身份')
})

test('/v1: 越权（缺 scope）403，且不透露资源是否存在', async () => {
  const { app, token } = setup(['services:read'])
  const res = await app.inject({ method: 'GET', url: '/v1/usage', headers: auth(token) })
  assert.equal(res.statusCode, 403)
  assert.equal(res.json().error, 'insufficient_scope')
})

test('/v1/services: 只回本钥匙允许的服务，且不泄漏成员（坐席）信息', async () => {
  const { app, token } = setup(['services:read'], ['support'])
  const res = await app.inject({ method: 'GET', url: '/v1/services', headers: auth(token) })
  assert.equal(res.statusCode, 200)
  const body: { services: Array<Record<string, unknown>> } = res.json()
  assert.equal(body.services.length, 1, '只看到 support')
  assert.equal(body.services[0]?.id, 'support')
  assert.deepEqual(body.services[0]?.surfaces, ['tasks', 'conversations'])
  assert.ok(!('workers' in (body.services[0] ?? {})), '成员 id 属运营信息，不对外')
  assert.ok(!('knowledge' in (body.services[0] ?? {})), '手册挂载路径同样不对外')
})

test('/v1/services: 通配钥匙看到全部服务', async () => {
  const { app, token } = setup(['services:read'], ['*'])
  const body: { services: Array<{ id: string }> } = (await app.inject({ method: 'GET', url: '/v1/services', headers: auth(token) })).json()
  assert.deepEqual(body.services.map((s) => s.id), ['support', 'report'])
})

test('/v1/usage: 只回自己的账（含今日配额与在跑数）', async () => {
  const { app, token, key } = setup(['usage:read'])
  const res = await app.inject({ method: 'GET', url: '/v1/usage', headers: auth(token) })
  assert.equal(res.statusCode, 200)
  const body: { key: { id: string; scopes: string[] }; today: { used: number; remaining: number | null; active: number } } = res.json()
  assert.equal(body.key.id, key.id)
  assert.deepEqual(body.key.scopes, ['usage:read'])
  assert.equal(body.today.used, 0)
  assert.equal(body.today.active, 0)
  assert.equal(body.today.remaining, null, '默认不限次数')
})

test('/v1: 吊销后立即 401，且 detail 说明原因；X-API-Key 头同样可用', async () => {
  const { app, db, token, key } = setup()

  const viaHeader = await app.inject({ method: 'GET', url: '/v1/services', headers: { 'x-api-key': token } })
  assert.equal(viaHeader.statusCode, 200, 'X-API-Key 与 Bearer 等价（反代转发常用）')

  revokeApiKey(db, key.id)
  const revoked = await app.inject({ method: 'GET', url: '/v1/services', headers: auth(token) })
  assert.equal(revoked.statusCode, 401)
  assert.match(String(revoked.json().detail), /revoked/)
})

test('/v1/health: 不鉴权即可探活（运维确认门面在不在）', async () => {
  const { app } = setup()
  const res = await app.inject({ method: 'GET', url: '/v1/health' })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().ok, true)
})

test('审计: 通过鉴权的调用必留痕（actor=api_key:<id>）；malformed 不留痕（防灌表）', async () => {
  const { app, db, token, key } = setup()
  await app.inject({ method: 'GET', url: '/v1/services', headers: auth(token) })
  await app.inject({ method: 'GET', url: '/v1/services', headers: auth('garbage') })

  const rows = db.select().from(schema.auditLog).all()
  assert.equal(rows.length, 1, '只有可识别身份的调用才留痕')
  assert.equal(rows[0]?.actor, `api_key:${key.id}`)
  assert.match(rows[0]?.detail ?? '', /GET \/v1\/services → 200/)
})
