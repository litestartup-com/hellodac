import { test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import Fastify, { type preHandlerHookHandler } from 'fastify'
import { openDb, schema, type Db } from '../db/index.js'
import { registerAgentsRoutes, enqueueAgentCommand, AGENT_OFFLINE_MS, subscribeAgentCommandResults } from './agents.js'

const buildApp = (db: Db, requireUser: preHandlerHookHandler = async () => {}): Fastify.FastifyInstance => {
  const app = Fastify()
  registerAgentsRoutes(app, db, requireUser)
  return app
}

const register = async (app: Fastify.FastifyInstance, hostname = 'srv-a'): Promise<{ agentId: string; agentToken: string }> => {
  const join = ((await app.inject({ method: 'POST', url: '/api/agents/join' })).json() as { token: string }).token
  const res = await app.inject({
    method: 'POST',
    url: '/api/internal/agents/register',
    payload: { joinToken: join, hostname, os: 'linux', arch: 'amd64', nodeVersion: '22.23.2' },
  })
  return res.json() as { agentId: string; agentToken: string }
}

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` })

test('能力四 M1-3: 指令队列——入队→长轮询领取→确认，一次领取不重复', async () => {
  const { db } = openDb(':memory:')
  const app = buildApp(db)
  const { agentId, agentToken } = await register(app)

  // 空队列：短等待返回空
  const empty = await app.inject({ method: 'GET', url: `/api/internal/agents/${agentId}/commands?wait=100`, headers: bearer(agentToken) })
  assert.equal(empty.statusCode, 200)
  assert.deepEqual(empty.json(), { commands: [] })

  // 入队两条
  await enqueueAgentCommand(db, agentId, 'node.spawn', { nodeId: 'ops01' })
  await enqueueAgentCommand(db, agentId, 'node.stop', { nodeId: 'ops01' })

  const claimed = await app.inject({ method: 'GET', url: `/api/internal/agents/${agentId}/commands?wait=100`, headers: bearer(agentToken) })
  const body = claimed.json() as { commands: Array<{ id: number; type: string; payload: unknown }> }
  assert.equal(body.commands.length, 2, '一次领走全部 pending')
  assert.equal(body.commands[0]?.type, 'node.spawn')
  assert.deepEqual(body.commands[0]?.payload, { nodeId: 'ops01' })

  const again = await app.inject({ method: 'GET', url: `/api/internal/agents/${agentId}/commands?wait=100`, headers: bearer(agentToken) })
  assert.deepEqual((again.json() as { commands: unknown[] }).commands, [], '已领取的不再下发')

  // 确认：command_result ok → done
  const ack = await app.inject({
    method: 'POST',
    url: `/api/internal/agents/${agentId}/events`,
    headers: { ...bearer(agentToken), 'content-type': 'application/json' },
    payload: { events: [{ type: 'command_result', commandId: body.commands[0]!.id, ok: true, result: { pid: 42 } }] },
  })
  assert.equal(ack.statusCode, 200)
  const row = db.select().from(schema.agentCommand).where(eq(schema.agentCommand.id, body.commands[0]!.id)).all()[0]
  assert.equal(row?.state, 'done')
  assert.deepEqual(JSON.parse(row?.result ?? 'null'), { pid: 42 })

  // 失败结果 → failed
  const fail = await app.inject({
    method: 'POST',
    url: `/api/internal/agents/${agentId}/events`,
    headers: { ...bearer(agentToken), 'content-type': 'application/json' },
    payload: { events: [{ type: 'command_result', commandId: body.commands[1]!.id, ok: false, result: { message: 'boom' } }] },
  })
  assert.equal(fail.statusCode, 200)
  const row2 = db.select().from(schema.agentCommand).where(eq(schema.agentCommand.id, body.commands[1]!.id)).all()[0]
  assert.equal(row2?.state, 'failed')
})

test('能力四 M1-3: 长轮询被入队唤醒——不等满 wait 即返回', async () => {
  const { db } = openDb(':memory:')
  const app = buildApp(db)
  const { agentId, agentToken } = await register(app)

  const t0 = Date.now()
  const pending = app.inject({ method: 'GET', url: `/api/internal/agents/${agentId}/commands?wait=2000`, headers: bearer(agentToken) })
  setTimeout(() => void enqueueAgentCommand(db, agentId, 'node.restart', { nodeId: 'ops01' }), 150)
  const res = await pending
  const elapsed = Date.now() - t0
  const body = res.json() as { commands: Array<{ type: string }> }
  assert.equal(body.commands.length, 1, '被唤醒并领到指令')
  assert.equal(body.commands[0]?.type, 'node.restart')
  assert.ok(elapsed < 1_500, `唤醒应远快于 wait 上限（实际 ${elapsed}ms）`)
})

test('能力四 M1-3: 心跳与在线判定——任何鉴权请求刷 lastSeenAt，超时算离线', async () => {
  const { db } = openDb(':memory:')
  const app = buildApp(db)
  const { agentId, agentToken } = await register(app)

  const list = await app.inject({ method: 'GET', url: '/api/agents' })
  const onlineRow = (list.json() as { agents: Array<{ id: string; online: boolean }> }).agents.find((a) => a.id === agentId)
  assert.equal(onlineRow?.online, true, '刚注册 = 在线')

  // 把 lastSeenAt 拨回超时窗口外 → 离线
  db.update(schema.agentMachine).set({ lastSeenAt: Date.now() - AGENT_OFFLINE_MS - 1_000 }).where(eq(schema.agentMachine.id, agentId)).run()
  const list2 = await app.inject({ method: 'GET', url: '/api/agents' })
  const offlineRow = (list2.json() as { agents: Array<{ id: string; online: boolean }> }).agents.find((a) => a.id === agentId)
  assert.equal(offlineRow?.online, false, '心跳超时 = 离线')

  // 心跳事件（空 events 数组也算一次鉴权）→ 回在线
  await app.inject({ method: 'POST', url: `/api/internal/agents/${agentId}/events`, headers: { ...bearer(agentToken), 'content-type': 'application/json' }, payload: { events: [] } })
  const list3 = await app.inject({ method: 'GET', url: '/api/agents' })
  const backRow = (list3.json() as { agents: Array<{ id: string; online: boolean }> }).agents.find((a) => a.id === agentId)
  assert.equal(backRow?.online, true, '心跳刷新后回在线')
})

test('能力四 M1-3: 鉴权——坏 token 401；token 与 :id 不匹配 404；吊销后 401', async () => {
  const { db } = openDb(':memory:')
  const app = buildApp(db)
  const a = await register(app, 'srv-a')
  const b = await register(app, 'srv-b')

  const bad = await app.inject({ method: 'GET', url: `/api/internal/agents/${a.agentId}/commands?wait=100`, headers: bearer('wrong-token') })
  assert.equal(bad.statusCode, 401)

  const cross = await app.inject({ method: 'GET', url: `/api/internal/agents/${a.agentId}/commands?wait=100`, headers: bearer(b.agentToken) })
  assert.equal(cross.statusCode, 404, '别的 agent 的 token 不匹配本 id（不泄露存在性）')

  await app.inject({ method: 'POST', url: `/api/agents/${b.agentId}/revoke` })
  const revoked = await app.inject({ method: 'GET', url: `/api/internal/agents/${b.agentId}/commands?wait=100`, headers: bearer(b.agentToken) })
  assert.equal(revoked.statusCode, 401, '吊销后 token 失效')
})

test('能力四 M1-4: 指令结果订阅——events 回报触发订阅者，退订后不再收到', async () => {
  const { db } = openDb(':memory:')
  const app = buildApp(db)
  const { agentId, agentToken } = await register(app)

  const id = await enqueueAgentCommand(db, agentId, 'node.spawn', { nodeId: 'x' })
  await app.inject({ method: 'GET', url: `/api/internal/agents/${agentId}/commands?wait=100`, headers: bearer(agentToken) })

  const seen: Array<{ id: number; ok: boolean }> = []
  const unsub = subscribeAgentCommandResults((commandId, ok) => seen.push({ id: commandId, ok }))
  await app.inject({
    method: 'POST',
    url: `/api/internal/agents/${agentId}/events`,
    headers: { ...bearer(agentToken), 'content-type': 'application/json' },
    payload: { events: [{ type: 'command_result', commandId: id, ok: true }] },
  })
  assert.deepEqual(seen, [{ id, ok: true }], '回报即通知订阅者')

  unsub()
  const id2 = await enqueueAgentCommand(db, agentId, 'node.stop', { nodeId: 'x' })
  await app.inject({ method: 'GET', url: `/api/internal/agents/${agentId}/commands?wait=100`, headers: bearer(agentToken) })
  await app.inject({
    method: 'POST',
    url: `/api/internal/agents/${agentId}/events`,
    headers: { ...bearer(agentToken), 'content-type': 'application/json' },
    payload: { events: [{ type: 'command_result', commandId: id2, ok: false }] },
  })
  assert.equal(seen.length, 1, '退订后不再收到')
})
