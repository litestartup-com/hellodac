import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildNodeSupervisors, makeSupervisor } from './registry.js'
import { NodeSupervisor } from './supervisor.js'
import { FakeSessionDriver } from '../session-driver/fake.js'
import type { AppConfig, ResolvedEndpoint, ResolvedSpawnSpec } from '../config.js'

/**
 * 债务 C2:nodes/registry(监督器构造与托管过滤)此前零覆盖。
 * probe 回调的三态语义由 supervisor.test.ts 的状态机用例覆盖;本文件锁定
 * registry 自身的契约:构造产物类型、只收托管节点、dockerEnv 密钥组装边界。
 */

const endpointFor = (id: string, driver: 'gateway' | 'apiproxy', spawn: ResolvedEndpoint['spawn']): ResolvedEndpoint => ({
  id,
  url: 'http://127.0.0.1:1',
  driver,
  prefix: driver === 'apiproxy' ? '/api' : '/api-gw/v1',
  key: '',
  sandboxBase: null,
  sandboxKey: 'apigw-test-key',
  spawn,
  access: null,
})

const managedProcess: ResolvedEndpoint['spawn'] = {
  managed: true,
  command: 'node',
  args: ['x.js'],
  cwd: null,
  readyTimeoutMs: 30_000,
  detached: false,
  logFile: null,
  env: {},
  restart: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 30_000 },
  runner: 'process',
  host: null,
  docker: null,
}

test('债务 C2: makeSupervisor 构造契约——apiproxy/gateway 均产出 NodeSupervisor', () => {
  const up = new FakeSessionDriver('A', { frames: [], probeVersion: '0.1.1-rc.2' })
  const apiproxy = makeSupervisor(endpointFor('A', 'apiproxy', null), { upstream: () => up, gateway: () => undefined })
  assert.ok(apiproxy instanceof NodeSupervisor)
  const gateway = makeSupervisor(endpointFor('G', 'gateway', null), { upstream: () => undefined, gateway: () => undefined })
  assert.ok(gateway instanceof NodeSupervisor)
})

test('债务 C2: buildNodeSupervisors 只收托管节点(外管不收;process/docker managed 各一)', () => {
  const config = {
    endpoints: {
      A: endpointFor('A', 'apiproxy', null),
      B: endpointFor('B', 'apiproxy', managedProcess),
      C: endpointFor('C', 'gateway', managedProcess),
    },
    agents: {},
  } as unknown as AppConfig
  const map = buildNodeSupervisors(config, { upstream: () => undefined, gateway: () => undefined })
  assert.equal(map.size, 2, '外管(spawn null)不收;两个 managed 各一')
  assert.ok(map.has('B') && map.has('C'))
  assert.ok(!map.has('A'), '未托管端点绝不入册')
})

test('舰队 M3 回归: agentFullAccess=true 时 spawn 载荷带 ALLOW_FULL_ACCESS（ops 节点开锁信号）', () => {
  const up = new FakeSessionDriver('A', { frames: [], probeVersion: '0.1.5-rc.2' })
  const enqueued: Array<{ type: string; payload: Record<string, unknown> }> = []
  const agentSpawn = { ...managedProcess, runner: 'agent', host: 'agent-1' } as ResolvedSpawnSpec
  const s = makeSupervisor(endpointFor('A', 'apiproxy', agentSpawn), {
    upstream: () => up,
    gateway: () => undefined,
    agentFullAccess: true,
    agentCommand: (_a, type, payload) => {
      enqueued.push({ type, payload: payload as Record<string, unknown> })
      return enqueued.length
    },
    agentResult: () => () => {},
  })
  s.start(agentSpawn)
  const env = enqueued[0]?.payload.env as Record<string, string> | undefined
  assert.equal(env?.ALLOW_FULL_ACCESS, 'true', 'danger-full-access 节点 → agent 收到开锁信号（写 settings 用）')
  assert.equal(env?.GW_KEY, 'apigw-test-key', 'GW_KEY 照旧注入')

  const plain = makeSupervisor(endpointFor('B', 'apiproxy', agentSpawn), {
    upstream: () => up,
    gateway: () => undefined,
    agentCommand: () => 1,
    agentResult: () => () => {},
  })
  const enqueued2: Array<{ payload: Record<string, unknown> }> = []
  const s2 = makeSupervisor(endpointFor('B', 'apiproxy', agentSpawn), {
    upstream: () => up,
    gateway: () => undefined,
    agentCommand: (_a, _t, payload) => {
      enqueued2.push({ payload: payload as Record<string, unknown> })
      return 1
    },
    agentResult: () => () => {},
  })
  s2.start(agentSpawn)
  const env2 = enqueued2[0]?.payload.env as Record<string, string> | undefined
  assert.equal(env2?.ALLOW_FULL_ACCESS, undefined, '普通节点不带开锁信号')
  plain.stop()
  s.stop()
})
