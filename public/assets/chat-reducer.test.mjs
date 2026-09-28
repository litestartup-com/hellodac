// Debt F1: chat-reducer pure-function tests -- the reducer is the core of "one transcript, one rendering";
// before splitting it out of chat.js, pin the behaviour down with tests (red -> green) and only then have chat.js use it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { useTestDictionary } from './test-i18n.mjs'

useTestDictionary('en')

const { newAgentBlock, reduce, attachRuns, build } = await import('./chat-reducer.js')

test('debt F1: a chunk opens an agent block even without turn_start (a resumed chat promises no turn_start)', () => {
  const list = reduce([], { kind: 'chunk', chunk: { type: 'text-delta', text: 'hello' } })
  assert.equal(list.length, 1)
  assert.equal(list[0].role, 'agent')
  assert.equal(list[0].streamed, 'hello')
  assert.equal(list[0].streaming, true)
})

test('debt F1: the message frame is authoritative -- the streaming preview is replaced, not appended', () => {
  let list = reduce([], { kind: 'chunk', chunk: { type: 'text-delta', text: 'preview' } })
  list = reduce(list, { kind: 'message', text: 'final', reasoning: '', usage: null })
  assert.equal(list[0].text, 'final')
  assert.equal(list[0].streamed, '')
  assert.equal(list[0].streaming, false)
})

test('debt F1: several message frames append in order, with usage summed', () => {
  let list = reduce([], { kind: 'message', text: 'foo', usage: { inputTokens: 10, outputTokens: 5 } })
  list = reduce(list, { kind: 'message', text: 'bar', usage: { inputTokens: 0, outputTokens: 3 } })
  assert.equal(list[0].text, 'foobar')
  assert.deepEqual(list[0].usage, { inputTokens: 10, outputTokens: 8, reasoningTokens: 0 })
})

test('debt F1: system injection folds away -- a <system-reminder> wrapper or a preceding user both count', () => {
  let list = reduce([], { kind: 'user', text: 'the real question' })
  list = reduce(list, { kind: 'user', text: '<system-reminder>context</system-reminder>' })
  assert.equal(list[1].injected, true)
  list = reduce(list, { kind: 'user', text: 'another one' })
  assert.equal(list[2].injected, true, 'a user after a user counts as injected')
})

test('debt F1: tool_result goes to the newest unfinished call in arrival order; failure and text land there', () => {
  let list = reduce([], { kind: 'tool_call', name: 'write', arguments: '{"path":"a.txt"}' })
  list = reduce(list, { kind: 'tool_call', name: 'read', arguments: '{}' })
  list = reduce(list, { kind: 'tool_result', isError: true, text: 'boom' })
  assert.equal(list[0].tools[0].done, false)
  assert.equal(list[0].tools[1].done, true)
  assert.equal(list[0].tools[1].failed, true)
  assert.equal(list[0].tools[1].resultText, 'boom')
})

test('debt F1: tool_call lands the path/write flags (several spellings of the path key)', () => {
  const list = reduce([], { kind: 'tool_call', name: 'edit_file', arguments: '{"file_path":"b.md"}' })
  assert.equal(list[0].tools[0].path, 'b.md')
  assert.equal(list[0].tools[0].write, true)
})

test('debt F1: the wording of turn_end error/aborted and how detail is extracted', () => {
  let list = reduce([], { kind: 'turn_end', reason: 'error', detail: { message: 'boom' } })
  assert.equal(list[0].error, 'boom')
  list = reduce([], { kind: 'turn_end', reason: 'aborted', detail: { cause: 'user_cancelled' } })
  assert.equal(list[0].error, 'cancelled')
  list = reduce([], { kind: 'turn_end', reason: 'aborted', detail: { cause: 'timeout' } })
  assert.equal(list[0].error, 'the turn was interrupted')
})

test('debt F1: turn_done closes the turn when no turn_end arrived (timeout / dropped stream)', () => {
  let list = reduce([], { kind: 'chunk', chunk: { type: 'text-delta', text: 'x' } })
  list = reduce(list, { kind: 'turn_done', runId: 'r1', state: 'failed', error: 'timed out' })
  assert.equal(list[0].reason, 'error')
  assert.equal(list[0].runId, 'r1')
  assert.equal(list[0].runState, 'failed')
  assert.equal(list[0].error, 'timed out')
})

test('debt F1: approval_asked/decided only flips awaiting, leaving the transcript alone', () => {
  let list = reduce([], { kind: 'approval_asked', toolName: 'write', reason: 'dangerous' })
  assert.deepEqual(list[0].awaiting, { toolName: 'write', reason: 'dangerous' })
  list = reduce(list, { kind: 'approval_decided' })
  assert.equal(list[0].awaiting, null)
})

test('debt F1: attachRuns does not guess when the counts differ -- it drops the whole attachment', () => {
  const list = reduce([], { kind: 'message', text: 'x', usage: null })
  const runs = [{ id: 'a' }, { id: 'b' }]
  const out = attachRuns(list, runs)
  assert.equal(out[0].run, undefined, 'a count mismatch must not attach runs by position')
})

test('debt F1: attachRuns attaches by position when the counts match and backfills runId/runState/error', () => {
  const list = reduce([], { kind: 'message', text: 'x', usage: null })
  const runs = [{ id: 'a', state: 'done', error: 'boom', usage: null }]
  const out = attachRuns(list, runs)
  assert.equal(out[0].run.id, 'a')
  assert.equal(out[0].runId, 'a')
  assert.equal(out[0].runState, 'done')
  assert.equal(out[0].error, 'boom')
})

test('debt F1: build = reduce frame by frame + attachRuns', () => {
  const blocks = build(
    [
      { kind: 'user', text: 'hi' },
      { kind: 'message', text: 'yo', usage: null },
    ],
    [{ id: 'r1', state: 'done', error: null, usage: null }],
  )
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].role, 'user')
  assert.equal(blocks[1].run.id, 'r1')
})

test('debt F1: the initial shape of newAgentBlock (awaiting/usage/reason all empty)', () => {
  const b = newAgentBlock()
  assert.deepEqual(b, {
    role: 'agent', text: '', streamed: '', streaming: false, reasoning: '', tools: [],
    usage: null, reason: null, error: null, runId: null, runState: null, awaiting: null,
  })
})
