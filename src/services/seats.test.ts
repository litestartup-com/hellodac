import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSeatEndpoint, planSeats, seatNames, type ExistingSeat, type SeatsRequest } from './seats.js'
import type { MachineFacts } from './placement.js'

/**
 * 坐席对账（`services[].agents` ↔ 实际在跑的坐席）。
 * 用例都对着真实后果写：少配静默 → 客户被 429；乱搬机器 → 会话失忆；
 * 缩容硬断 → 正在跑的一轮被砍。
 */
const machine = (id: string, over: Partial<MachineFacts> = {}): MachineFacts => ({
  id,
  online: true,
  seats: 0,
  services: [],
  hasPrivateAgents: false,
  sessions: 0,
  cpuFreePercent: 80,
  memFreeBytes: 8_000_000_000,
  diskFreeBytes: 50_000_000_000,
  ...over,
})

const plan = (over: Partial<SeatsRequest> = {}) =>
  planSeats({
    serviceId: 'support',
    agents: 3,
    placement: 'spread',
    existing: [],
    facts: [machine('a'), machine('b')],
    ...over,
  })

const ordinals = (seats: Array<{ ordinal: number }>): number[] => seats.map((s) => s.ordinal)

test('命名可预测：服务 id + 序号派生端点与 agent', () => {
  assert.deepEqual(seatNames('support', 2), { endpointId: 'svc-support-2', agentId: 'support-2' })
})

test('反解派生端点：认得出服务与序号，且不误认普通节点', () => {
  assert.deepEqual(parseSeatEndpoint('svc-support-2'), { serviceId: 'support', ordinal: 2 })
  assert.deepEqual(parseSeatEndpoint('svc-a-b-2'), { serviceId: 'a-b', ordinal: 2 }, '服务 id 允许短横线，序号取最后一段')
  assert.equal(parseSeatEndpoint('node-3081'), null)
  assert.equal(parseSeatEndpoint('svc-support'), null)
  assert.equal(parseSeatEndpoint('svc-support-0'), null, '序号从 1 起')
})

test('建服务：按声明数量起坐席，spread 铺到多台机器', () => {
  const result = plan({ existing: [], facts: [machine('a'), machine('b')], agents: 3 })
  assert.equal(result.create.length, 3)
  assert.equal(result.shortfall, 0)
  assert.deepEqual(ordinals(result.create), [1, 2, 3])
  assert.deepEqual(
    result.create.map((s) => s.machineId).sort(),
    ['a', 'a', 'b'],
    '两台机器 2+1，而不是全塞一台',
  )
  assert.deepEqual(result.seats.map((s) => s.agentId), ['support-1', 'support-2', 'support-3'])
})

test('稳定：数量已达声明就不动（不重排、不搬机器）', () => {
  const existing: ExistingSeat[] = [
    { ordinal: 2, machineId: 'b' },
    { ordinal: 1, machineId: 'a' },
  ]
  const result = plan({ agents: 2, existing, facts: [machine('a', { seats: 1 }), machine('b', { seats: 1 })] })
  assert.deepEqual(result.create, [])
  assert.deepEqual(result.remove, [])
  assert.deepEqual(ordinals(result.seats), [1, 2], '序号是身份，只排序不重编')
  assert.deepEqual(result.seats.map((s) => s.machineId), ['a', 'b'])
})

test('扩容：只补差额，沿用最小空闲序号', () => {
  const result = plan({
    agents: 3,
    existing: [{ ordinal: 1, machineId: 'a' }],
    facts: [machine('a', { seats: 1, services: ['support'] }), machine('b')],
  })
  assert.deepEqual(ordinals(result.create), [2, 3])
  assert.deepEqual(result.keep.map((s) => s.agentId), ['support-1'])
  assert.equal(result.seats.length, 3)
})

test('缩容：先撤编号最大的，且不重复起（序号身份不重排的边界）', () => {
  const result = plan({
    agents: 2,
    existing: [
      { ordinal: 1, machineId: 'a' },
      { ordinal: 2, machineId: 'b' },
      { ordinal: 3, machineId: 'b' },
    ],
    facts: [machine('a', { seats: 1 }), machine('b', { seats: 2 })],
  })
  assert.deepEqual(ordinals(result.remove), [3])
  assert.deepEqual(result.create, [])
  assert.deepEqual(ordinals(result.seats), [1, 2])
})

test('缩容：已有坐席序号不从 1 起时，也不会凭空多起一个', () => {
  const result = plan({
    agents: 1,
    existing: [
      { ordinal: 2, machineId: 'a' },
      { ordinal: 3, machineId: 'b' },
    ],
    facts: [machine('a', { seats: 1 }), machine('b', { seats: 1 })],
  })
  assert.equal(result.seats.length, 1, '期望 1 个坐席就只能有 1 个')
  assert.deepEqual(result.create, [])
  assert.deepEqual(result.keep.map((s) => s.ordinal), [2], '留低序号，且不重编为 1')
})

