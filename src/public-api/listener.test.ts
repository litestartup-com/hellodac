import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb, type Db } from '../db/index.js'
import type { AppConfig, ResolvedPublicApi } from '../config.js'
import { getPublicApiState, startPublicApi } from './listener.js'

/**
 * 门面监听器的失败语义（设计稿 §3）：门面起不来**绝不能拖垮主服务**，
 * 但也不能悄悄消失——状态必须可查询。
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

test('门面: enabled=false 时不起监听，状态可查（"API 没开"是合法状态）', async () => {
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

test('门面: 绑定成功后可真正探活（port=0 取随机端口）', async () => {
  const handle = await startPublicApi({
    config: config({ enabled: true, host: '127.0.0.1', port: 0 }),
    db: db(),
    log: () => undefined,
  })
  assert.ok(handle !== null, '应当起得来')
  const state = getPublicApiState()
  assert.equal(state.status, 'listening')
  assert.ok(state.port > 0)

  const res = await fetch(`http://127.0.0.1:${state.port}/v1/health`)
  assert.equal(res.status, 200)
  const body = (await res.json()) as { ok: boolean }
  assert.equal(body.ok, true)

  // 未鉴权访问受保护路由仍然 401（端口开了不等于门开了）
  const guarded = await fetch(`http://127.0.0.1:${state.port}/v1/services`)
  assert.equal(guarded.status, 401)

  await handle?.close()
})

test('门面: 绑定失败不抛异常、不拖垮主服务，但状态标 failed 且日志有 error', async () => {
  const lines: Array<{ line: string; level: string | undefined }> = []
  const handle = await startPublicApi({
    // 192.0.2.0/24 是 TEST-NET-1（保留给文档），本机不可绑 → 必然 EADDRNOTAVAIL
    config: config({ enabled: true, host: '192.0.2.1', port: 0 }),
    db: db(),
    log: (line, level) => lines.push({ line, level }),
  })
  assert.equal(handle, null, '失败返回 null，调用方无需分支')
  assert.equal(getPublicApiState().status, 'failed')
  assert.ok((getPublicApiState().detail ?? '').length > 0, '失败原因要可查')
  assert.ok(lines.some((l) => l.level === 'error'), '必须有一条 error 日志')
})
