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
 * agent 放置的硬约束与分散行为（口径 CONCEPTS-ALIGNED.md §4.5；策略见 service-model.md §5）。
 * 这些约束每一条都对应一个"否则会静默出事"的场景：隔离红线、水位、容量、pin 范围。
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

test('硬约束: 离线 / 混放对内 agent / 混放别的服务 / 已满 —— 各自给出明确原因', () => {
  assert.equal(blockingReason(healthy('m1', { online: false }), 'support', opts, 0), 'offline')
  assert.equal(blockingReason(healthy('m1', { hasPrivateAgents: true }), 'support', opts, 0), 'private_agents_present')
  assert.equal(blockingReason(healthy('m1', { services: ['report'] }), 'support', opts, 0), 'other_service_present')
  assert.equal(blockingReason(healthy('m1', { agentCount: 4 }), 'support', opts, 4), 'machine_full')
  // 本服务自己的 agent 不算"别的服务"
  assert.equal(blockingReason(healthy('m1', { services: ['support'] }), 'support', opts, 1), null)
})

test('硬约束: 三项水位门槛各拦一次；指标缺失不拦（单机场景没有上报）', () => {
  assert.equal(blockingReason(healthy('m1', { cpuFreePercent: 19 }), 'support', opts, 0), 'insufficient_cpu')
  assert.equal(blockingReason(healthy('m1', { memFreeBytes: 1_400_000_000 }), 'support', opts, 0), 'insufficient_memory')
  assert.equal(blockingReason(healthy('m1', { diskFreeBytes: 4_000_000_000 }), 'support', opts, 0), 'insufficient_disk')
  const blind: MachineFacts = { id: 'm2', online: true, agentCount: 0, services: [], hasPrivateAgents: false, sessions: 0 }
  assert.equal(blockingReason(blind, 'support', opts, 0), null, '没有指标不等于不合格')
  assert.ok(scoreMachine(blind, 'support', opts, 0) < scoreMachine(healthy('m3'), 'support', opts, 0), '但排序靠后')
})

test('硬约束: pin 策略只认指定机器', () => {
  const pinned = { ...opts, strategy: 'pin' as const, pinMachines: ['m2'] }
  assert.equal(blockingReason(healthy('m1'), 'support', pinned, 0), 'not_in_pin_list')
  assert.equal(blockingReason(healthy('m2'), 'support', pinned, 0), null)
})

test('spread（默认）: 2 台机器放 2 个 agent → 一台一个，铺开而不是堆一起', () => {
  const plan = planPlacement({ serviceId: 'support', count: 2, machines: [healthy('m1'), healthy('m2')] })
  assert.deepEqual(
    plan.placements.map((p) => p.machineId).sort(),
    ['m1', 'm2'],
    '默认策略必须分散：单机故障只影响一部分会话',
  )
  assert.equal(plan.shortfall, 0)
})

test('pack: 先塞满一台再上下一台', () => {
  const plan = planPlacement({ serviceId: 'support', count: 2, machines: [healthy('m1'), healthy('m2')], strategy: 'pack' })
  assert.deepEqual(plan.placements.map((p) => p.machineId), ['m1', 'm1'])
  assert.equal(plan.shortfall, 0)
})

test('容量: 放不下的部分如实报 shortfall，并列出被排除的机器与原因', () => {
  const plan = planPlacement({
    serviceId: 'support',
    count: 5,
    machines: [healthy('m1'), healthy('m2', { cpuFreePercent: 5 }), healthy('m3', { online: false })],
    maxAgentsPerMachine: 2,
  })
  assert.equal(plan.placements.length, 2, '只有 m1 有容量（每机 2 席）')
  assert.equal(plan.shortfall, 3, '放不下要如实报，不能静默少配')
  const reasons = new Map(plan.rejections.map((r) => [r.machineId, r.reason]))
  assert.equal(reasons.get('m2'), 'insufficient_cpu')
  assert.equal(reasons.get('m3'), 'offline')
})

test('确定性: 同样输入必得同样结果（平手按机器 id 排序）', () => {
  const machines = [healthy('z9'), healthy('a1'), healthy('m5')]
  const first = planPlacement({ serviceId: 'support', count: 2, machines })
  const second = planPlacement({ serviceId: 'support', count: 2, machines })
  assert.deepEqual(first, second)
  assert.equal(first.placements[0]?.machineId, 'a1', '三台同分 → 取 id 最小者')
  assert.equal(first.placements[1]?.machineId, 'm5', '第二轮已铺过的 z9/a1 都扣了分散分')
})

test('亲和与负载: 手册在本机的加分；会话多的机器排后', () => {
  const busy = healthy('busy', { sessions: 60 })
  const affinity = healthy('kb', { knowledgeAffinity: true })
  const plan = planPlacement({ serviceId: 'support', count: 1, machines: [busy, affinity] })
  assert.equal(plan.placements[0]?.machineId, 'kb')
})
