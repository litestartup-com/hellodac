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

/**
 * 发布前优化（2026-09-26）：`agent_command.payload` 是 DB 体积唯一的大头——生产实测
 * 126 行占 32.8 MB / 34 MB，其中 99 条 node.spawn 平均 273 KB（`payload.profile`
 * 就是整份 DSH profile bundle）。领取路径只读 `state='pending'`（claimCommands），
 * 所以**终态行的 payload 再也不会被读**，但行会永久保留，同步放大每一次加密备份。
 *
 * 规则：**进终态即清 payload**；在途（pending/delivered）原样保留——agent 崩在投递
 * 中间时还要靠它排查；历史（type/state/result/doneAt）一律不动。
 */
test('发布前优化: 指令进终态即清空 payload，在途保留、历史字段不动', async () => {
  const { db } = openDb(':memory:')
  const app = buildApp(db)
  const { agentId, agentToken } = await register(app)

  const bundle = 'x'.repeat(200_000) // 模拟真实 node.spawn 的 profile bundle
  const read = (id: number) => db.select().from(schema.agentCommand).where(eq(schema.agentCommand.id, id)).all()[0]
  const ack = async (id: number, ok: boolean, result: unknown) =>
    app.inject({
      method: 'POST',
      url: `/api/internal/agents/${agentId}/events`,
      headers: { ...bearer(agentToken), 'content-type': 'application/json' },
      payload: { events: [{ type: 'command_result', commandId: id, ok, result }] },
    })
  const claim = () => app.inject({ method: 'GET', url: `/api/internal/agents/${agentId}/commands?wait=100`, headers: bearer(agentToken) })

  // pending：还没送达，payload 必须原样在
  const id = await enqueueAgentCommand(db, agentId, 'node.spawn', { nodeId: 'ops01', profile: bundle })
  assert.equal(read(id)?.state, 'pending')
  assert.ok((read(id)?.payload ?? '').length > 200_000, 'pending 的 payload 不能被清')

  // delivered（已领取、尚未回报）：同样保留
  assert.equal((await claim()).statusCode, 200)
  assert.equal(read(id)?.state, 'delivered')
  assert.ok((read(id)?.payload ?? '').length > 200_000, 'delivered 的 payload 不能被清')

  // done：payload 清空，历史字段保留
  await ack(id, true, { pid: 7 })
  const done = read(id)
  assert.equal(done?.state, 'done')
  assert.equal(done?.payload, '{}', '终态后 payload 必须是空 JSON（列为 notNull，保契约）')
  assert.deepEqual(JSON.parse(done?.result ?? 'null'), { pid: 7 }, 'result 历史保留')
  assert.ok((done?.doneAt ?? 0) > 0, 'doneAt 历史保留')

  // failed 走同一条路
  const id2 = await enqueueAgentCommand(db, agentId, 'node.spawn', { nodeId: 'ops02', profile: bundle })
  await claim()
  await ack(id2, false, { message: 'boom' })
  const failed = read(id2)
  assert.equal(failed?.state, 'failed')
  assert.equal(failed?.payload, '{}', '失败终态同样清 payload')
  assert.deepEqual(JSON.parse(failed?.result ?? 'null'), { message: 'boom' })
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
