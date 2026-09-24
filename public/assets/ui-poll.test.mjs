// 债务 F4:poll(ui.js)行为测试——node:test + mock 时钟,CI test:web 常驻。
// 注意:mock.timers.tick 一次只推进「已排定」的定时器;tick 期间经微任务新
// 排的定时器要下一次 tick 才触发,所以断言按「一次 tick = 一轮调度」写。
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { poll } from './ui.js'

const setup = () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  globalThis.document = { hidden: false }
}

test('债务 F4: poll 按间隔周期调用 fn', async () => {
  setup()
  let calls = 0
  const stop = poll(() => {
    calls += 1
  }, 1_000)
  try {
    await mock.timers.tick(1_000)
    await mock.timers.tick(1_000)
    await mock.timers.tick(1_000)
    assert.equal(calls, 3, '每轮 1s 一次,三轮后 3 次')
  } finally {
    stop()
    mock.timers.reset()
  }
})

test('债务 F4: 页面隐藏时暂停轮询,不浪费后台请求', async () => {
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
    assert.equal(calls, 1, '隐藏期间不再调用 fn')
  } finally {
    stop()
    mock.timers.reset()
    delete globalThis.document
  }
})

test('债务 F4: fn 抛错按间隔退避(×2),成功后复位', async () => {
  setup()
  let failing = true
  let calls = 0
  const stop = poll(() => {
    calls += 1
    if (failing) throw new Error('boom')
  }, 1_000)
  try {
    await mock.timers.tick(1_000) // 第 1 次(失败)→ 退避到 2s
    assert.equal(calls, 1)
    await mock.timers.tick(1_000)
    assert.equal(calls, 1, '1s 时不得重试(已退避到 2s)')
    await mock.timers.tick(1_000) // t=3000 → 第 2 次(失败)→ 退避到 4s
    assert.equal(calls, 2, '2s 后重试')
    failing = false
    await mock.timers.tick(4_000) // t=7000 → 第 3 次(成功)→ 复位 1s
    assert.equal(calls, 3)
    await mock.timers.tick(1_000) // t=8000 → 第 4 次
    assert.equal(calls, 4, '成功后回到 1s 间隔')
  } finally {
    stop()
    mock.timers.reset()
  }
})

test('债务 F4: stop() 停止轮询', async () => {
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
    assert.equal(calls, 1, 'stop 后不得再调')
  } finally {
    stop()
    mock.timers.reset()
  }
})
