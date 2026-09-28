import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import Fastify, { type preHandlerHookHandler } from 'fastify'
import { openDb, schema, type Db } from '../db/index.js'
import { registerAgentsRoutes } from './agents.js'

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

const buildApp = (db: Db, requireUser: preHandlerHookHandler = async () => {}, audits: string[] = []): Fastify.FastifyInstance => {
  const app = Fastify()
  registerAgentsRoutes(app, db, requireUser, (_actor, kind) => audits.push(kind))
  return app
}

test('Capability four M1-2: join issues a one-time token (expires in 15 minutes; the DB stores only the hash)', async () => {
  const { db } = openDb(':memory:')
  const audits: string[] = []
  const app = buildApp(db, async () => {}, audits)

  const res = await app.inject({ method: 'POST', url: '/api/agents/join' })
  assert.equal(res.statusCode, 200, JSON.stringify(res.body))
  const body = res.json() as { token: string; expiresAt: number }
  assert.ok(body.token.length >= 24, 'the token is long enough')
  assert.ok(body.expiresAt > Date.now() && body.expiresAt <= Date.now() + 16 * 60_000, 'a 15-minute expiry window')

  const rows = db.select().from(schema.agentJoinToken).all()
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.tokenHash, sha256(body.token), 'the DB stores the hash, never the plaintext')
  assert.ok(audits.includes('agent_join_issued'), 'issuing is audited')
})

test('Capability four M1-2: register exchanges a one-time join token for an agent identity (the token hash lands in the DB)', async () => {
  const { db } = openDb(':memory:')
  const audits: string[] = []
  const app = buildApp(db, async () => {}, audits)
  const join = ((await app.inject({ method: 'POST', url: '/api/agents/join' })).json() as { token: string }).token

  const res = await app.inject({
    method: 'POST',
    url: '/api/internal/agents/register',
    payload: { joinToken: join, hostname: 'srv-b', os: 'linux', arch: 'amd64', nodeVersion: '22.23.2' },
  })
  assert.equal(res.statusCode, 200, JSON.stringify(res.body))
  const body = res.json() as { agentId: string; agentToken: string }
  assert.match(body.agentId, /^agent-/, 'the agent id prefix')
  assert.ok(body.agentToken.length >= 32)

  const rows = db.select().from(schema.agentMachine).all()
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.hostname, 'srv-b')
  assert.equal(rows[0]?.tokenHash, sha256(body.agentToken), 'the agent token is stored as a hash only')
  assert.equal(rows[0]?.revokedAt, null)
  assert.ok(audits.includes('agent_registered'), 'registration is audited')

  // One-time: reusing the same join token = rejected
  const again = await app.inject({
    method: 'POST',
    url: '/api/internal/agents/register',
    payload: { joinToken: join, hostname: 'evil', os: 'linux', arch: 'amd64', nodeVersion: '22' },
  })
  assert.equal(again.statusCode, 401, 'the join token is one-time')
  assert.equal((again.json() as { error: string }).error, 'join_token_invalid')
})

test('Capability four M1-2: register rejects an invalid/expired join token; a malformed payload is 400', async () => {
  const { db } = openDb(':memory:')
  const app = buildApp(db)

  const bad = await app.inject({
    method: 'POST',
    url: '/api/internal/agents/register',
    payload: { joinToken: 'nope-not-a-token', hostname: 'x', os: 'linux', arch: 'amd64', nodeVersion: '22' },
  })
  assert.equal(bad.statusCode, 401, 'an invalid token is rejected')

  // An expired token: write one straight into the DB with a past expiry
  const expired = 'expired-token-value'
  db.insert(schema.agentJoinToken).values({ tokenHash: sha256(expired), expiresAt: Date.now() - 1_000, usedAt: null, createdAt: Date.now() }).run()
  const exp = await app.inject({
    method: 'POST',
    url: '/api/internal/agents/register',
    payload: { joinToken: expired, hostname: 'x', os: 'linux', arch: 'amd64', nodeVersion: '22' },
  })
  assert.equal(exp.statusCode, 401, 'an expired token is rejected')

  const malformed = await app.inject({ method: 'POST', url: '/api/internal/agents/register', payload: { joinToken: 'x' } })
  assert.equal(malformed.statusCode, 400, 'a missing field is 400')
})

