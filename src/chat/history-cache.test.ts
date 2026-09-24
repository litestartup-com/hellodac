import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HistoryCache } from './history-cache.js'

/**
 * 债务 B2(半项):会话历史缓存从裸 Map 升级为「容量上限 LRU + 惰性 TTL」。
 * 旧实现只惰性过期、无上限——大量「读过一次、不再跑回合」的会话让缓存
 * 单调增长,值恰好是全项目最贵的对象(整段历史事件数组)。
 * 红证:旧代码无本模块(加载失败);以下断言锁定驱逐/LRU/TTL 语义。
 */

const entry = (n: number): { id: number } => ({ id: n })

test('债务 B2 回归: 容量上限驱逐最旧条目', () => {
  const cache = new HistoryCache<{ id: number }>({ max: 3 })
  cache.set('a', entry(1), 1_000)
  cache.set('b', entry(2), 1_000)
  cache.set('c', entry(3), 1_000)
  cache.set('d', entry(4), 1_000)
  assert.equal(cache.size, 3, '容量封顶')
  assert.equal(cache.get('a', 1_000), null, '最旧的 a 被驱逐')
  assert.ok(cache.get('b', 1_000) !== null && cache.get('c', 1_000) !== null && cache.get('d', 1_000) !== null)
})

test('债务 B2 回归: get 命中 = LRU 提升,不被后续驱逐', () => {
  const cache = new HistoryCache<{ id: number }>({ max: 3 })
  cache.set('a', entry(1), 1_000)
  cache.set('b', entry(2), 1_000)
  cache.set('c', entry(3), 1_000)
  cache.get('a', 1_000) // 提升 a
  cache.set('d', entry(4), 1_000) // 驱逐最旧 = b
  assert.ok(cache.get('a', 1_000) !== null, '被访问过的 a 免于驱逐')
  assert.equal(cache.get('b', 1_000), null, '未访问的 b 被驱逐')
})

test('债务 B2 回归: TTL 过期返回 null 并删除(惰性清扫)', () => {
  const cache = new HistoryCache<{ id: number }>({ max: 10, ttlMs: 100 })
  cache.set('a', entry(1), 500)
  assert.ok(cache.get('a', 500) !== null)
  assert.equal(cache.get('a', 700), null, '超 TTL 必须视为未命中')
  assert.equal(cache.size, 0, '过期条目被删除,不留垃圾')
})

test('债务 B2 回归: set 同键重设提升序位;delete 生效', () => {
  const cache = new HistoryCache<{ id: number }>({ max: 2 })
  cache.set('a', entry(1), 1_000)
  cache.set('b', entry(2), 1_000)
  cache.set('a', entry(3), 1_000) // 重设 a → a 变最新
  cache.set('c', entry(4), 1_000) // 驱逐最旧 = b
  assert.equal(cache.get('a', 1_000)?.id, 3)
  assert.equal(cache.get('b', 1_000), null)
  cache.delete('a')
  assert.equal(cache.get('a', 1_000), null)
})
