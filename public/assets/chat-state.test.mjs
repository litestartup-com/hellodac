// Debt F1: chat-state asks state-machine tests -- the open/close semantics of the question/approval cards.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeAsks } from './chat-state.js'

const setup = () => makeAsks()

test('debt F1: question_asked opens a card, question_resolved closes it by questionId', () => {
  const { track, size } = setup()
  track({ kind: 'question_asked', questionId: 'q1', questions: [{ id: 'a', question: 'which one?' }] })
  assert.equal(size(), 1)
  track({ kind: 'question_resolved', questionId: 'q1' })
  assert.equal(size(), 0)
})

test('debt F1: approval_pending opens a card and records the approvalId', () => {
  const { track, get } = setup()
  track({ kind: 'approval_pending', decisionId: 'd1', approvalId: 'ap-1', toolName: 'write', reason: 'dangerous' })
  assert.deepEqual(get('d1'), { kind: 'approval', id: 'd1', approvalId: 'ap-1', toolName: 'write', reason: 'dangerous' })
})

test('debt F1: approval_resolved without a decisionId closes the card by scanning approvalId (no request frame after a reconnect)', () => {
  const { track, size } = setup()
  track({ kind: 'approval_pending', decisionId: 'd1', approvalId: 'ap-9', toolName: 'write', reason: null })
  track({ kind: 'approval_resolved', approvalId: 'ap-9' })
  assert.equal(size(), 0)
})

test('debt F1: approval_resolved with a decisionId closes the card directly', () => {
  const { track, size } = setup()
  track({ kind: 'approval_pending', decisionId: 'd1', approvalId: 'ap-1', toolName: 'write', reason: null })
  track({ kind: 'approval_resolved', decisionId: 'd1', approvalId: 'ap-1' })
  assert.equal(size(), 0)
})

test('debt F1: turn_end/turn_done clears every card (the turn is over, nobody waits for an answer)', () => {
  const { track, size } = setup()
  track({ kind: 'question_asked', questionId: 'q1', questions: [] })
  track({ kind: 'approval_pending', decisionId: 'd1', approvalId: 'ap-1', toolName: 'x', reason: null })
  track({ kind: 'turn_end' })
  assert.equal(size(), 0)
})

test('debt F1: a malformed frame opens no card (missing questionId/decisionId, or questions not an array)', () => {
  const { track, size } = setup()
  track({ kind: 'question_asked', questions: [] })
  track({ kind: 'question_asked', questionId: 'q2', questions: 'not-array' })
  track({ kind: 'approval_pending', approvalId: 'ap-1', toolName: 'x', reason: null })
  assert.equal(size(), 0)
})

test('debt F1: the same questionId arriving twice overwrites the old card (idempotent by id)', () => {
  const { track, size, get } = setup()
  track({ kind: 'question_asked', questionId: 'q1', questions: [{ id: 'a', question: 'old' }] })
  track({ kind: 'question_asked', questionId: 'q1', questions: [{ id: 'b', question: 'new' }] })
  assert.equal(size(), 1)
  assert.equal(get('q1').questions[0].question, 'new')
})
