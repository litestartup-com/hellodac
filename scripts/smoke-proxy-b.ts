/**
 * S3-3 验收冒烟：manager 走 proxy 路径（方案 B），经新网关插件间接访问本机 DSH /api。
 *
 * 前置：先起 scripts/proxy-host.mjs（在 dsh-api-gateway 仓库），监听 127.0.0.1:3999。
 *
 * 顺序：host.describe → session.list → 403 白名单 / 401 鉴权负例 →
 * session.create → session.history → mux 订阅(经代理 WS) + session.prompt → turn_end →
 * session.cancel → 清理。
 *
 * 用法：npx tsx scripts/smoke-proxy-b.ts [proxy-url]
 * 默认 proxy = http://127.0.0.1:3999/api-gw/v1/proxy，key = smoke-key（SMOKE_KEY 覆盖）。
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

// 负例（直接 fetch，不走 UpstreamClient）：白名单外 403、错 key 401、health 无需鉴权。
const proxyRoot = baseArg.replace(/\/api-gw\/v1\/proxy\/?$/, '')
await step('负例：白名单外 403 / 错 key 401 / health 开放', async () => {
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

await step('host.describe（经代理）', async () => {
  const version = await client.probeVersion()
  log('DSH version (via proxy): ' + version)
})

await step('session.list（经代理）', async () => {
  const list = await client.listSessions()
  log('sessions: ' + list.length)
})

const tmpDir = mkdtempSync(join(tmpdir(), 'manager-smoke-b-'))
let sessionId = ''
try {
  await step('session.create（经代理，临时 cwd）', async () => {
    const created = await client.createSession(tmpDir, null)
    sessionId = created.sessionId
    log('created session ' + sessionId)
  })

  await step('session.history（经代理）', async () => {
    const history = await client.history(sessionId)
    log('events=' + history.events.length)
  })

  await step('mux 订阅（经代理 WS）+ session.prompt → turn_end', async () => {
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

  await step('session.cancel（经代理）', async () => {
    await client.cancel(sessionId)
    log('cancel ok')
  })
} finally {
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* 清理失败不影响结果 */ }
}

log('ALL PROXY SMOKE STEPS PASSED (方案 B)')
