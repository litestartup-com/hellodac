import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dispatchCandidates, pickWorker, type DispatchRequest, type WorkerFacts } from './dispatch.js'

/**
 * 分发的排序与边界（设计稿：内部设计库 `manager/topics/service-model.md` §6）。
 * 每条用例都对应一个真实场景：忙闲看错 → 长任务 agent 被塞爆；粘性被破坏 → 客户失忆；
 * 满载不报 → 请求无声堆积，调用方不知道要退避。
 */
const worker = (agentId: string, over: Partial<WorkerFacts> = {}): WorkerFacts => ({
  agentId,
  online: true,
  sessions: 0,
  queueDepth: 0,
  ...over,
})

const pick = (over: Partial<DispatchRequest> & Pick<DispatchRequest, 'workers'>): string | null => {
  const result = pickWorker({ maxSessionsPerAgent: 4, ...over })
  return result.ok ? result.agentId : null
}

test('候选：离线与已满都被排除，且各自留痕（界面才能解释"为什么没人接"）', () => {
  const { candidates, offline, full } = dispatchCandidates({
    workers: [worker('a', { sessions: 4 }), worker('b', { online: false }), worker('c')],
    maxSessionsPerAgent: 4,
  })
  assert.deepEqual(candidates.map((w) => w.agentId), ['c'])
  assert.deepEqual(full, ['a'])
  assert.deepEqual(offline, ['b'])
})

test('排序：先看会话数，再看队列长度', () => {
  const busy = worker('busy', { sessions: 3 })
  const queued = worker('queued', { sessions: 1, queueDepth: 2 })
  assert.equal(pick({ workers: [busy, queued] }), 'queued', '会话少者优先，哪怕它自己还排着队')

  const idle = worker('idle', { sessions: 1, queueDepth: 0 })
  const backedUp = worker('backed-up', { sessions: 1, queueDepth: 5 })
  assert.equal(pick({ workers: [backedUp, idle] }), 'idle', '同样闲时，选队列短的')
})

test('排序：最近一轮耗时更短者优先；耗时未知的排最后（不赌没数据的 agent）', () => {
  const quick = worker('quick', { sessions: 1, lastTurnMs: 1_000 })
  const slow = worker('slow', { sessions: 1, lastTurnMs: 90_000 })
  assert.equal(pick({ workers: [slow, quick] }), 'quick')

  const unknown = worker('unknown', { sessions: 1 })
  assert.equal(pick({ workers: [unknown, slow] }), 'slow', '未知耗时垫底，但不等于不能用')
  assert.equal(pick({ workers: [unknown] }), 'unknown', '全员未知时照样能分发')
})

test('同一调用方尽量分散：会话数相同时，优先选这把钥匙占用更少的 agent', () => {
  const a = worker('a')
  const b = worker('b')
  assert.equal(pick({ workers: [a, b], keySessionsByAgent: { a: 2, b: 0 } }), 'b', '一个大客户不该把同一个 agent 占满')
  assert.equal(pick({ workers: [a, b], keySessionsByAgent: { a: 0, b: 3 } }), 'a')
  assert.equal(pick({ workers: [a, b] }), 'a', '没给钥匙数据时退化为按列表顺序')
})

test('平手轮询：种子递增依次轮转，同种子结果确定', () => {
  const workers = [worker('a'), worker('b'), worker('c')]
  assert.deepEqual(
    [0, 1, 2, 3].map((rotationSeed) => pick({ workers, rotationSeed })),
    ['a', 'b', 'c', 'a'],
    '三台同分 → 轮流坐庄（同种子必得同结果，日志可复算）',
  )
})

test('满载：如实回报 all_full 与容量数字，调用方据此排队/退避', () => {
  const result = pickWorker({ workers: [worker('a', { sessions: 4 }), worker('b', { sessions: 4 })], maxSessionsPerAgent: 4 })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.reason, 'all_full')
    assert.equal(result.capacity, 8)
    assert.equal(result.inUse, 8)
  }
})

test('全员离线：与"满载"区分开（一个是故障，一个是容量）', () => {
  const result = pickWorker({ workers: [worker('a', { online: false }), worker('b', { online: false })], maxSessionsPerAgent: 4 })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.reason, 'no_worker_online')
    assert.equal(result.inUse, 0)
  }
})

test('一台都没有：算满载（服务未部署 / agent 未拉起的解释权交给上层）', () => {
  const result = pickWorker({ workers: [], maxSessionsPerAgent: 4 })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.reason, 'all_full')
})

test('分发成功时回报"谁满了"，让界面能显示完整座位表', () => {
  const result = pickWorker({
    workers: [worker('full1', { sessions: 4 }), worker('free', { sessions: 1 })],
    maxSessionsPerAgent: 4,
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.agentId, 'free')
    assert.equal(result.sessions, 1)
    assert.deepEqual(result.full, ['full1'])
  }
})

test('容量边界：达到上限前一位仍可接客（4 个上限 → 3 个还能接）', () => {
  assert.equal(pick({ workers: [worker('a', { sessions: 3 })], maxSessionsPerAgent: 4 }), 'a')
  assert.equal(pick({ workers: [worker('a', { sessions: 4 })], maxSessionsPerAgent: 4 }), null)
})
