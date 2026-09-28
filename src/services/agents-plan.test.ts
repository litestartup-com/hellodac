import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentNames, parseAgentEndpoint, planAgents, type AgentsPlanRequest, type ExistingAgent } from './agents-plan.js'
import type { MachineFacts } from './placement.js'

/**
 * Service agent reconciliation (`services[].count` vs the agents actually running).
 * Cases are written against real outcomes: silent under-provisioning reaches customers as 429; moving agents loses
 * conversations; cutting an agent mid-turn kills work in flight.
 */
const machine = (id: string, over: Partial<MachineFacts> = {}): MachineFacts => ({
  id,
  online: true,
  agentCount: 0,
  services: [],
  hasPrivateAgents: false,
  sessions: 0,
  cpuFreePercent: 80,
  memFreeBytes: 8_000_000_000,
  diskFreeBytes: 50_000_000_000,
  ...over,
})

const plan = (over: Partial<AgentsPlanRequest> = {}) =>
  planAgents({
    serviceId: 'support',
    count: 3,
    placement: 'spread',
    existing: [],
    facts: [machine('a'), machine('b')],
    ...over,
  })

const ordinals = (agents: Array<{ ordinal: number }>): number[] => agents.map((a) => a.ordinal)

test('predictable names: service id plus ordinal derive the endpoint and the agent', () => {
  assert.deepEqual(agentNames('support', 2), { endpointId: 'svc-support-2', agentId: 'support-2' })
})

test('parsing a derived endpoint: recognises service and ordinal, and does not mistake a normal node', () => {
  assert.deepEqual(parseAgentEndpoint('svc-support-2'), { serviceId: 'support', ordinal: 2 })
  assert.deepEqual(parseAgentEndpoint('svc-a-b-2'), { serviceId: 'a-b', ordinal: 2 }, 'service ids may contain dashes, so the ordinal is the last segment')
  assert.equal(parseAgentEndpoint('node-3081'), null)
  assert.equal(parseAgentEndpoint('svc-support'), null)
  assert.equal(parseAgentEndpoint('svc-support-0'), null, 'ordinals start at 1')
})

test('creating a service: start as many agents as declared, spread over several machines', () => {
  const result = plan({ existing: [], facts: [machine('a'), machine('b')], count: 3 })
  assert.equal(result.create.length, 3)
  assert.equal(result.shortfall, 0)
  assert.deepEqual(ordinals(result.create), [1, 2, 3])
  assert.deepEqual(
    result.create.map((a) => a.machineId).sort(),
    ['a', 'a', 'b'],
    'two machines take 2+1 rather than piling everything on one',
  )
  assert.deepEqual(result.agents.map((a) => a.agentId), ['support-1', 'support-2', 'support-3'])
})

test('stability: once the count matches the declaration nothing moves (no renumbering, no relocating)', () => {
  const existing: ExistingAgent[] = [
    { ordinal: 2, machineId: 'b' },
    { ordinal: 1, machineId: 'a' },
  ]
  const result = plan({ count: 2, existing, facts: [machine('a', { agentCount: 1 }), machine('b', { agentCount: 1 })] })
  assert.deepEqual(result.create, [])
  assert.deepEqual(result.remove, [])
  assert.deepEqual(ordinals(result.agents), [1, 2], 'the ordinal is an identity: sort it, never rewrite it')
  assert.deepEqual(result.agents.map((a) => a.machineId), ['a', 'b'])
})

test('scale-up: fill only the gap, reusing the smallest free ordinals', () => {
  const result = plan({
    count: 3,
    existing: [{ ordinal: 1, machineId: 'a' }],
    facts: [machine('a', { agentCount: 1, services: ['support'] }), machine('b')],
  })
  assert.deepEqual(ordinals(result.create), [2, 3])
  assert.deepEqual(result.keep.map((a) => a.agentId), ['support-1'])
  assert.equal(result.agents.length, 3)
})

test('scale-down: retire the highest ordinals first, and never start a duplicate', () => {
  const result = plan({
    count: 2,
    existing: [
      { ordinal: 1, machineId: 'a' },
      { ordinal: 2, machineId: 'b' },
      { ordinal: 3, machineId: 'b' },
    ],
    facts: [machine('a', { agentCount: 1 }), machine('b', { agentCount: 2 })],
  })
  assert.deepEqual(ordinals(result.remove), [3])
  assert.deepEqual(result.create, [])
  assert.deepEqual(ordinals(result.agents), [1, 2])
})

test('scale-down: when existing ordinals do not start at 1, no extra agent is invented', () => {
  const result = plan({
    count: 1,
    existing: [
      { ordinal: 2, machineId: 'a' },
      { ordinal: 3, machineId: 'b' },
    ],
    facts: [machine('a', { agentCount: 1 }), machine('b', { agentCount: 1 })],
  })
  assert.equal(result.agents.length, 1, 'wanting one agent means exactly one exists')
  assert.deepEqual(result.create, [])
  assert.deepEqual(result.keep.map((a) => a.ordinal), [2], 'keep the lower ordinal and do not rewrite it as 1')
})

