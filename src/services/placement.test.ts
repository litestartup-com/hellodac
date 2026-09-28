import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_THRESHOLDS,
  blockingReason,
  planPlacement,
  scoreMachine,
  type MachineFacts,
} from './placement.js'

/**
 * Hard constraints and spreading behaviour of agent placement (contract CONCEPTS-ALIGNED.md §4.5; strategy in service-model.md §5).
 * Each constraint maps to a scenario that would otherwise fail silently: isolation red lines, headroom, capacity, pin scope.
 */
const healthy = (id: string, over: Partial<MachineFacts> = {}): MachineFacts => ({
  id,
  online: true,
  agentCount: 0,
  services: [],
  hasPrivateAgents: false,
  sessions: 0,
  cpuFreePercent: 80,
  memFreeBytes: 8_000_000_000,
  diskFreeBytes: 100_000_000_000,
  ...over,
})

const opts = { strategy: 'spread' as const, pinMachines: [], maxAgentsPerMachine: 4, thresholds: DEFAULT_THRESHOLDS }

test('hard constraints: offline / internal agent present / another service present / full -- each with its own reason', () => {
  assert.equal(blockingReason(healthy('m1', { online: false }), 'support', opts, 0), 'offline')
  assert.equal(blockingReason(healthy('m1', { hasPrivateAgents: true }), 'support', opts, 0), 'private_agents_present')
  assert.equal(blockingReason(healthy('m1', { services: ['report'] }), 'support', opts, 0), 'other_service_present')
  assert.equal(blockingReason(healthy('m1', { agentCount: 4 }), 'support', opts, 4), 'machine_full')
  // agents of this service do not count as "another service"
  assert.equal(blockingReason(healthy('m1', { services: ['support'] }), 'support', opts, 1), null)
})

test('hard constraints: each of the three headroom floors rejects once; missing metrics do not reject (single-machine setups report nothing)', () => {
  assert.equal(blockingReason(healthy('m1', { cpuFreePercent: 19 }), 'support', opts, 0), 'insufficient_cpu')
  assert.equal(blockingReason(healthy('m1', { memFreeBytes: 1_400_000_000 }), 'support', opts, 0), 'insufficient_memory')
  assert.equal(blockingReason(healthy('m1', { diskFreeBytes: 4_000_000_000 }), 'support', opts, 0), 'insufficient_disk')
  const blind: MachineFacts = { id: 'm2', online: true, agentCount: 0, services: [], hasPrivateAgents: false, sessions: 0 }
  assert.equal(blockingReason(blind, 'support', opts, 0), null, 'no metrics does not mean unfit')
  assert.ok(scoreMachine(blind, 'support', opts, 0) < scoreMachine(healthy('m3'), 'support', opts, 0), 'but it ranks lower')
})

test('hard constraints: the pin strategy only accepts the named machines', () => {
  const pinned = { ...opts, strategy: 'pin' as const, pinMachines: ['m2'] }
  assert.equal(blockingReason(healthy('m1'), 'support', pinned, 0), 'not_in_pin_list')
  assert.equal(blockingReason(healthy('m2'), 'support', pinned, 0), null)
})

test('spread (default): two machines take two agents -> one each, spread out rather than piled up', () => {
  const plan = planPlacement({ serviceId: 'support', count: 2, machines: [healthy('m1'), healthy('m2')] })
  assert.deepEqual(
    plan.placements.map((p) => p.machineId).sort(),
    ['m1', 'm2'],
    'the default strategy has to spread: one machine failing takes down only part of the conversations',
  )
  assert.equal(plan.shortfall, 0)
})

test('pack: fill one machine before starting the next', () => {
  const plan = planPlacement({ serviceId: 'support', count: 2, machines: [healthy('m1'), healthy('m2')], strategy: 'pack' })
  assert.deepEqual(plan.placements.map((p) => p.machineId), ['m1', 'm1'])
  assert.equal(plan.shortfall, 0)
})

test('capacity: what does not fit is reported as a shortfall, with the rejected machines and reasons', () => {
  const plan = planPlacement({
    serviceId: 'support',
    count: 5,
    machines: [healthy('m1'), healthy('m2', { cpuFreePercent: 5 }), healthy('m3', { online: false })],
    maxAgentsPerMachine: 2,
  })
  assert.equal(plan.placements.length, 2, 'only m1 has room (2 agents per machine)')
  assert.equal(plan.shortfall, 3, 'what does not fit must be reported, never silently under-provisioned')
  const reasons = new Map(plan.rejections.map((r) => [r.machineId, r.reason]))
  assert.equal(reasons.get('m2'), 'insufficient_cpu')
  assert.equal(reasons.get('m3'), 'offline')
})

test('determinism: the same input always gives the same answer (ties break by machine id)', () => {
  const machines = [healthy('z9'), healthy('a1'), healthy('m5')]
  const first = planPlacement({ serviceId: 'support', count: 2, machines })
  const second = planPlacement({ serviceId: 'support', count: 2, machines })
  assert.deepEqual(first, second)
  assert.equal(first.placements[0]?.machineId, 'a1', 'three-way tie -> the smallest id wins')
  assert.equal(first.placements[1]?.machineId, 'm5', 'z9/a1 were already used in round one and lost spread points')
})

test('affinity and load: knowledge on this machine scores higher; a machine with more sessions ranks lower', () => {
  const busy = healthy('busy', { sessions: 60 })
  const affinity = healthy('kb', { knowledgeAffinity: true })
  const plan = planPlacement({ serviceId: 'support', count: 1, machines: [busy, affinity] })
  assert.equal(plan.placements[0]?.machineId, 'kb')
})
