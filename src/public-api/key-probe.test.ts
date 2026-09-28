import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { mintApiKey, type KeyScope } from '../auth/api-key.js'
import type { AppConfig } from '../config.js'
import { openDb, type Db } from '../db/index.js'
import { probeApiKey } from './key-probe.js'

/**
 * "Does this key work?" -- answered by calling the outward door for real, against a stub facade here.
 *
 * What these tests pin is the distinction the operator actually needs: "the door is down" and "the key
 * is wrong" are different phone calls, and a key that is accepted but can reach no service is a third.
 */

interface Door {
  url: string
  close: () => Promise<void>
  calls: string[]
}

/** A stub facade: answers health/services/usage the way listener.ts does, with injectable statuses. */
const startDoor = async (opts: { get: (path: string, auth: string | undefined) => { status: number; body: unknown } }): Promise<Door> => {
  const calls: string[] = []
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    calls.push(path)
    const result = opts.get(path, req.headers.authorization)
    res.writeHead(result.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(result.body))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()) }),
  }
}

const config = (services: Array<{ id: string; label: string }>): AppConfig =>
  ({ services: services.map((s) => ({ ...s, workers: ['svc-1'], surfaces: ['conversations'], knowledge: [] })) }) as unknown as AppConfig

const listenerAt = (url: string): { status: string; host: string; port: number; detail: string | null } => {
  const parsed = new URL(url)
  return { status: 'listening', host: parsed.hostname, port: Number(parsed.port), detail: null }
}

const mint = (db: Db, scopes: KeyScope[], scopeServices: string[] = ['chat']) =>
  mintApiKey(db, { name: 'probe subject', scopes, scopeServices, createdBy: 'test' }).token

test('key probe: a healthy door reports each step and the services this key can actually reach', async () => {
  const { db } = openDb(':memory:')
  const token = mint(db, ['services:read', 'usage:read'])
  const door = await startDoor({
    get: (path, auth) => {
      if (path === '/v1/health') return { status: 200, body: { ok: true } }
      if (auth !== `Bearer ${token}`) return { status: 401, body: { error: 'unauthorized' } }
      if (path === '/v1/services') return { status: 200, body: { services: [{ id: 'chat' }] } }
      if (path === '/v1/usage') return { status: 200, body: { today: { used: 3, limit: 50 } } }
      return { status: 404, body: { error: 'not_found' } }
    },
  })

  try {
    const result = await probeApiKey({ db, config: config([{ id: 'chat', label: 'Support' }]), token, listener: listenerAt(door.url) })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.deepEqual(door.calls, ['/v1/health', '/v1/services', '/v1/usage'], 'the probe goes through the outward door, read-only')
    assert.match(result.steps[1]?.detail ?? '', /can reach: chat/)
    assert.match(result.steps[2]?.detail ?? '', /today 3\/50/)
  } finally {
    await door.close()
  }
})

test('key probe: a door that is down is reported as the door, not as a bad key', async () => {
  const { db } = openDb(':memory:')
  const token = mint(db, ['services:read'])
  // Port 1 is not listening: ECONNREFUSED.
  const result = await probeApiKey({
    db,
    config: config([{ id: 'chat', label: 'Support' }]),
    token,
    listener: { status: 'listening', host: '127.0.0.1', port: 1, detail: null },
  })
  assert.equal(result.ok, false)
  assert.match(result.notes.join('\n'), /nothing answered at the outward address/)
})

test('key probe: a key the manager would reject is named (revoked / unknown), with no further calls', async () => {
  const { db } = openDb(':memory:')
  const door = await startDoor({
    get: (path) => (path === '/v1/health' ? { status: 200, body: { ok: true } } : { status: 401, body: { error: 'unauthorized' } }),
  })
  try {
    const result = await probeApiKey({
      db,
      config: config([{ id: 'chat', label: 'Support' }]),
      token: 'dac_000000000000_' + 'x'.repeat(43),
      listener: listenerAt(door.url),
    })
    assert.equal(result.ok, false)
    assert.match(result.steps.at(-1)?.detail ?? '', /this key is unknown/)
    assert.deepEqual(door.calls, ['/v1/health'], 'a key that cannot work is not walked through the other endpoints')
  } finally {
    await door.close()
  }
})

test('key probe: a key scoped to no configured service is flagged as accepted-but-useless', async () => {
  const { db } = openDb(':memory:')
  const token = mint(db, ['services:read'], ['retired-service'])
  const door = await startDoor({
    get: (path, auth) => {
      if (path === '/v1/health') return { status: 200, body: { ok: true } }
      if (auth !== `Bearer ${token}`) return { status: 401, body: { error: 'unauthorized' } }
      return { status: 200, body: { services: [] } }
    },
  })
  try {
    const result = await probeApiKey({ db, config: config([{ id: 'chat', label: 'Support' }]), token, listener: listenerAt(door.url) })
    assert.match(result.steps[1]?.detail ?? '', /can reach no service/)
    assert.match(result.notes.join('\n'), /accepted but can never start a conversation/)
    assert.match(result.notes.join('\n'), /no usage:read scope/)
  } finally {
    await door.close()
  }
})

test('key probe: a disabled or crashed listener says so instead of blaming the key', async () => {
  const { db } = openDb(':memory:')
  const token = mint(db, ['services:read'])
  const disabled = await probeApiKey({
    db,
    config: config([{ id: 'chat', label: 'Support' }]),
    token,
    listener: { status: 'disabled', host: '127.0.0.1', port: 8081, detail: null },
  })
  assert.equal(disabled.ok, false)
  assert.match(disabled.notes.join('\n'), /listener is disabled/)

  const failed = await probeApiKey({
    db,
    config: config([{ id: 'chat', label: 'Support' }]),
    token,
    listener: { status: 'failed', host: '127.0.0.1', port: 8081, detail: 'EADDRINUSE' },
  })
  assert.equal(failed.ok, false)
  assert.match(failed.notes.join('\n'), /EADDRINUSE/)
})
