// Debt F3: behaviour tests for autoReconnect (ui.js) -- node:test + mock timers, part of CI test:web.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { autoReconnect } from './ui.js'

/** A hand-written fake EventSource: only the surface autoReconnect uses (addEventListener/close). */
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

test('debt F3: open resets the backoff to 3s (connected means back to zero)', async () => {
  const { rec, last, count } = setup()
  try {
    rec.connect()
    assert.equal(count(), 1)
    last().emit('error') // drop -> reconnect after 3s
    await mock.timers.tick(3_000)
    assert.equal(count(), 2)
    last().emit('open') // reconnected -> the backoff resets
    last().emit('error') // drops again -> it must still reconnect after 3s (not 6s)
    await mock.timers.tick(2_999)
    assert.equal(count(), 2, 'no reconnect before 3s')
    await mock.timers.tick(1)
    assert.equal(count(), 3, 'after open it must reconnect on the 3s delay')
  } finally {
    mock.timers.reset()
  }
})

test('debt F3: the backoff grows 3s -> 6s -> 12s -> ... -> capped at 30s (no success, no reset)', async () => {
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
    assert.equal(count(), 4, 'no reconnect before 24s')
    await mock.timers.tick(1)
    assert.equal(count(), 5)
    last().emit('error')
    await mock.timers.tick(30_000)
    assert.equal(count(), 6, '30s per retry once capped')
  } finally {
    mock.timers.reset()
  }
})

test('debt F3: a late error from an old instance must not close the current one (connection-leak regression)', async () => {
  const { rec, last, count } = setup()
  try {
    rec.connect()
    const stale = last()
    stale.emit('error') // schedules a reconnect
    await mock.timers.tick(3_000)
    assert.equal(count(), 2)
    const current = last()
    stale.emit('error') // the old handler fires late
    assert.equal(current.closed, false, 'the current instance must never be closed by an old error')
    await mock.timers.tick(30_000)
    assert.equal(count(), 2, 'an old error must not schedule an extra reconnect')
  } finally {
    mock.timers.reset()
  }
})

test('debt F3: disconnect cancels a pending reconnect and closes the current instance', async () => {
  const { rec, last, count } = setup()
  try {
    rec.connect()
    const current = last()
    current.emit('error') // a 3s reconnect is scheduled
    rec.disconnect()
    assert.equal(current.closed, true)
    await mock.timers.tick(60_000)
    assert.equal(count(), 1, 'no reconnect after disconnect')
  } finally {
    mock.timers.reset()
  }
})