test('缩容排水：还有会话在跑的坐席不硬断，转 draining 等它空', () => {
  const result = plan({
    agents: 1,
    existing: [
      { ordinal: 1, machineId: 'a' },
      { ordinal: 2, machineId: 'b' },
      { ordinal: 3, machineId: 'a' },
    ],
    facts: [machine('a', { seats: 2 }), machine('b', { seats: 1 })],
    sessionsBySeat: { 'support-2': 2, 'support-3': 0 },
  })
  assert.deepEqual(ordinals(result.draining), [2], '2 号还在接待，等它空')
  assert.deepEqual(ordinals(result.remove), [3], '3 号空闲，立刻撤')
})

test('放不下就如实少配：shortfall + 拒绝原因，不静默少起', () => {
  const result = plan({
    agents: 3,
    facts: [machine('a', { seats: 4 }), machine('b', { online: false })],
  })
  assert.equal(result.create.length, 0)
  assert.equal(result.shortfall, 3)
  assert.deepEqual(result.rejections, [
    { machineId: 'a', reason: 'machine_full' },
    { machineId: 'b', reason: 'offline' },
  ])
})

test('隔离红线：有非对外坐席的机器一台都不放（哪怕机器全空）', () => {
  const result = plan({ agents: 2, facts: [machine('a', { hasPrivateAgents: true }), machine('b')] })
  assert.deepEqual(result.create.map((s) => s.machineId), ['b', 'b'], '红线是"不混放"，不是"拒绝扩容"：名额照给合格机器')
  assert.ok(!result.create.some((s) => s.machineId === 'a'))
  assert.ok(result.rejections.some((r) => r.machineId === 'a' && r.reason === 'private_agents_present'))
})

test('跨服务隔离：已经放了别的服务的机器不放', () => {
  const result = plan({
    agents: 2,
    facts: [machine('a', { seats: 1, services: ['report'] }), machine('b')],
  })
  assert.ok(!result.create.some((s) => s.machineId === 'a'), '客服被注入不该读得到报表的坐席')
  assert.ok(result.rejections.some((r) => r.machineId === 'a' && r.reason === 'other_service_present'))
})

test('pin：只允许在点名的机器上落位', () => {
  const result = plan({
    agents: 2,
    placement: 'pin',
    machines: ['b'],
    facts: [machine('a'), machine('b')],
  })
  assert.ok(!result.create.some((s) => s.machineId === 'a'))
  assert.ok(result.rejections.some((r) => r.machineId === 'a' && r.reason === 'not_in_pin_list'))
})

test('每机坐席上限：满了就少配，且给出 machine_full', () => {
  const result = plan({ agents: 2, maxAgentsPerMachine: 1, facts: [machine('a')] })
  assert.deepEqual(result.create.map((s) => s.machineId), ['a'])
  assert.equal(result.shortfall, 1, '上限是硬约束，不因为"还有内存"就多塞')
})

test('每机坐席上限：本机已有本服务坐席时也算占用', () => {
  const result = plan({
    agents: 2,
    maxAgentsPerMachine: 2,
    existing: [{ ordinal: 1, machineId: 'a' }],
    facts: [machine('a', { seats: 1, services: ['support'] })],
  })
  assert.deepEqual(result.create.map((s) => s.machineId), ['a'], '1 个在跑 + 上限 2 → 还能再加 1 个')
  assert.equal(result.shortfall, 0)
})

test('水位不足：机器在线但不达标也不放', () => {
  const result = plan({ agents: 1, facts: [machine('a', { cpuFreePercent: 5 })] })
  assert.equal(result.create.length, 0)
  assert.equal(result.shortfall, 1)
  assert.deepEqual(result.rejections, [{ machineId: 'a', reason: 'insufficient_cpu' }])
})

test('落单告警：已有坐席的机器掉线/被挡 → 只报告，不自动搬（迁移属于自愈）', () => {
  const result = plan({
    agents: 3,
    existing: [
      { ordinal: 1, machineId: 'a' },
      { ordinal: 2, machineId: 'gone' },
      { ordinal: 3, machineId: 'c' },
    ],
    facts: [machine('a'), machine('c', { hasPrivateAgents: true })],
  })
  assert.deepEqual(result.keep.map((s) => s.agentId), ['support-1', 'support-2', 'support-3'], '一个都不撤')
  assert.deepEqual(result.stranded, [
    { seat: { ...seatNames('support', 2), serviceId: 'support', ordinal: 2, machineId: 'gone' }, reason: 'machine_unknown' },
    { seat: { ...seatNames('support', 3), serviceId: 'support', ordinal: 3, machineId: 'c' }, reason: 'private_agents_present' },
  ])
})

test('落位保持：已有坐席所在机器离线时，新坐席不再往那台放', () => {
  const result = plan({
    agents: 3,
    existing: [{ ordinal: 1, machineId: 'a' }],
    facts: [machine('a', { online: false, seats: 1 }), machine('b')],
  })
  assert.deepEqual(result.create.map((s) => s.machineId), ['b', 'b'])
})
