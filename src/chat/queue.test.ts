import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cancelQueuedTurn, cancelQueuedTurns, closeQueues, drainChatQueue, enqueueTurn, queuedTurnsFor } from './queue.js'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5))

describe('chat queue (蜂群 P5.4: per-chat, sessions run in parallel)', () => {
  it('enqueues FIFO per chat and reports positions', () => {
    closeQueues()
    assert.equal(enqueueTurn('c1', { chatId: 'c1', id: 't-1', execute: async () => {} }), 1)
    assert.equal(enqueueTurn('c1', { chatId: 'c1', id: 't-2', execute: async () => {} }), 2)
    assert.equal(enqueueTurn('c2', { chatId: 'c2', id: 't-3', execute: async () => {} }), 1)
    assert.equal(queuedTurnsFor('c1'), 2)
    assert.equal(queuedTurnsFor('c2'), 1)
    closeQueues()
  })

  it('drains in order, one at a time, and continues after each turn', async () => {
    closeQueues()
    const order: string[] = []
    const make = (id: string) => async () => {
      order.push(id + ':start')
      await tick()
      order.push(id + ':end')
    }
    enqueueTurn('c1', { chatId: 'c1', id: 't-1', execute: make('one') })
    enqueueTurn('c1', { chatId: 'c1', id: 't-2', execute: make('two') })
    drainChatQueue('c1')
    await tick()
    await tick()
    await tick()
    await tick()
    assert.deepEqual(order, ['one:start', 'one:end', 'two:start', 'two:end'])
    assert.equal(queuedTurnsFor('c1'), 0)
    closeQueues()
  })

  it('a concurrent drain call is a no-op', async () => {
    closeQueues()
    let runs = 0
    enqueueTurn('c1', { chatId: 'c1', id: 't-1', execute: async () => { runs += 1; await tick() } })
    drainChatQueue('c1')
    drainChatQueue('c1')
    drainChatQueue('c1')
    await tick()
    await tick()
    assert.equal(runs, 1)
    closeQueues()
  })

  it('cancelQueuedTurn drops one item by id within the chat', async () => {
    closeQueues()
    const ran: string[] = []
    const make = (id: string) => async () => { ran.push(id) }
    enqueueTurn('c1', { id: 't1', chatId: 'c1', execute: make('t1') })
    enqueueTurn('c1', { id: 't2', chatId: 'c1', execute: make('t2') })
    enqueueTurn('c1', { id: 't3', chatId: 'c1', execute: make('t3') })
    cancelQueuedTurn('c1', 't2')
    assert.equal(queuedTurnsFor('c1'), 2)
    drainChatQueue('c1')
    await tick()
    await tick()
    await tick()
    assert.deepEqual(ran, ['t1', 't3'])
    closeQueues()
  })

  it('cancelQueuedTurns drops only the given chat', () => {
    closeQueues()
    enqueueTurn('c1', { chatId: 'c1', id: 't-c1', execute: async () => {} })
    enqueueTurn('c1', { chatId: 'c1', id: 't-c1b', execute: async () => {} })
    enqueueTurn('c2', { chatId: 'c2', id: 't-c2', execute: async () => {} })
    cancelQueuedTurns('c1')
    assert.equal(queuedTurnsFor('c1'), 0)
    assert.equal(queuedTurnsFor('c2'), 1)
    closeQueues()
  })
})
