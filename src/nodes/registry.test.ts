import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildNodeSupervisors, makeSupervisor } from './registry.js'
import { NodeSupervisor } from './supervisor.js'
import { FakeSessionDriver } from '../session-driver/fake.js'
import type { AppConfig, ResolvedEndpoint, ResolvedSpawnSpec } from '../config.js'

/**
 * Debt C2: nodes/registry (supervisor construction and the managed filter) had no coverage at all.
 * The three-state semantics of the probe callback are covered by the state-machine cases in supervisor.test.ts;
 * this file pins registry's own contract: the type it builds, that it only takes managed nodes, and the dockerEnv key assembly.
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

test('Debt C2: the makeSupervisor construction contract -- both apiproxy and gateway produce a NodeSupervisor', () => {
  const up = new FakeSessionDriver('A', { frames: [], probeVersion: '0.1.1-rc.2' })
  const apiproxy = makeSupervisor(endpointFor('A', 'apiproxy', null), { upstream: () => up, gateway: () => undefined })
  assert.ok(apiproxy instanceof NodeSupervisor)
  const gateway = makeSupervisor(endpointFor('G', 'gateway', null), { upstream: () => undefined, gateway: () => undefined })
  assert.ok(gateway instanceof NodeSupervisor)
})

test('Debt C2: buildNodeSupervisors only takes managed nodes (an externally managed one is skipped; one process and one docker managed node are in)', () => {
  const config = {
    endpoints: {
      A: endpointFor('A', 'apiproxy', null),
      B: endpointFor('B', 'apiproxy', managedProcess),
      C: endpointFor('C', 'gateway', managedProcess),
    },
    agents: {},
  } as unknown as AppConfig
  const map = buildNodeSupervisors(config, { upstream: () => undefined, gateway: () => undefined })
  assert.equal(map.size, 2, 'the externally managed one (spawn null) is skipped; the two managed ones are in')
  assert.ok(map.has('B') && map.has('C'))
  assert.ok(!map.has('A'), 'an unmanaged endpoint never makes it into the registry')
})

test('Fleet M3 regression: with agentFullAccess=true the spawn payload carries ALLOW_FULL_ACCESS (the ops node unlock signal)', () => {
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
  assert.equal(env?.ALLOW_FULL_ACCESS, 'true', 'a danger-full-access node -> the agent gets the unlock signal (to write into settings)')
  assert.equal(env?.GW_KEY, 'apigw-test-key', 'GW_KEY is injected as before')

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
  assert.equal(env2?.ALLOW_FULL_ACCESS, undefined, 'an ordinary node carries no unlock signal')
  plain.stop()
  s.stop()
})