test('scale-down drains: an agent still serving is not cut off; it switches to draining', () => {
  const result = plan({
    count: 1,
    existing: [
      { ordinal: 1, machineId: 'a' },
      { ordinal: 2, machineId: 'b' },
      { ordinal: 3, machineId: 'a' },
    ],
    facts: [machine('a', { agentCount: 2 }), machine('b', { agentCount: 1 })],
    sessionsByAgent: { 'support-2': 2, 'support-3': 0 },
  })
  assert.deepEqual(ordinals(result.draining), [2], 'agent 2 is still serving: wait for it to go quiet')
  assert.deepEqual(ordinals(result.remove), [3], 'agent 3 is idle: retire it now')
})

test('what does not fit is reported: shortfall plus rejection reasons, never a silent cut', () => {
  const result = plan({
    count: 3,
    facts: [machine('a', { agentCount: 4 }), machine('b', { online: false })],
  })
  assert.equal(result.create.length, 0)
  assert.equal(result.shortfall, 3)
  assert.deepEqual(result.rejections, [
    { machineId: 'a', reason: 'machine_full' },
    { machineId: 'b', reason: 'offline' },
  ])
})

test('isolation red line: not one agent goes on a machine that hosts an internal agent (quota still goes to fit machines)', () => {
  const result = plan({ count: 2, facts: [machine('a', { hasPrivateAgents: true }), machine('b')] })
  assert.deepEqual(result.create.map((a) => a.machineId), ['b', 'b'], 'the red line forbids mixing, not scaling')
  assert.ok(!result.create.some((a) => a.machineId === 'a'))
  assert.ok(result.rejections.some((r) => r.machineId === 'a' && r.reason === 'private_agents_present'))
})

test('cross-service isolation: a machine already hosting another service is skipped', () => {
  const result = plan({
    count: 2,
    facts: [machine('a', { agentCount: 1, services: ['report'] }), machine('b')],
  })
  assert.ok(!result.create.some((a) => a.machineId === 'a'), 'a support agent must not share a machine with a reporting agent')
  assert.ok(result.rejections.some((r) => r.machineId === 'a' && r.reason === 'other_service_present'))
})

test('pin: only the named machines may be used', () => {
  const result = plan({
    count: 2,
    placement: 'pin',
    machines: ['b'],
    facts: [machine('a'), machine('b')],
  })
  assert.ok(!result.create.some((a) => a.machineId === 'a'))
  assert.ok(result.rejections.some((r) => r.machineId === 'a' && r.reason === 'not_in_pin_list'))
})

test('per-machine cap: when it is reached the shortfall is reported with machine_full', () => {
  const result = plan({ count: 2, maxAgentsPerMachine: 1, facts: [machine('a')] })
  assert.deepEqual(result.create.map((a) => a.machineId), ['a'])
  assert.equal(result.shortfall, 1, 'the cap is a hard constraint: spare memory does not buy another agent')
})

test('per-machine cap: an agent of this service already on the machine counts against it', () => {
  const result = plan({
    count: 2,
    maxAgentsPerMachine: 2,
    existing: [{ ordinal: 1, machineId: 'a' }],
    facts: [machine('a', { agentCount: 1, services: ['support'] })],
  })
  assert.deepEqual(result.create.map((a) => a.machineId), ['a'], 'one running plus a cap of two leaves room for one more')
  assert.equal(result.shortfall, 0)
})

test('low headroom: an online machine below the floors is still rejected', () => {
  const result = plan({ count: 1, facts: [machine('a', { cpuFreePercent: 5 })] })
  assert.equal(result.create.length, 0)
  assert.equal(result.shortfall, 1)
  assert.deepEqual(result.rejections, [{ machineId: 'a', reason: 'insufficient_cpu' }])
})

test('stranded: an existing agent whose machine went away or is blocked is only reported, never moved (migration is self-healing)', () => {
  const result = plan({
    count: 3,
    existing: [
      { ordinal: 1, machineId: 'a' },
      { ordinal: 2, machineId: 'gone' },
      { ordinal: 3, machineId: 'c' },
    ],
    facts: [machine('a'), machine('c', { hasPrivateAgents: true })],
  })
  assert.deepEqual(result.keep.map((a) => a.agentId), ['support-1', 'support-2', 'support-3'], 'not one is retired')
  assert.deepEqual(result.stranded, [
    { agent: { ...agentNames('support', 2), serviceId: 'support', ordinal: 2, machineId: 'gone' }, reason: 'machine_unknown' },
    { agent: { ...agentNames('support', 3), serviceId: 'support', ordinal: 3, machineId: 'c' }, reason: 'private_agents_present' },
  ])
})

test('placement stability: when the machine of an existing agent is offline, new agents stop going there', () => {
  const result = plan({
    count: 3,
    existing: [{ ordinal: 1, machineId: 'a' }],
    facts: [machine('a', { online: false, agentCount: 1 }), machine('b')],
  })
  assert.deepEqual(result.create.map((a) => a.machineId), ['b', 'b'])
})
