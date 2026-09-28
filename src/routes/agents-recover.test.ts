import { test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import Fastify, { type preHandlerHookHandler } from 'fastify'
import { openDb, schema, type Db } from '../db/index.js'
import { registerAgentsRoutes, AGENT_OFFLINE_MS } from './agents.js'

/**
 * Incident regression (2026-09-25, ubuntu-focal went missing): once an agent comes back online, the
 * manager side must trigger Fleet reconciliation self-healing at once instead of waiting for the next periodic pass (10 minutes by default).
 *
 * The scene: the host restarted -> node-agent did not come up with the boot (the user unit lacked linger) -> every
 * node was gone; the agent later resumed its heartbeat, but the watchdog only sent a notice and did no self-healing, so the nodes waited for the periodic pass.
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

/** Push lastSeenAt outside the offline window to simulate "the agent has been dead for a while". */
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

test('Incident regression: an agent recovering from offline triggers the Fleet self-heal callback (once, and only once)', async () => {
  const { db } = openDb(':memory:')
  const recovered: string[] = []
  const app = buildApp(db, (agentId) => recovered.push(agentId))
  const { agentId, agentToken } = await register(app)

  // Just registered = online: a heartbeat must not count as a "recovery" (or a normal heartbeat would trigger reconciliation every 25s)
  await sendEvents(app, agentId, agentToken, [{ type: 'heartbeat', detail: {} }])
  assert.deepEqual(recovered, [], 'a heartbeat while online does not trigger self-healing')

  // The first heartbeat after going offline = the edge: it must trigger
  goOffline(db, agentId)
  await sendEvents(app, agentId, agentToken, [{ type: 'heartbeat', detail: {} }])
  assert.deepEqual(recovered, [agentId], 'offline -> online must trigger self-healing once')

  // Later heartbeats are back inside the online window: no repeat trigger (reconciliation is not a burden to repeat every 25s)
  await sendEvents(app, agentId, agentToken, [{ type: 'heartbeat', detail: {} }])
  assert.deepEqual(recovered, [agentId], 'a heartbeat after recovery does not trigger again')
})

test('Incident regression: the recovery decision is per machine -- another agent recovering does not affect this one', async () => {
  const { db } = openDb(':memory:')
  const recovered: string[] = []
  const app = buildApp(db, (agentId) => recovered.push(agentId))
  const a = await register(app, 'srv-a')
  const b = await register(app, 'srv-b')

  goOffline(db, a.agentId)
  await sendEvents(app, b.agentId, b.agentToken, [{ type: 'heartbeat', detail: {} }])
  assert.deepEqual(recovered, [], 'b was online all along, so its heartbeat triggers no self-healing')

  await sendEvents(app, a.agentId, a.agentToken, [{ type: 'heartbeat', detail: {} }])
  assert.deepEqual(recovered, [a.agentId], 'only the machine that really recovered triggers')
})

test('Incident regression: the commands long-poll entry point recognises a recovery too (the heartbeat rides along with the poll)', async () => {
  const { db } = openDb(':memory:')
  const recovered: string[] = []
  const app = buildApp(db, (agentId) => recovered.push(agentId))
  const { agentId, agentToken } = await register(app)

  goOffline(db, agentId)
  const res = await app.inject({ method: 'GET', url: `/api/internal/agents/${agentId}/commands?wait=100`, headers: bearer(agentToken) })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(recovered, [agentId], 'a long poll arriving is itself evidence of being online')
})

test('Incident regression: a command result counts as online evidence too -- an offline agent reporting back triggers self-healing', async () => {
  const { db } = openDb(':memory:')
  const recovered: string[] = []
  const app = buildApp(db, (agentId) => recovered.push(agentId))
  const { agentId, agentToken } = await register(app)

  goOffline(db, agentId)
  // After a restart the agent picks up an in-flight command and reports the result back -- that too is evidence that "it is back"
  const res = await sendEvents(app, agentId, agentToken, [{ type: 'command_result', commandId: 999, ok: false, result: {} }])
  assert.equal((res as { statusCode: number }).statusCode, 200)
  assert.deepEqual(recovered, [agentId], 'any authenticated report should be recognised as a recovery')
})

test('Incident regression: a manager without the wiring (no callback passed) does not blow up', async () => {
  const { db } = openDb(':memory:')
  const app = buildApp(db)
  const { agentId, agentToken } = await register(app)

  goOffline(db, agentId)
  const res = await sendEvents(app, agentId, agentToken, [{ type: 'heartbeat', detail: {} }])
  assert.equal((res as { statusCode: number }).statusCode, 200, 'a missing callback = silence, the heartbeat path is unaffected')
})
