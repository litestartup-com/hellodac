/**
 * S2.5 真实冒烟：用 manager 自己的 upstream 模块直连本机 DSH 的 /api。
 *
 * 顺序：host.describe → session.list → session.create(临时目录 + agentPreset)
 * → [可选 sandbox-mode] → session.history → 订阅 mux + session.prompt(一条最小消息)
 * → 等 turn_end → session.cancel → 清理临时目录。
 *
 * 用法：npx tsx scripts/smoke-apiproxy.ts [base-url] [preset]
 * 默认 base = http://127.0.0.1:3080/api，默认 preset = minimal（蜂群 P0：验证 agentPreset 生效）。
 * sandbox-mode 步骤需要部署了新版 dsh-api-gateway（40fa689 起）：
 *   SMOKE_SANDBOX_BASE=http://127.0.0.1:3080/api-gw/v1 SMOKE_SANDBOX_KEY=<key> npx tsx scripts/smoke-apiproxy.ts
 *
 * 注意：第 6 步会在宿主机真实跑一轮 agent（一次 LLM 调用），消息已压到最小。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UpstreamClient } from '../src/upstream/client.js'
import { waitForFrame } from '../src/upstream/mux.js'
import type { ResolvedEndpoint } from '../src/config.js'
import type { GatewayFrame } from '../src/gateway/stream.js'

const baseArg = process.argv[2] ?? process.env.SMOKE_BASE ?? 'http://127.0.0.1:3080/api'
const presetArg = process.argv[3] ?? process.env.SMOKE_PRESET ?? 'minimal'
const url = baseArg.replace(/\/api\/?$/, '')
const sandboxBase = process.env.SMOKE_SANDBOX_BASE ?? null
const ep: ResolvedEndpoint = {
  id: 'smoke',
  url,
  driver: 'apiproxy',
  prefix: '/api',
  key: '',
  sandboxBase,
  sandboxKey: process.env.SMOKE_SANDBOX_KEY ?? '',
  spawn: null, access: null,
}
const client = new UpstreamClient(ep)

const log = (msg: string): void => console.log('[smoke] ' + msg)
const fail = (msg: string): never => {
  console.error('[smoke] FAIL: ' + msg)
  process.exitCode = 1
  throw new Error(msg)
}

const step = async (name: string, fn: () => Promise<void>): Promise<void> => {
  log('-- ' + name)
  try {
    await fn()
  } catch (error) {
    fail(name + ': ' + (error as Error).message)
  }
}

const framesSeen: string[] = []
const kinds = new Set<string>()

await step('host.describe（版本探测）', async () => {
  const version = await client.probeVersion()
  if (version === 'unknown' || version === '') fail('host.describe returned no version')
  log('DSH version: ' + version)
})

await step('session.list', async () => {
  const list = await client.listSessions()
  log('sessions: ' + list.length)
  for (const s of list.slice(0, 5)) log('  - ' + s.sessionId + ' title=' + (s.title ?? '(none)'))
})

const tmpDir = mkdtempSync(join(tmpdir(), 'manager-smoke-'))

let sessionId = ''
try {
  await step('session.create（临时 cwd + agentPreset）', async () => {
    const created = await client.createSession(tmpDir, presetArg)
    if (created.sessionId === '') fail('empty sessionId')
    sessionId = created.sessionId
    log('created session ' + sessionId + ' agentPreset=' + (created.preset ?? '(none)'))
    if (created.preset !== presetArg) fail(`agentPreset echo mismatch: got ${String(created.preset)}, want ${presetArg}`)
  })

  if (sandboxBase !== null) {
    await step('sandbox-mode（workspace-write，经新版 gateway 路由）', async () => {
      await client.setSandboxMode(sessionId, 'workspace-write')
      log('sandbox-mode pinned: workspace-write')
    })
  } else {
    log('-- sandbox-mode skipped: SMOKE_SANDBOX_BASE not set (needs dsh-api-gateway >= 40fa689 deployed)')
  }

  await step('session.history（新会话应为空）', async () => {
    const history = await client.history(sessionId)
    log('events=' + history.events.length + ' state=' + history.sessionState + ' title=' + (history.title ?? '(none)'))
  })

  await step('mux 订阅 + session.prompt（最小消息，等 turn_end）', async () => {
    const unsub = client.subscribe(sessionId, (_sid: string, frame: GatewayFrame) => {
      framesSeen.push(frame.kind)
      kinds.add(frame.kind)
    })

    let turnEnd: GatewayFrame | null = null
    try {
      const accepted = await client.prompt(sessionId, 'Reply with exactly one word: ok')
      if (!accepted.accepted) fail('prompt not accepted')
      log('prompt accepted; waiting for turn_end (timeout 120s)...')
      turnEnd = await waitForFrame(client.endpoint, sessionId, 'turn_end', 120_000)
      log('turn_end: reason=' + String(turnEnd.reason))
    } finally {
      unsub()
    }
    log('frames seen (' + framesSeen.length + '): ' + framesSeen.join(', '))
    const required = ['turn_start', 'turn_end']
    for (const kind of required) {
      if (!kinds.has(kind)) fail('missing ' + kind + ' frame (got: ' + [...kinds].join(', ') + ')')
    }
    if (!kinds.has('message') && !kinds.has('chunk')) log('warning: no assistant message/chunk frames seen')
  })

  await step('session.cancel（收尾）', async () => {
    await client.cancel(sessionId)
    log('cancel ok')
  })
} finally {
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* 临时目录清理失败不影响结果 */ }
  log('cleaned ' + tmpDir)
}

log('ALL SMOKE STEPS PASSED')
