// Debt F4: behaviour tests for poll (ui.js) -- node:test + mock timers, part of CI test:web.
// Note: mock.timers.tick only advances timers that are already scheduled, so one scheduled from a
// microtask during a tick fires on the next tick -- the assertions read "one tick = one round of scheduling".
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { poll } from './ui.js'

const setup = () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  globalThis.document = { hidden: false }
}

test('debt F4: poll calls fn once per interval', async () => {
  setup()
  let calls = 0
  const stop = poll(() => {
    calls += 1
  }, 1_000)
  try {
    await mock.timers.tick(1_000)
    await mock.timers.tick(1_000)
    await mock.timers.tick(1_000)
    assert.equal(calls, 3, 'one call per second, so three after three rounds')
  } finally {
    stop()
    mock.timers.reset()
  }
})

test('debt F4: polling pauses while the page is hidden, wasting no background requests', async () => {
  setup()
  let calls = 0
  const stop = poll(() => {
    calls += 1
  }, 1_000)
  try {
    await mock.timers.tick(1_000)
    assert.equal(calls, 1)
    globalThis.document = { hidden: true }
    await mock.timers.tick(1_000)
    await mock.timers.tick(1_000)
    assert.equal(calls, 1, 'fn is not called again while hidden')
  } finally {
    stop()
    mock.timers.reset()
    delete globalThis.document
  }
})

test('debt F4: a throwing fn backs off by a factor of two, and a success resets it', async () => {
  setup()
  let failing = true
  let calls = 0
  const stop = poll(() => {
    calls += 1
    if (failing) throw new Error('boom')
  }, 1_000)
  try {
    await mock.timers.tick(1_000) // call 1 (fails) -> backs off to 2s
    assert.equal(calls, 1)
    await mock.timers.tick(1_000)
    assert.equal(calls, 1, 'no retry at 1s (already backed off to 2s)')
    await mock.timers.tick(1_000) // t=3000 -> call 2 (fails) -> backs off to 4s
    assert.equal(calls, 2, 'it retries after 2s')
    failing = false
    await mock.timers.tick(4_000) // t=7000 -> call 3 (succeeds) -> resets to 1s
    assert.equal(calls, 3)
    await mock.timers.tick(1_000) // t=8000 -> call 4
    assert.equal(calls, 4, 'back to the 1s interval after a success')
  } finally {
    stop()
    mock.timers.reset()
  }
})

test('debt F4: stop() halts polling', async () => {
  setup()
  let calls = 0
  const stop = poll(() => {
    calls += 1
  }, 1_000)
  try {
    await mock.timers.tick(1_000)
    assert.equal(calls, 1)
    stop()
    await mock.timers.tick(1_000)
    await mock.timers.tick(1_000)
    assert.equal(calls, 1, 'no further calls after stop')
  } finally {
    stop()
    mock.timers.reset()
  }
})
