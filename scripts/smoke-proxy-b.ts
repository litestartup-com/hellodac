/**
 * S3-3 acceptance smoke: the manager takes the proxy path (Option B) and reaches the local DSH /api indirectly through the new gateway plugin.
 *
 * Prerequisite: start scripts/proxy-host.mjs first (in the dsh-api-gateway repo), listening on 127.0.0.1:3999.
 *
 * Order: host.describe → session.list → 403 allowlist / 401 auth negative cases →
 * session.create → session.history → mux subscribe (over the proxied WS) + session.prompt → turn_end →
 * session.cancel → cleanup.
 *
 * Usage: npx tsx scripts/smoke-proxy-b.ts [proxy-url]
 * Default proxy = http://127.0.0.1:3999/api-gw/v1/proxy, key = smoke-key (SMOKE_KEY overrides).
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UpstreamClient } from '../src/upstream/client.js'
import { waitForFrame } from '../src/upstream/mux.js'
import type { ResolvedEndpoint } from '../src/config.js'
import type { GatewayFrame } from '../src/gateway/stream.js'

const baseArg = process.argv[2] ?? 'http://127.0.0.1:3999/api-gw/v1/proxy'
const key = process.env.SMOKE_KEY ?? 'smoke-key'
const url = baseArg.replace(/\/api-gw\/v1\/proxy\/?$/, '')
const ep: ResolvedEndpoint = { id: 'proxy-smoke', url, driver: 'apiproxy', prefix: '/api-gw/v1/proxy', key, sandboxBase: null, sandboxKey: '', spawn: null, access: null }
const client = new UpstreamClient(ep)

const log = (msg: string): void => console.log('[smoke-b] ' + msg)
const fail = (msg: string): never => {
  console.error('[smoke-b] FAIL: ' + msg)
  process.exitCode = 1
  throw new Error(msg)
}

const step = async (name: string, fn: () => Promise<void>): Promise<void> => {
  log('-- ' + name)
  try { await fn() } catch (error) { fail(name + ': ' + (error as Error).message) }
}

// Negative cases (plain fetch, not through UpstreamClient): 403 outside the allowlist, 401 on a wrong key, health needs no auth.
const proxyRoot = baseArg.replace(/\/api-gw\/v1\/proxy\/?$/, '')
await step('negative cases: 403 outside the allowlist / 401 on a wrong key / health open', async () => {
  const blocked = await fetch(proxyRoot + '/api-gw/v1/proxy/credentials.set', {
    method: 'POST', headers: { 'x-api-key': key, 'content-type': 'application/json' }, body: '{}',
  })
  if (blocked.status !== 403) fail('credentials.set should be 403, got ' + blocked.status)
  const denied = await fetch(proxyRoot + '/api-gw/v1/proxy/session.list', {
    method: 'POST', headers: { 'x-api-key': 'wrong-key', 'content-type': 'application/json' }, body: '{}',
  })
  if (denied.status !== 401) fail('wrong key should be 401, got ' + denied.status)
  const health = await fetch(proxyRoot + '/api-gw/v1/health')
  if (health.status !== 200) fail('health should be 200, got ' + health.status)
  const healthBody = await health.json() as { status?: string; upstream?: string }
  log('health: status=' + healthBody.status + ' upstream=' + healthBody.upstream)
})

await step('host.describe (through the proxy)', async () => {
  const version = await client.probeVersion()
  log('DSH version (via proxy): ' + version)
})

await step('session.list (through the proxy)', async () => {
  const list = await client.listSessions()
  log('sessions: ' + list.length)
})

const tmpDir = mkdtempSync(join(tmpdir(), 'manager-smoke-b-'))
let sessionId = ''
try {
  await step('session.create (through the proxy, temporary cwd)', async () => {
    const created = await client.createSession(tmpDir, null)
    sessionId = created.sessionId
    log('created session ' + sessionId)
  })

  await step('session.history (through the proxy)', async () => {
    const history = await client.history(sessionId)
    log('events=' + history.events.length)
  })

  await step('mux subscribe (proxied WS) + session.prompt → turn_end', async () => {
    const kinds = new Set<string>()
    const unsub = client.subscribe(sessionId, (_sid: string, frame: GatewayFrame) => { kinds.add(frame.kind) })
    try {
      const accepted = await client.prompt(sessionId, 'Reply with exactly one word: ok')
      if (!accepted.accepted) fail('prompt not accepted')
      log('prompt accepted; waiting for turn_end (timeout 120s)...')
      const turnEnd = await waitForFrame(client.endpoint, sessionId, 'turn_end', 120_000)
      log('turn_end: reason=' + String(turnEnd.reason))
      if (!kinds.has('turn_start') || !kinds.has('message')) fail('missing frames (got: ' + [...kinds].join(', ') + ')')
      log('frame kinds: ' + [...kinds].join(', '))
    } finally {
      unsub()
    }
  })

  await step('session.cancel (through the proxy)', async () => {
    await client.cancel(sessionId)
    log('cancel ok')
  })
} finally {
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* a failed cleanup does not affect the result */ }
}

log('ALL PROXY SMOKE STEPS PASSED (Option B)')
