import { test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import Fastify, { type preHandlerHookHandler } from 'fastify'
import { openDb, schema, type Db } from '../db/index.js'
import { registerAgentsRoutes, AGENT_OFFLINE_MS } from './agents.js'

/**
 * 事故回归（2026-09-25 ubuntu-focal 失联）：agent 重新上线后，manager 侧
 * 必须立即触发舰队对账自愈，而不是干等下一次周期对账（默认 10 分钟）。
 *
 * 现场：主机重启 → node-agent 没随开机起来（user unit 缺 linger）→ 节点全灭；
 * agent 后来恢复心跳，但看门狗只发通知、不做自愈，节点要等周期对账才回来。
 */

const buildApp = (
  db: Db,
  onAgentRecover?: (agentId: string) => void,
  requireUser: preHandlerHookHandler = async () => {},
): Fastify.FastifyInstance => {
  const app = Fastify()
  registerAgentsRoutes(app, db, requireUser, undefined, onAgentRecover)
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

/** 把 lastSeenAt 拨到离线窗口之外，模拟「agent 死了一段时间」。 */
const goOffline = (db: Db, agentId: string): void => {
  db.update(schema.agentMachine)
    .set({ lastSeenAt: Date.now() - AGENT_OFFLINE_MS - 1_000 })
    .where(eq(schema.agentMachine.id, agentId))
    .run()
}

const sendEvents = (app: Fastify.FastifyInstance, agentId: string, token: string, events: unknown[]): Promise<unknown> =>
  app.inject({
    method: 'POST',
    url: `/api/internal/agents/${agentId}/events`,
    headers: { ...bearer(token), 'content-type': 'application/json' },
    payload: { events },
  })

test('事故回归: agent 从离线恢复 → 触发（且只触发一次）舰队自愈回调', async () => {
  const { db } = openDb(':memory:')
  const recovered: string[] = []
  const app = buildApp(db, (agentId) => recovered.push(agentId))
  const { agentId, agentToken } = await register(app)

  // 刚注册 = 在线：心跳不该当作「恢复」（避免正常心跳每 25s 触发一次对账）
  await sendEvents(app, agentId, agentToken, [{ type: 'heartbeat', detail: {} }])
  assert.deepEqual(recovered, [], '在线期间的心跳不触发自愈')

  // 掉线后第一个心跳 = 边沿：必须触发
  goOffline(db, agentId)
  await sendEvents(app, agentId, agentToken, [{ type: 'heartbeat', detail: {} }])
  assert.deepEqual(recovered, [agentId], '离线→在线 必须触发一次自愈')

  // 后续心跳已回到在线窗口内：不再重复触发（对账不是每 25s 一次的负担）
  await sendEvents(app, agentId, agentToken, [{ type: 'heartbeat', detail: {} }])
  assert.deepEqual(recovered, [agentId], '恢复后的心跳不再重复触发')
})

test('事故回归: 恢复判定按机器隔离——别的 agent 恢复不影响本机', async () => {
  const { db } = openDb(':memory:')
  const recovered: string[] = []
  const app = buildApp(db, (agentId) => recovered.push(agentId))
  const a = await register(app, 'srv-a')
  const b = await register(app, 'srv-b')

  goOffline(db, a.agentId)
  await sendEvents(app, b.agentId, b.agentToken, [{ type: 'heartbeat', detail: {} }])
  assert.deepEqual(recovered, [], 'b 一直在线，它的心跳不触发自愈')

  await sendEvents(app, a.agentId, a.agentToken, [{ type: 'heartbeat', detail: {} }])
  assert.deepEqual(recovered, [a.agentId], '只有真正恢复的那台触发')
})

test('事故回归: commands 长轮询入口同样识别恢复（心跳随轮询携带）', async () => {
  const { db } = openDb(':memory:')
  const recovered: string[] = []
  const app = buildApp(db, (agentId) => recovered.push(agentId))
  const { agentId, agentToken } = await register(app)

  goOffline(db, agentId)
  const res = await app.inject({ method: 'GET', url: `/api/internal/agents/${agentId}/commands?wait=100`, headers: bearer(agentToken) })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(recovered, [agentId], '长轮询抵达即在线证据')
})

test('事故回归: 指令结果回传也算一次在线证据——离线 agent 回传即触发自愈', async () => {
  const { db } = openDb(':memory:')
  const recovered: string[] = []
  const app = buildApp(db, (agentId) => recovered.push(agentId))
  const { agentId, agentToken } = await register(app)

  goOffline(db, agentId)
  // 重启后 agent 领到在途指令并回报结果——这也是「它回来了」的证据
  const res = await sendEvents(app, agentId, agentToken, [{ type: 'command_result', commandId: 999, ok: false, result: {} }])
  assert.equal((res as { statusCode: number }).statusCode, 200)
  assert.deepEqual(recovered, [agentId], '任意鉴权回报都应识别为恢复')
})

test('事故回归: 未接线的 manager（不传回调）不炸', async () => {
  const { db } = openDb(':memory:')
  const app = buildApp(db)
  const { agentId, agentToken } = await register(app)

  goOffline(db, agentId)
  const res = await sendEvents(app, agentId, agentToken, [{ type: 'heartbeat', detail: {} }])
  assert.equal((res as { statusCode: number }).statusCode, 200, '回调缺省 = 静默，不影响心跳通路')
})
