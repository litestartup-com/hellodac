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

test('Capability four M1-3: command queue -- enqueue -> claim by long poll -> ack; a command is never handed out twice', async () => {
  const { db } = openDb(':memory:')
  const app = buildApp(db)
  const { agentId, agentToken } = await register(app)

  // Empty queue: a short wait returns nothing
  const empty = await app.inject({ method: 'GET', url: `/api/internal/agents/${agentId}/commands?wait=100`, headers: bearer(agentToken) })
  assert.equal(empty.statusCode, 200)
  assert.deepEqual(empty.json(), { commands: [] })

  // Enqueue two
  await enqueueAgentCommand(db, agentId, 'node.spawn', { nodeId: 'ops01' })
  await enqueueAgentCommand(db, agentId, 'node.stop', { nodeId: 'ops01' })

  const claimed = await app.inject({ method: 'GET', url: `/api/internal/agents/${agentId}/commands?wait=100`, headers: bearer(agentToken) })
  const body = claimed.json() as { commands: Array<{ id: number; type: string; payload: unknown }> }
  assert.equal(body.commands.length, 2, 'one claim takes every pending command')
  assert.equal(body.commands[0]?.type, 'node.spawn')
  assert.deepEqual(body.commands[0]?.payload, { nodeId: 'ops01' })

  const again = await app.inject({ method: 'GET', url: `/api/internal/agents/${agentId}/commands?wait=100`, headers: bearer(agentToken) })
  assert.deepEqual((again.json() as { commands: unknown[] }).commands, [], 'already claimed commands are not handed out again')

  // Ack: command_result ok -> done
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

  // A failed result -> failed
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
 * Pre-release optimization (2026-09-26): `agent_command.payload` is the one big contributor to DB
 * size -- production measured 126 rows at 32.8 MB / 34 MB, of which 99 node.spawn rows average
 * 273 KB (`payload.profile` is an entire DSH profile bundle). The claim path only reads
 * `state='pending'` (claimCommands), so **a terminal row's payload is never read again** -- yet the
 * rows stay forever and amplify every encrypted backup in step.
 *
 * Rule: **clear the payload on entering a terminal state**; in-flight (pending/delivered) rows keep
 * theirs -- an agent that crashed mid-delivery still needs it to debug; history (type/state/result/doneAt) never moves.
 */
test('Pre-release optimization: a command clears its payload once terminal, in-flight ones and history fields stay', async () => {
  const { db } = openDb(':memory:')
  const app = buildApp(db)
  const { agentId, agentToken } = await register(app)

  const bundle = 'x'.repeat(200_000) // stand-in for a real node.spawn profile bundle
  const read = (id: number) => db.select().from(schema.agentCommand).where(eq(schema.agentCommand.id, id)).all()[0]
  const ack = async (id: number, ok: boolean, result: unknown) =>
    app.inject({
      method: 'POST',
      url: `/api/internal/agents/${agentId}/events`,
      headers: { ...bearer(agentToken), 'content-type': 'application/json' },
      payload: { events: [{ type: 'command_result', commandId: id, ok, result }] },
    })
  const claim = () => app.inject({ method: 'GET', url: `/api/internal/agents/${agentId}/commands?wait=100`, headers: bearer(agentToken) })

  // pending: not delivered yet, the payload must still be there untouched
  const id = await enqueueAgentCommand(db, agentId, 'node.spawn', { nodeId: 'ops01', profile: bundle })
  assert.equal(read(id)?.state, 'pending')
  assert.ok((read(id)?.payload ?? '').length > 200_000, 'a pending payload must not be cleared')

  // delivered (claimed, not reported back yet): kept as well
  assert.equal((await claim()).statusCode, 200)
  assert.equal(read(id)?.state, 'delivered')
  assert.ok((read(id)?.payload ?? '').length > 200_000, 'a delivered payload must not be cleared')

  // done: payload cleared, history fields kept
  await ack(id, true, { pid: 7 })
  const done = read(id)
  assert.equal(done?.state, 'done')
  assert.equal(done?.payload, '{}', 'a terminal payload must be empty JSON (the column is notNull, keep the contract)')
  assert.deepEqual(JSON.parse(done?.result ?? 'null'), { pid: 7 }, 'the result history is kept')
  assert.ok((done?.doneAt ?? 0) > 0, 'the doneAt history is kept')

  // failed goes down the same path
  const id2 = await enqueueAgentCommand(db, agentId, 'node.spawn', { nodeId: 'ops02', profile: bundle })
  await claim()
  await ack(id2, false, { message: 'boom' })
  const failed = read(id2)
  assert.equal(failed?.state, 'failed')
  assert.equal(failed?.payload, '{}', 'a failed terminal state clears the payload too')
  assert.deepEqual(JSON.parse(failed?.result ?? 'null'), { message: 'boom' })
})

test('Capability four M1-3: an enqueue wakes the long poll -- it returns before the wait cap expires', async () => {
  const { db } = openDb(':memory:')
  const app = buildApp(db)
  const { agentId, agentToken } = await register(app)

  const t0 = Date.now()
  const pending = app.inject({ method: 'GET', url: `/api/internal/agents/${agentId}/commands?wait=2000`, headers: bearer(agentToken) })
  setTimeout(() => void enqueueAgentCommand(db, agentId, 'node.restart', { nodeId: 'ops01' }), 150)
  const res = await pending
  const elapsed = Date.now() - t0
  const body = res.json() as { commands: Array<{ type: string }> }
  assert.equal(body.commands.length, 1, 'woken up and claimed the command')
  assert.equal(body.commands[0]?.type, 'node.restart')
  assert.ok(elapsed < 1_500, `the wake-up must be far faster than the wait cap (took ${elapsed}ms)`)
})

test('Capability four M1-3: heartbeat and online check -- any authenticated request refreshes lastSeenAt; past the timeout it is offline', async () => {
  const { db } = openDb(':memory:')
  const app = buildApp(db)
  const { agentId, agentToken } = await register(app)

  const list = await app.inject({ method: 'GET', url: '/api/agents' })
  const onlineRow = (list.json() as { agents: Array<{ id: string; online: boolean }> }).agents.find((a) => a.id === agentId)
  assert.equal(onlineRow?.online, true, 'just registered = online')

  // Push lastSeenAt back beyond the timeout window -> offline
  db.update(schema.agentMachine).set({ lastSeenAt: Date.now() - AGENT_OFFLINE_MS - 1_000 }).where(eq(schema.agentMachine.id, agentId)).run()
  const list2 = await app.inject({ method: 'GET', url: '/api/agents' })
  const offlineRow = (list2.json() as { agents: Array<{ id: string; online: boolean }> }).agents.find((a) => a.id === agentId)
  assert.equal(offlineRow?.online, false, 'heartbeat timed out = offline')

  // A heartbeat event (an empty events array still counts as one authenticated request) -> back online
  await app.inject({ method: 'POST', url: `/api/internal/agents/${agentId}/events`, headers: { ...bearer(agentToken), 'content-type': 'application/json' }, payload: { events: [] } })
  const list3 = await app.inject({ method: 'GET', url: '/api/agents' })
  const backRow = (list3.json() as { agents: Array<{ id: string; online: boolean }> }).agents.find((a) => a.id === agentId)
  assert.equal(backRow?.online, true, 'back online after the heartbeat refresh')
})

test('Capability four M1-3: auth -- a bad token is 401; a token that does not match :id is 404; revoked is 401', async () => {
  const { db } = openDb(':memory:')
  const app = buildApp(db)
  const a = await register(app, 'srv-a')
  const b = await register(app, 'srv-b')

  const bad = await app.inject({ method: 'GET', url: `/api/internal/agents/${a.agentId}/commands?wait=100`, headers: bearer('wrong-token') })
  assert.equal(bad.statusCode, 401)

  const cross = await app.inject({ method: 'GET', url: `/api/internal/agents/${a.agentId}/commands?wait=100`, headers: bearer(b.agentToken) })
  assert.equal(cross.statusCode, 404, 'a token from another agent does not match this id (no existence leak)')

  await app.inject({ method: 'POST', url: `/api/agents/${b.agentId}/revoke` })
  const revoked = await app.inject({ method: 'GET', url: `/api/internal/agents/${b.agentId}/commands?wait=100`, headers: bearer(b.agentToken) })
  assert.equal(revoked.statusCode, 401, 'the token stops working after revocation')
})

test('Capability four M1-4: command result subscription -- an events report fires the subscriber, nothing arrives after unsubscribe', async () => {
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
  assert.deepEqual(seen, [{ id, ok: true }], 'a report notifies the subscriber right away')

  unsub()
  const id2 = await enqueueAgentCommand(db, agentId, 'node.stop', { nodeId: 'x' })
  await app.inject({ method: 'GET', url: `/api/internal/agents/${agentId}/commands?wait=100`, headers: bearer(agentToken) })
  await app.inject({
    method: 'POST',
    url: `/api/internal/agents/${agentId}/events`,
    headers: { ...bearer(agentToken), 'content-type': 'application/json' },
    payload: { events: [{ type: 'command_result', commandId: id2, ok: false }] },
  })
  assert.equal(seen.length, 1, 'nothing arrives after unsubscribe')
})