test('Capability four M1-2: revoke retires an agent (inside the requireUser gate; an unknown id is 404)', async () => {
  const { db } = openDb(':memory:')
  const audits: string[] = []
  const app = buildApp(db, async () => {}, audits)
  const join = ((await app.inject({ method: 'POST', url: '/api/agents/join' })).json() as { token: string }).token
  const registered = await app.inject({
    method: 'POST',
    url: '/api/internal/agents/register',
    payload: { joinToken: join, hostname: 'srv-c', os: 'windows', arch: 'x64', nodeVersion: '22.23.2' },
  })
  const agentId = (registered.json() as { agentId: string }).agentId

  const revoke = await app.inject({ method: 'POST', url: `/api/agents/${agentId}/revoke` })
  assert.equal(revoke.statusCode, 200, JSON.stringify(revoke.body))
  const row = db.select().from(schema.agentMachine).where(eq(schema.agentMachine.id, agentId)).all()[0]
  assert.ok(row !== undefined && row.revokedAt !== null, 'the revocation lands in the DB')
  assert.ok(audits.includes('agent_revoked'), 'revocation is audited')

  const missing = await app.inject({ method: 'POST', url: '/api/agents/agent-nope/revoke' })
  assert.equal(missing.statusCode, 404)
})

test('Fleet UI wrap-up B: deleting a machine record -- only a revoked one can be deleted; machine+commands go with it, billing is untouched; audited', async () => {
  const { db } = openDb(':memory:')
  const audits: string[] = []
  const app = buildApp(db, async () => {}, audits)
  const join = ((await app.inject({ method: 'POST', url: '/api/agents/join' })).json() as { token: string }).token
  const registered = await app.inject({
    method: 'POST',
    url: '/api/internal/agents/register',
    payload: { joinToken: join, hostname: 'old-box', os: 'windows', arch: 'x64', nodeVersion: '22.23.2' },
  })
  const agentId = (registered.json() as { agentId: string }).agentId
  // Insert one command history row
  db.insert(schema.agentCommand).values({ agentId, type: 'node.spawn', payload: '{}', state: 'done', result: '{}', createdAt: Date.now() }).run()

  // Not revoked -> 409
  const notRevoked = await app.inject({ method: 'POST', url: `/api/agents/${agentId}/delete` })
  assert.equal(notRevoked.statusCode, 409, JSON.stringify(notRevoked.body))
  assert.equal((notRevoked.json() as { error: string }).error, 'agent_not_revoked', 'a live identity must not be deleted by mistake')

  // After revocation -> the delete succeeds, and the machine row and command history go with it
  await app.inject({ method: 'POST', url: `/api/agents/${agentId}/revoke` })
  const del = await app.inject({ method: 'POST', url: `/api/agents/${agentId}/delete` })
  assert.equal(del.statusCode, 200, JSON.stringify(del.body))
  assert.equal(db.select().from(schema.agentMachine).all().length, 0, 'the machine row is gone')
  assert.equal(db.select().from(schema.agentCommand).all().length, 0, 'the command history went with it')
  assert.ok(audits.includes('agent_deleted'), 'deletion is audited')

  const again = await app.inject({ method: 'POST', url: `/api/agents/${agentId}/delete` })
  assert.equal(again.statusCode, 404, 'a second delete is 404')
})

