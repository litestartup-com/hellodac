import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HistoryCache } from './history-cache.js'

/**
 * Debt B2 (half of it): the chat history cache goes from a bare Map to "capacity-capped LRU + lazy TTL".
 * The old implementation only expired lazily and had no cap -- many "read once, never runs again" chats
 * made it grow without bound, and its value is the most expensive object in the project (a whole history
 * event array). Red proof: the old code had no such module (import fails); the assertions below lock the semantics.
 */

const entry = (n: number): { id: number } => ({ id: n })

test('Debt B2 regression: the capacity cap evicts the oldest entry', () => {
  const cache = new HistoryCache<{ id: number }>({ max: 3 })
  cache.set('a', entry(1), 1_000)
  cache.set('b', entry(2), 1_000)
  cache.set('c', entry(3), 1_000)
  cache.set('d', entry(4), 1_000)
  assert.equal(cache.size, 3, 'capacity is capped')
  assert.equal(cache.get('a', 1_000), null, 'the oldest entry, a, was evicted')
  assert.ok(cache.get('b', 1_000) !== null && cache.get('c', 1_000) !== null && cache.get('d', 1_000) !== null)
})

test('Debt B2 regression: a get hit promotes in the LRU, so it is not evicted later', () => {
  const cache = new HistoryCache<{ id: number }>({ max: 3 })
  cache.set('a', entry(1), 1_000)
  cache.set('b', entry(2), 1_000)
  cache.set('c', entry(3), 1_000)
  cache.get('a', 1_000) // promote a
  cache.set('d', entry(4), 1_000) // evict the oldest = b
  assert.ok(cache.get('a', 1_000) !== null, 'the entry that was touched, a, survives eviction')
  assert.equal(cache.get('b', 1_000), null, 'the untouched b is evicted')
})

test('Debt B2 regression: an expired TTL returns null and deletes the entry (lazy sweep)', () => {
  const cache = new HistoryCache<{ id: number }>({ max: 10, ttlMs: 100 })
  cache.set('a', entry(1), 500)
  assert.ok(cache.get('a', 500) !== null)
  assert.equal(cache.get('a', 700), null, 'past the TTL it must count as a miss')
  assert.equal(cache.size, 0, 'the expired entry is deleted, no garbage left behind')
})

test('Debt B2 regression: setting the same key again promotes it; delete takes effect', () => {
  const cache = new HistoryCache<{ id: number }>({ max: 2 })
  cache.set('a', entry(1), 1_000)
  cache.set('b', entry(2), 1_000)
  cache.set('a', entry(3), 1_000) // set a again -> a becomes the newest
  cache.set('c', entry(4), 1_000) // evict the oldest = b
  assert.equal(cache.get('a', 1_000)?.id, 3)
  assert.equal(cache.get('b', 1_000), null)
  cache.delete('a')
  assert.equal(cache.get('a', 1_000), null)
})
