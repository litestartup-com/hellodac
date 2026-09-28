import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb, type Db } from '../db/index.js'
import type { AppConfig, ResolvedPublicApi } from '../config.js'
import { getPublicApiState, startPublicApi } from './listener.js'

/**
 * Failure semantics of the facade listener (design §3): a facade that cannot start **must never drag
 * the main service down**, but it must not vanish silently either -- its state has to be queryable.
 */
const config = (publicApi: ResolvedPublicApi): AppConfig => ({
  listen: { host: '127.0.0.1', port: 8080 },
  endpoints: {},
  agents: {},
  services: [],
  runner: { timeoutMs: 1000, silenceMs: 0, maxConsecutiveFailures: 3, dailyBudgetMicroUsd: null },
  databasePath: ':memory:',
  pricing: { rates: {}, peakWindows: [] },
  sessionSecret: 'x'.repeat(32),
  initialUser: { username: 'admin', password: null },
  warnings: [],
  publicApi,
})

const db = (): Db => openDb(':memory:').db

test('Facade: with enabled=false no listener starts and the state is queryable (an API that is off is a legal state)', async () => {
  const lines: string[] = []
  const handle = await startPublicApi({
    config: config({ enabled: false, host: '127.0.0.1', port: 0 }),
    db: db(),
    log: (line) => lines.push(line),
  })
  assert.equal(handle, null)
  assert.equal(getPublicApiState().status, 'disabled')
  assert.ok(lines.some((l) => /disabled/.test(l)))
})

test('Facade: once bound it can really be probed (port=0 takes a random port)', async () => {
  const handle = await startPublicApi({
    config: config({ enabled: true, host: '127.0.0.1', port: 0 }),
    db: db(),
    log: () => undefined,
  })
  assert.ok(handle !== null, 'it should come up')
  const state = getPublicApiState()
  assert.equal(state.status, 'listening')
  assert.ok(state.port > 0)

  const res = await fetch(`http://127.0.0.1:${state.port}/v1/health`)
  assert.equal(res.status, 200)
  const body = (await res.json()) as { ok: boolean }
  assert.equal(body.ok, true)

  // An unauthenticated call to a protected route still gets 401 (an open port is not an open door)
  const guarded = await fetch(`http://127.0.0.1:${state.port}/v1/services`)
  assert.equal(guarded.status, 401)

  await handle?.close()
})

test('Facade: a failed bind throws nothing and drags nothing down, but the state says failed and the log has an error', async () => {
  const lines: Array<{ line: string; level: string | undefined }> = []
  const handle = await startPublicApi({
    // 192.0.2.0/24 is TEST-NET-1 (reserved for documentation) and cannot be bound locally -> EADDRNOTAVAIL
    config: config({ enabled: true, host: '192.0.2.1', port: 0 }),
    db: db(),
    log: (line, level) => lines.push({ line, level }),
  })
  assert.equal(handle, null, 'a failure returns null, so callers need no branch')
  assert.equal(getPublicApiState().status, 'failed')
  assert.ok((getPublicApiState().detail ?? '').length > 0, 'the failure reason must be queryable')
  assert.ok(lines.some((l) => l.level === 'error'), 'there must be one error log line')
})