test('Capability four M4-3: version negotiation -- registration stores agentVersion; the heartbeat refreshes it; the list exposes agentVersion + managerVersion', async () => {
  const { db } = openDb(':memory:')
  const app = buildApp(db)
  const join = ((await app.inject({ method: 'POST', url: '/api/agents/join' })).json() as { token: string }).token
  const registered = await app.inject({
    method: 'POST',
    url: '/api/internal/agents/register',
    payload: { joinToken: join, hostname: 'srv-f', os: 'linux', arch: 'amd64', nodeVersion: '22.23.2', agentVersion: '1.0.0' },
  })
  const { agentId, agentToken } = registered.json() as { agentId: string; agentToken: string }
  let row = db.select().from(schema.agentMachine).where(eq(schema.agentMachine.id, agentId)).all()[0]
  assert.equal(row?.agentVersion, '1.0.0', 'registration reports the version')

  await app.inject({
    method: 'POST',
    url: `/api/internal/agents/${agentId}/events`,
    headers: { authorization: `Bearer ${agentToken}` },
    payload: { events: [{ type: 'heartbeat', detail: { agentVersion: '1.1.2' } }] },
  })
  row = db.select().from(schema.agentMachine).where(eq(schema.agentMachine.id, agentId)).all()[0]
  assert.equal(row?.agentVersion, '1.1.2', 'the heartbeat refreshes the version (a self-update reports the new one)')

  const list = await app.inject({ method: 'GET', url: '/api/agents' })
  const body = list.json() as { agents: Array<{ agentVersion: string | null }>; managerVersion: string }
  assert.equal(body.agents[0]?.agentVersion, '1.1.2')
  assert.match(body.managerVersion, /^\d+\.\d+\.\d+/, 'the list carries the manager version (the frontend compares badges with it)')
})

test('Capability four M4-3: the update endpoint -- a live machine gets an agent.update command queued (both files + a checksum); offline is 409', async () => {
  const { db } = openDb(':memory:')
  const audits: string[] = []
  const app = buildApp(db, async () => {}, audits)
  const join = ((await app.inject({ method: 'POST', url: '/api/agents/join' })).json() as { token: string }).token
  const registered = await app.inject({
    method: 'POST',
    url: '/api/internal/agents/register',
    payload: { joinToken: join, hostname: 'srv-g', os: 'linux', arch: 'amd64', nodeVersion: '22.23.2' },
  })
  const agentId = (registered.json() as { agentId: string }).agentId

  const upd = await app.inject({ method: 'POST', url: `/api/agents/${agentId}/update` })
  assert.equal(upd.statusCode, 200, JSON.stringify(upd.body))
  const cmd = db.select().from(schema.agentCommand).all().find((c) => c.type === 'agent.update')
  assert.ok(cmd !== undefined, 'agent.update is queued')
  const payload = JSON.parse(cmd.payload) as { files: Record<string, string>; sha256: string; managerVersion: string }
  assert.equal(typeof payload.files['runtime.mjs'], 'string')
  assert.ok((payload.files['runtime.mjs'] ?? '').length > 1000, 'runtime.mjs travels with the payload')
  assert.equal(typeof payload.files['agent.mjs'], 'string')
  assert.ok((payload.files['agent.mjs'] ?? '').length > 100, 'agent.mjs travels with the payload')
  assert.equal(typeof payload.files['update.mjs'], 'string', 'update.mjs travels with the payload (the entry depends on it)')
  const digest = createHash('sha256').update(Object.keys(payload.files).sort().map((name) => `${name}:${payload.files[name]}`).join('\n')).digest('hex')
  assert.equal(payload.sha256, digest, 'the checksum = the digest of the name:content pairs joined after sorting by file name')
  assert.ok(audits.includes('agent_update_requested'), 'the update request is audited')

  db.update(schema.agentMachine).set({ lastSeenAt: Date.now() - 120_000 }).where(eq(schema.agentMachine.id, agentId)).run()
  const off = await app.inject({ method: 'POST', url: `/api/agents/${agentId}/update` })
  assert.equal(off.statusCode, 409, 'an offline machine gets no update delivery (the command would be lost)')
})

