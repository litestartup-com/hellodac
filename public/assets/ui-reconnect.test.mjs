// 债务 F3:autoReconnect(ui.js)行为测试——node:test + mock 时钟,CI test:web 常驻。
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { autoReconnect } from './ui.js'

/** 手写假 EventSource:只实现 autoReconnect 用到的面(addEventListener/close)。 */
class FakeEventSource {
  static instances = []

  constructor() {
    this.handlers = new Map()
    this.closed = false
    FakeEventSource.instances.push(this)
  }

  addEventListener(type, fn) {
    this.handlers.set(type, fn)
  }

  close() {
    this.closed = true
  }

  emit(type) {
    this.handlers.get(type)?.()
  }
}

const setup = () => {
  FakeEventSource.instances = []
  mock.timers.enable({ apis: ['setTimeout'] })
  const rec = autoReconnect(() => new FakeEventSource())
  return {
    rec,
    last: () => FakeEventSource.instances[FakeEventSource.instances.length - 1],
    count: () => FakeEventSource.instances.length,
  }
}

test('债务 F3: open 把退避重置回 3s(连上即清零)', async () => {
  const { rec, last, count } = setup()
  try {
    rec.connect()
    assert.equal(count(), 1)
    last().emit('error') // 断线 → 3s 后重连
    await mock.timers.tick(3_000)
    assert.equal(count(), 2)
    last().emit('open') // 重连成功 → 退避重置
    last().emit('error') // 再断 → 仍应 3s 后重连(而不是 6s)
    await mock.timers.tick(2_999)
    assert.equal(count(), 2, '3s 未到不得重连')
    await mock.timers.tick(1)
    assert.equal(count(), 3, 'open 后必须按 3s 重连')
  } finally {
    mock.timers.reset()
  }
})

test('债务 F3: 退避递增 3s→6s→12s→…→30s 封顶(不成功不重置)', async () => {
  const { rec, last, count } = setup()
  try {
    rec.connect()
    last().emit('error')
    await mock.timers.tick(3_000)
    assert.equal(count(), 2)
    last().emit('error')
    await mock.timers.tick(6_000)
    assert.equal(count(), 3)
    last().emit('error')
    await mock.timers.tick(12_000)
    assert.equal(count(), 4)
    last().emit('error')
    await mock.timers.tick(23_999)
    assert.equal(count(), 4, '24s 未到不得重连')
    await mock.timers.tick(1)
    assert.equal(count(), 5)
    last().emit('error')
    await mock.timers.tick(30_000)
    assert.equal(count(), 6, '封顶后每次 30s')
  } finally {
    mock.timers.reset()
  }
})

test('债务 F3: 旧实例迟到的 error 不得关闭当前实例(连接泄漏回归)', async () => {
  const { rec, last, count } = setup()
  try {
    rec.connect()
    const stale = last()
    stale.emit('error') // 调度重连
    await mock.timers.tick(3_000)
    assert.equal(count(), 2)
    const current = last()
    stale.emit('error') // 旧 handler 迟到触发
    assert.equal(current.closed, false, '当前实例绝不能被旧 error 关掉')
    await mock.timers.tick(30_000)
    assert.equal(count(), 2, '旧 error 不得额外调度重连')
  } finally {
    mock.timers.reset()
  }
})

test('债务 F3: disconnect 取消在途重连并关闭当前实例', async () => {
  const { rec, last, count } = setup()
  try {
    rec.connect()
    const current = last()
    current.emit('error') // 调度了 3s 重连
    rec.disconnect()
    assert.equal(current.closed, true)
    await mock.timers.tick(60_000)
    assert.equal(count(), 1, 'disconnect 后不得再重连')
  } finally {
    mock.timers.reset()
  }
})
