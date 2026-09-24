import assert from 'node:assert/strict'
import test from 'node:test'
import type { HistoryEvent } from '../gateway/client.js'
import { compactHistory } from './replay.js'

let seq = 0
const chunk = (type: string, text: string): HistoryEvent => ({ kind: 'chunk', seq: (seq += 1), chunk: { type, text } })
const event = (kind: string, extra: Record<string, unknown> = {}): HistoryEvent => ({ kind, seq: (seq += 1), ...extra })

/** The chunk payload at `index`, asserting the event is there at all. */
const chunkAt = (events: HistoryEvent[], index: number): unknown => {
  const found = events[index]
  assert.ok(found !== undefined, `expected an event at index ${index}, got ${events.length} events`)
  return found.chunk
}

test('drops text chunks of a turn that produced a message', () => {
  // The message frame is authoritative and the client clears the streamed copy
  // when it lands, so these chunks cannot affect what is drawn.
  const history = [
    event('user', { text: 'hi' }),
    event('turn_start'),
    chunk('text-delta', 'he'),
    chunk('text-delta', 'llo'),
    event('message', { text: 'hello' }),
    event('turn_end', { reason: 'completed' }),
  ]
  const out = compactHistory(history)
  assert.deepEqual(
    out.map((e) => e.kind),
    ['user', 'turn_start', 'message', 'turn_end'],
  )
})

test('merges text chunks of a turn that never produced a message', () => {
  // A cancelled turn has nothing but chunks; dropping them would erase a partial
  // answer the user already paid for.
  const history = [
    event('turn_start'),
    chunk('text-delta', 'par'),
    chunk('text-delta', 'tial'),
    event('turn_end', { reason: 'aborted' }),
  ]
  const out = compactHistory(history)
  assert.deepEqual(
    out.map((e) => e.kind),
    ['turn_start', 'chunk', 'turn_end'],
  )
  assert.deepEqual(chunkAt(out, 1), { type: 'text-delta', text: 'partial' })
})

test('merges reasoning chunks rather than dropping them', () => {
  const history = [
    event('turn_start'),
    chunk('reasoning-delta', 'th'),
    chunk('reasoning-delta', 'ink'),
    event('message', { text: 'done' }),
    event('turn_end', { reason: 'completed' }),
  ]
  const out = compactHistory(history)
  assert.deepEqual(
    out.map((e) => e.kind),
    ['turn_start', 'chunk', 'message', 'turn_end'],
  )
  assert.deepEqual(chunkAt(out, 1), { type: 'reasoning-delta', text: 'think' })
})

test('keeps chunk position relative to tool calls', () => {
  const history = [
    event('turn_start'),
    chunk('reasoning-delta', 'a'),
    event('tool_call', { name: 'read' }),
    event('tool_result', { isError: false }),
    chunk('reasoning-delta', 'b'),
    event('message', { text: 'x' }),
    event('turn_end', { reason: 'completed' }),
  ]
  const out = compactHistory(history)
  assert.deepEqual(
    out.map((e) => e.kind),
    ['turn_start', 'chunk', 'tool_call', 'tool_result', 'message', 'turn_end'],
  )
  assert.deepEqual(chunkAt(out, 1), { type: 'reasoning-delta', text: 'ab' })
})

test('compacts each turn independently', () => {
  // The second turn has no message, so its chunks must survive even though the
  // first turn's were dropped.
  const history = [
    event('turn_start'),
    chunk('text-delta', 'one'),
    event('message', { text: 'one' }),
    event('turn_end', { reason: 'completed' }),
    event('turn_start'),
    chunk('text-delta', 'two'),
    event('turn_end', { reason: 'aborted' }),
  ]
  const out = compactHistory(history)
  assert.deepEqual(
    out.map((e) => e.kind),
    ['turn_start', 'message', 'turn_end', 'turn_start', 'chunk', 'turn_end'],
  )
})

test('handles a turn still in flight, with no turn_end', () => {
  const history = [event('turn_start'), chunk('text-delta', 'partial')]
  const out = compactHistory(history)
  assert.deepEqual(
    out.map((e) => e.kind),
    ['turn_start', 'chunk'],
  )
})

test('leaves a history with no chunks untouched', () => {
  const history = [event('user', { text: 'hi' }), event('message', { text: 'yo' }), event('turn_end')]
  assert.deepEqual(compactHistory(history), history)
})

test('does not mutate the events it was given', () => {
  const original = chunk('text-delta', 'a')
  const second = chunk('text-delta', 'b')
  compactHistory([event('turn_start'), original, second, event('turn_end')])
  assert.deepEqual(original.chunk, { type: 'text-delta', text: 'a' }, 'the caller\'s event was rewritten')
})

test('empty history stays empty', () => {
  assert.deepEqual(compactHistory([]), [])
})