test('Capability four M4-4: heartbeat metrics land in the DB + the list carries the latest snapshot + anything older than 7 days is pruned', async () => {
  const { db } = openDb(':memory:')
  const app = buildApp(db)
  const join = ((await app.inject({ method: 'POST', url: '/api/agents/join' })).json() as { token: string }).token
  const registered = await app.inject({
    method: 'POST',
    url: '/api/internal/agents/register',
    payload: { joinToken: join, hostname: 'srv-h', os: 'linux', arch: 'amd64', nodeVersion: '22.23.2' },
  })
  const { agentId, agentToken } = registered.json() as { agentId: string; agentToken: string }

  const beat = await app.inject({
    method: 'POST',
    url: `/api/internal/agents/${agentId}/events`,
    headers: { authorization: `Bearer ${agentToken}` },
    payload: { events: [{ type: 'heartbeat', detail: { agentVersion: '1.1.2', metrics: { cpuPercentTenths: 125, memTotal: 16_000_000_000, memUsed: 8_000_000_000, diskTotal: 500_000_000_000, diskFree: 200_000_000_000, uptime: 3600, platform: 'linux' } } }] },
  })
  assert.equal(beat.statusCode, 200)
  const rows = db.select().from(schema.agentMetric).all()
  assert.equal(rows.length, 1, 'the metric lands in the DB')
  assert.equal(rows[0]?.cpuPercent, 125, 'CPU as an integer x10 (125 = 12.5%)')
  assert.equal(rows[0]?.memUsed, 8_000_000_000)

  const list = await app.inject({ method: 'GET', url: '/api/agents' })
  const body = list.json() as { agents: Array<{ id: string; latestMetric: { cpuPercent: number } | null }> }
  assert.equal(body.agents.find((a) => a.id === agentId)?.latestMetric?.cpuPercent, 125, 'the list carries the latest snapshot')

  const series = await app.inject({ method: 'GET', url: `/api/agents/${agentId}/metrics` })
  const sbody = series.json() as { metrics: Array<{ cpuPercent: number }>; latest: { cpuPercent: number } | null }
  assert.equal(sbody.metrics.length, 1, 'the trend endpoint returns the series')
  assert.equal(sbody.latest?.cpuPercent, 125)

  // Pruning past 7 days: insert a stale metric from 8 days ago, send one more heartbeat -> the old row is gone
  db.insert(schema.agentMetric).values({ agentId, at: Date.now() - 8 * 24 * 60 * 60 * 1000, cpuPercent: 990, memTotal: 1, memUsed: 1, diskTotal: 1, diskFree: 1, uptime: 1, platform: 'linux' }).run()
  await app.inject({
    method: 'POST',
    url: `/api/internal/agents/${agentId}/events`,
    headers: { authorization: `Bearer ${agentToken}` },
    payload: { events: [{ type: 'heartbeat', detail: { metrics: { cpuPercentTenths: 130, memTotal: 1, memUsed: 1, diskTotal: 1, diskFree: 1, uptime: 1, platform: 'linux' } } }] },
  })
  const after = db.select().from(schema.agentMetric).all()
  assert.equal(after.some((r) => r.cpuPercent === 990), false, 'the expired metric was pruned')
  assert.ok(after.some((r) => r.cpuPercent === 130), 'the new metric is kept')
})

test('Capability four M4-1: rotating the agent token -- only a live machine can rotate, the old token works through the grace period, and it dies after the ack', async () => {
  const { db } = openDb(':memory:')
  const audits: string[] = []
  const app = buildApp(db, async () => {}, audits)
  const join = ((await app.inject({ method: 'POST', url: '/api/agents/join' })).json() as { token: string }).token
  const registered = await app.inject({
    method: 'POST',
    url: '/api/internal/agents/register',
    payload: { joinToken: join, hostname: 'srv-d', os: 'linux', arch: 'amd64', nodeVersion: '22.23.2' },
  })
  const { agentId, agentToken: oldToken } = registered.json() as { agentId: string; agentToken: string }

  const rot = await app.inject({ method: 'POST', url: `/api/agents/${agentId}/rotate` })
  assert.equal(rot.statusCode, 200, JSON.stringify(rot.body))
  assert.ok((rot.json() as { ok: boolean }).ok)
  // The new token never goes back to the browser -- it reaches the agent only through a config.deliver command (the test reads it from the command payload)
  const cmd0 = db.select().from(schema.agentCommand).all().find((c) => c.type === 'config.deliver')
  const newToken = (JSON.parse(cmd0?.payload ?? '{}') as { agentToken?: string }).agentToken
  assert.ok(typeof newToken === 'string' && newToken.length >= 32, 'the new token is in the command payload')
  const row = db.select().from(schema.agentMachine).where(eq(schema.agentMachine.id, agentId)).all()[0]
  assert.equal(row?.tokenHash, sha256(newToken!), 'the primary token is renewed (hash only)')
  assert.equal(row?.prevTokenHash, sha256(oldToken), 'the old token moves into the grace slot')
  assert.ok(audits.includes('agent_token_rotated'), 'the rotation is audited')

  const auth = (token: string): Promise<number> =>
    app.inject({ method: 'GET', url: `/api/internal/agents/${agentId}/commands`, headers: { authorization: `Bearer ${token}` } }).then((r) => r.statusCode)
  assert.equal(await auth(newToken!), 200, 'the new token works immediately')
  assert.equal(await auth(oldToken), 200, 'the old token still works during the grace period (a lost ack must not brick the machine)')

  // Delivery ack: the agent reports config.deliver success -> the grace slot is cleared -> the old token dies
  const cmd = cmd0
  assert.ok(cmd !== undefined, 'a rotation = one config.deliver command queued')
  const ack = await app.inject({
    method: 'POST',
    url: `/api/internal/agents/${agentId}/events`,
    headers: { authorization: `Bearer ${newToken}` },
    payload: { events: [{ type: 'command_result', commandId: cmd.id, ok: true, result: {} }] },
  })
  assert.equal(ack.statusCode, 200)
  const after = db.select().from(schema.agentMachine).where(eq(schema.agentMachine.id, agentId)).all()[0]
  assert.equal(after?.prevTokenHash, null, 'the grace slot is cleared after the ack')
  assert.equal(await auth(oldToken), 401, 'the old token no longer works after that')
})

