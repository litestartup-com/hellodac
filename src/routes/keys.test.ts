import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type preHandlerHookHandler } from 'fastify'
import type { AppConfig } from '../config.js'
import { openDb, schema, type Db } from '../db/index.js'
import { registerApiKeyRoutes } from './keys.js'

/**
 * 钥匙管理面（后台）：会话鉴权 + 明文只回一次 + 服务名校验 + 全量审计。
 * 客户面（8081 的 /v1）在 public-api/routes.test.ts 里另有一套，两者不共用鉴权。
 */
const config: AppConfig = {
  listen: { host: '127.0.0.1', port: 8080 },
  endpoints: {},
  agents: {},
  services: [
    { id: 'support', label: '企业智能客服', workers: ['worker-1'], surfaces: ['tasks', 'conversations'], knowledge: [] },
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

test('钥匙管理面: 未登录被 requireUser 拦（后台身份，不是钥匙）', async () => {
  const { db } = openDb(':memory:')
  const res = await build(db, denyAuth).inject({ method: 'GET', url: '/api/keys' })
  assert.equal(res.statusCode, 401)
})

test('钥匙管理面: 创建返回明文一次 + 落审计；列表不含明文', async () => {
  const { db } = openDb(':memory:')
  const app = build(db)

  const created = await create(app, { name: '计费服务', services: ['support'], scopes: ['services:read', 'tasks:write'], quotaRunsDay: 50 })
  assert.equal(created.statusCode, 201, created.body)
  const body = created.json() as { token: string; key: { id: string; name: string; quotaRunsDay: number | null } }
  assert.match(body.token, /^dac_[0-9a-f]{12}_/)
  assert.equal(body.key.name, '计费服务')
  assert.equal(body.key.quotaRunsDay, 50)

  const listed = await app.inject({ method: 'GET', url: '/api/keys' })
  const list = listed.json() as { keys: Array<Record<string, unknown>>; services: Array<{ id: string }>; publicApi: { status: string } }
  assert.equal(list.keys.length, 1)
  assert.ok(!JSON.stringify(list).includes(body.token.split('_')[2] ?? 'x'), '列表不得含明文')
  assert.deepEqual(list.services.map((s) => s.id), ['support'], '创建表单的服务来源 = 配置里的服务')
  assert.equal(typeof list.publicApi.status, 'string', '门面状态随列表返回（起没起要看得见）')

  const audits = db.select().from(schema.auditLog).all()
  assert.equal(audits.length, 1)
  assert.equal(audits[0]?.kind, 'api_key_created')
  assert.match(audits[0]?.detail ?? '', /计费服务/)
})

test('钥匙管理面: 服务名写错 = 400（否则发出去的是一把进不去任何服务的钥匙）', async () => {
  const { db } = openDb(':memory:')
  const res = await create(build(db), { name: 'x', services: ['suport'] })
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().error, 'unknown_service')
  assert.match(String(res.json().detail), /suport/)
})

test('钥匙管理面: 缺名字/非法 scope = 400；未知 id 吊销 = 404，重复吊销幂等', async () => {
  const { db } = openDb(':memory:')
  const app = build(db)

  assert.equal((await create(app, { services: ['support'] })).statusCode, 400)
  assert.equal((await create(app, { name: 'x', services: ['support'], scopes: ['root:all'] })).statusCode, 400)

  const created = await create(app, { name: 'y', services: ['support'] })
  const id = (created.json() as { key: { id: string } }).key.id
  assert.equal((await app.inject({ method: 'POST', url: `/api/keys/${id}/revoke` })).statusCode, 200)
  assert.equal((await app.inject({ method: 'POST', url: `/api/keys/${id}/revoke` })).statusCode, 200, '重复吊销幂等')
  assert.equal((await app.inject({ method: 'POST', url: '/api/keys/ffffffffffff/revoke' })).statusCode, 404)

  const kinds = db.select().from(schema.auditLog).all().map((r) => r.kind)
  assert.ok(kinds.includes('api_key_revoked'))
})
