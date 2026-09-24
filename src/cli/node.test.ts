import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pidFileOf, waitSettled } from './node.js'

/**
 * 债务 C2:cli/node(节点管控 CLI)此前零覆盖。覆盖:
 * pidFileOf 派生规则;waitSettled 的 up/down 收敛与超时。
 * killByPidFile(taskkill spawn)与 main(process.exit 壳)不在单测范围。
 */

test('债务 C2: pidFileOf——logFile 派生 .pid,无 logFile = null', () => {
  assert.equal(pidFileOf('data/nodes/web.log'), 'data/nodes/web.log.pid')
  assert.equal(pidFileOf(null), null)
})

test('债务 C2: waitSettled up——到达 live 返回 true,offline 返回 false', async () => {
  let state = 'starting'
  const fake = { current: { get state(): string { return state } } } as never
  const promise = waitSettled(fake, 'up', 2_000)
  setTimeout(() => {
    state = 'live'
  }, 300)
  assert.equal(await promise, true)
})

test('债务 C2: waitSettled up——超时未收敛返回 false', async () => {
  const fake = { current: { state: 'starting' } } as never
  assert.equal(await waitSettled(fake, 'up', 300), false, '一直 starting 必须超时返回 false')
})

test('债务 C2: waitSettled down——到达 cold 返回 true', async () => {
  let state = 'live'
  const fake = { current: { get state(): string { return state } } } as never
  const promise = waitSettled(fake, 'down', 2_000)
  setTimeout(() => {
    state = 'cold'
  }, 300)
  assert.equal(await promise, true)
})