test('Capability four M4-1: rotating an offline machine is 409 agent_offline; a failed apply rolls back to the old token', async () => {
  const { db } = openDb(':memory:')
  const app = buildApp(db)
  const join = ((await app.inject({ method: 'POST', url: '/api/agents/join' })).json() as { token: string }).token
  const registered = await app.inject({
    method: 'POST',
    url: '/api/internal/agents/register',
    payload: { joinToken: join, hostname: 'srv-e', os: 'linux', arch: 'amd64', nodeVersion: '22.23.2' },
  })
  const { agentId, agentToken: oldToken } = registered.json() as { agentId: string; agentToken: string }
  // Mark it offline (lastSeenAt more than 90s old)
  db.update(schema.agentMachine).set({ lastSeenAt: Date.now() - 120_000 }).where(eq(schema.agentMachine.id, agentId)).run()
  const off = await app.inject({ method: 'POST', url: `/api/agents/${agentId}/rotate` })
  assert.equal(off.statusCode, 409, JSON.stringify(off.body))
  assert.equal((off.json() as { error: string }).error, 'agent_offline', 'an offline machine refuses rotation (no bricking)')

  // Rotate again once it is back online; the agent reports a failed apply -> roll back
  db.update(schema.agentMachine).set({ lastSeenAt: Date.now() }).where(eq(schema.agentMachine.id, agentId)).run()
  const rot = await app.inject({ method: 'POST', url: `/api/agents/${agentId}/rotate` })
  assert.equal(rot.statusCode, 200)
  const cmd = db.select().from(schema.agentCommand).all().find((c) => c.type === 'config.deliver')
  const newToken = (JSON.parse(cmd?.payload ?? '{}') as { agentToken?: string }).agentToken
  // The real sequence: the agent picks the command up by long poll (delivered) and only then reports the result
  const claim = await app.inject({
    method: 'GET',
    url: `/api/internal/agents/${agentId}/commands?wait=0`,
    headers: { authorization: `Bearer ${newToken!}` },
  })
  assert.equal(claim.statusCode, 200)
  await app.inject({
    method: 'POST',
    url: `/api/internal/agents/${agentId}/events`,
    headers: { authorization: `Bearer ${newToken!}` },
    payload: { events: [{ type: 'command_result', commandId: cmd!.id, ok: false, result: { message: 'apply failed' } }] },
  })
  const after = db.select().from(schema.agentMachine).where(eq(schema.agentMachine.id, agentId)).all()[0]
  assert.equal(after?.tokenHash, sha256(oldToken), 'a failed apply rolls the primary token back')
  assert.equal(after?.prevTokenHash, null)
})

