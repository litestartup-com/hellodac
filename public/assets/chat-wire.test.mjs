// Debt F1: frame dispatch and buffer reconciliation tests for chat-wire -- pin the behaviour down before the wire layer moves out.
//
// handleFrame is the core of the live stream: frames are buffered while loading, turn_queued goes into the dock,
// a goal lands in state directly, turn_start moves the queue, turn_done triggers a reload. Driven directly with
// fake refs, so it never touches EventSource or the DOM.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeWire, alreadyLoaded } from './chat-wire.js'

const box = (init) => {
  let value = init
  return {
    get value() { return value },
    set value(v) { value = v },
  }
}

const makeRefs = () => ({
  state: box(null),
  pendingUserTexts: box([]),
  queuedItems: box([]),
  blocks: box([]),
  sending: box(false),
  turnStartedAt: box(null),
  modelChoices: box(new Map()),
  modelCatalogSessionId: box(null),
  buffered: box([]),
  loading: box(false),
})

/** Fake deps that implement only the surface handleFrame needs. */
const makeDeps = (refs) => {
  const calls = { render: 0, reload: 0, loadModels: 0, loadDelegations: 0 }
  const wire = makeWire(refs, {
    render: () => { calls.render += 1 },
    reload: () => { calls.reload += 1 },
    loadModels: () => { calls.loadModels += 1 },
    loadDelegations: () => { calls.loadDelegations += 1 },
    trackAsks: () => {},
    reduce: (list, frame) => (frame.kind === 'chunk' ? [{ kind: 'chunk', text: frame.chunk.text }] : list),
    uniqueFrames: (list) => list,
    build: (events) => events.map((e) => ({ kind: e.kind })),
    fatal: () => {},
    renderDelegations: () => {},
  })
  return { wire, calls }
}

test('debt F1: hello/composer_state/delegation_done do not enter the transcript', () => {
  const refs = makeRefs()
  refs.state.value = { composer: {} }
  const { wire, calls } = makeDeps(refs)
  wire.handleFrame({ kind: 'hello' })
  wire.handleFrame({ kind: 'composer_state', accessMode: 'read-only' })
  wire.handleFrame({ kind: 'delegation_done' })
  assert.equal(refs.blocks.value.length, 0)
  assert.equal(calls.loadDelegations, 1, 'delegation_done triggers a delegation refetch')
  assert.equal(calls.render, 1, 'composer_state triggers a repaint')
})

test('debt F1: frames are buffered while loading, the transcript is untouched', () => {
  const refs = makeRefs()
  refs.loading.value = true
  const { wire, calls } = makeDeps(refs)
  wire.handleFrame({ kind: 'chunk', chunk: { text: 'x' } })
  wire.handleFrame({ kind: 'turn_queued', id: 'q1', text: 'y' })
  assert.equal(refs.blocks.value.length, 0)
  assert.equal(refs.buffered.value.length, 2)
  assert.equal(calls.render, 0)
})

test('debt F1: while idle turn_queued goes straight into the dock and repaints', () => {
  const refs = makeRefs()
  const { wire, calls } = makeDeps(refs)
  wire.handleFrame({ kind: 'turn_queued', id: 'q1', text: 'queued message' })
  assert.deepEqual(refs.queuedItems.value.map((q) => q.text), ['queued message'])
  assert.equal(calls.render, 1)
})

test('debt F1: turn_start moves the head of the dock queue into pendingUserTexts', () => {
  const refs = makeRefs()
  refs.queuedItems.value = [{ id: 'q1', text: 'queued message', at: 1 }]
  const { wire } = makeDeps(refs)
  wire.handleFrame({ kind: 'turn_start' })
  assert.equal(refs.queuedItems.value.length, 0)
  assert.equal(refs.pendingUserTexts.value.length, 1)
  assert.equal(refs.turnStartedAt.value !== null, true, 'the start time is recorded on turn_start')
})

test('debt F1: a goal frame lands in state.goal, it does not enter blocks', () => {
  const refs = makeRefs()
  refs.state.value = {}
  const { wire, calls } = makeDeps(refs)
  wire.handleFrame({ kind: 'goal', goal: { id: 'g1', objective: 'go live', phase: 'active' } })
  assert.equal(refs.state.value.goal.id, 'g1')
  assert.equal(refs.blocks.value.length, 0)
  assert.equal(calls.render, 1)
})

test('debt F1: turn_done clears sending/the clock and triggers a reload', () => {
  const refs = makeRefs()
  refs.sending.value = true
  refs.turnStartedAt.value = 1000
  const { wire, calls } = makeDeps(refs)
  wire.handleFrame({ kind: 'turn_done', state: 'done' })
  assert.equal(refs.sending.value, false)
  assert.equal(refs.turnStartedAt.value, null)
  assert.equal(calls.reload, 1)
})

test('debt F1: an ordinary frame folds into the transcript and repaints', () => {
  const refs = makeRefs()
  const { wire, calls } = makeDeps(refs)
  wire.handleFrame({ kind: 'chunk', chunk: { text: 'hello' } })
  assert.equal(refs.blocks.value.length, 1)
  assert.equal(calls.render, 1)
})

test('debt F1: alreadyLoaded dedupes by seq, a user echo is compared by text', () => {
  const list = [{ role: 'user', text: 'hi' }]
  assert.equal(alreadyLoaded({ kind: 'chunk', seq: 5 }, 9, list), true, 'seq <= maxSeq counts as already loaded')
  assert.equal(alreadyLoaded({ kind: 'chunk', seq: 11 }, 9, list), false)
  assert.equal(alreadyLoaded({ kind: 'user', text: 'hi' }, 9, list), true, 'a user echo with the same text counts as already loaded')
  assert.equal(alreadyLoaded({ kind: 'user', text: 'different' }, 9, list), false)
  assert.equal(alreadyLoaded({ kind: 'turn_done' }, 9, list), false, 'a manager frame without seq is safe to replay')
})
