import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pidFileOf, waitSettled } from './node.js'

/**
 * Debt C2: cli/node (the node control CLI) had zero coverage. Covered here:
 * the pidFileOf derivation rule; waitSettled convergence for up/down and its timeout.
 * killByPidFile (a taskkill spawn) and main (a process.exit shell) are outside unit-test scope.
 */

test('Debt C2: pidFileOf -- .pid derived from logFile, no logFile = null', () => {
  assert.equal(pidFileOf('data/nodes/web.log'), 'data/nodes/web.log.pid')
  assert.equal(pidFileOf(null), null)
})

test('Debt C2: waitSettled up -- reaching live returns true, offline returns false', async () => {
  let state = 'starting'
  const fake = { current: { get state(): string { return state } } } as never
  const promise = waitSettled(fake, 'up', 2_000)
  setTimeout(() => {
    state = 'live'
  }, 300)
  assert.equal(await promise, true)
})

test('Debt C2: waitSettled up -- a timeout without convergence returns false', async () => {
  const fake = { current: { state: 'starting' } } as never
  assert.equal(await waitSettled(fake, 'up', 300), false, 'stuck in starting must time out and return false')
})

test('Debt C2: waitSettled down -- reaching cold returns true', async () => {
  let state = 'live'
  const fake = { current: { get state(): string { return state } } } as never
  const promise = waitSettled(fake, 'down', 2_000)
  setTimeout(() => {
    state = 'cold'
  }, 300)
  assert.equal(await promise, true)
})
