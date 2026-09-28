import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dispatchCandidates, pickWorker, type DispatchRequest, type WorkerFacts } from './dispatch.js'

/**
 * Dispatch ordering and boundaries (design: internal design library `manager/topics/service-model.md` §6).
 * Every case maps to a real outcome: misreading load floods a long-running agent; breaking stickiness loses the
 * memory of a customer; capacity that is not reported piles requests up invisibly.
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

test('candidates: offline and full agents are excluded, and each leaves a trace (so the UI can explain "why nobody took it")', () => {
  const { candidates, offline, full } = dispatchCandidates({
    workers: [worker('a', { sessions: 4 }), worker('b', { online: false }), worker('c')],
    maxSessionsPerAgent: 4,
  })
  assert.deepEqual(candidates.map((w) => w.agentId), ['c'])
  assert.deepEqual(full, ['a'])
  assert.deepEqual(offline, ['b'])
})

test('ordering: fewest sessions first, then the shortest queue', () => {
  const busy = worker('busy', { sessions: 3 })
  const queued = worker('queued', { sessions: 1, queueDepth: 2 })
  assert.equal(pick({ workers: [busy, queued] }), 'queued', 'fewer sessions wins even when that agent has a queue of its own')

  const idle = worker('idle', { sessions: 1, queueDepth: 0 })
  const backedUp = worker('backed-up', { sessions: 1, queueDepth: 5 })
  assert.equal(pick({ workers: [backedUp, idle] }), 'idle', 'equally idle: pick the shorter queue')
})

test('ordering: the fastest recent turn wins; an unknown duration ranks last (never bet on an agent with no data)', () => {
  const quick = worker('quick', { sessions: 1, lastTurnMs: 1_000 })
  const slow = worker('slow', { sessions: 1, lastTurnMs: 90_000 })
  assert.equal(pick({ workers: [slow, quick] }), 'quick')

  const unknown = worker('unknown', { sessions: 1 })
  assert.equal(pick({ workers: [unknown, slow] }), 'slow', 'unknown latency ranks last, but stays usable')
  assert.equal(pick({ workers: [unknown] }), 'unknown', 'all unknown still dispatches')
})

test('one caller is spread out: on equal sessions, prefer the agent this key occupies least', () => {
  const a = worker('a')
  const b = worker('b')
  assert.equal(pick({ workers: [a, b], keySessionsByAgent: { a: 2, b: 0 } }), 'b', 'one big customer must not fill a single agent')
  assert.equal(pick({ workers: [a, b], keySessionsByAgent: { a: 0, b: 3 } }), 'a')
  assert.equal(pick({ workers: [a, b] }), 'a', 'with no key data it falls back to list order')
})

test('tie rotation: an increasing seed takes turns, and the same seed gives the same answer', () => {
  const workers = [worker('a'), worker('b'), worker('c')]
  assert.deepEqual(
    [0, 1, 2, 3].map((rotationSeed) => pick({ workers, rotationSeed })),
    ['a', 'b', 'c', 'a'],
    'three-way tie -> take turns (same seed always yields the same answer, so logs can be replayed)',
  )
})

test('full: report all_full with the capacity numbers, so the caller can queue or back off', () => {
  const result = pickWorker({ workers: [worker('a', { sessions: 4 }), worker('b', { sessions: 4 })], maxSessionsPerAgent: 4 })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.reason, 'all_full')
    assert.equal(result.capacity, 8)
    assert.equal(result.inUse, 8)
  }
})

test('everyone offline is kept apart from "full" (one is a failure, the other is capacity)', () => {
  const result = pickWorker({ workers: [worker('a', { online: false }), worker('b', { online: false })], maxSessionsPerAgent: 4 })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.reason, 'no_worker_online')
    assert.equal(result.inUse, 0)
  }
})

test('no agents at all counts as full (whether the service is undeployed is decided higher up)', () => {
  const result = pickWorker({ workers: [], maxSessionsPerAgent: 4 })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.reason, 'all_full')
})

test('a successful dispatch reports who is full, so the UI can render the whole seat map', () => {
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

test('capacity boundary: one below the cap still takes work (4 max -> 3 is still available)', () => {
  assert.equal(pick({ workers: [worker('a', { sessions: 3 })], maxSessionsPerAgent: 4 }), 'a')
  assert.equal(pick({ workers: [worker('a', { sessions: 4 })], maxSessionsPerAgent: 4 }), null)
})
