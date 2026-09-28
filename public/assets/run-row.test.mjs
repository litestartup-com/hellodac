import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runRow } from './run-row.js'

import { useTestDictionary, testDictionary } from './test-i18n.mjs'

useTestDictionary('en')
const DICT = testDictionary('en')

/**
 * UI trim (DAC v1.0.0) regression: the task row body collapses to 2 lines by default and can expand.
 *
 * Measured over the last 40 run bodies before the change: median 315 characters, p90 1360, longest 2266,
 * 65% contained line breaks and none were truncated -- one screen showed only two or three tasks.
 *
 * The collapse is pure frontend (the body is already in the DOM), so what is asserted here is the render
 * contract: the clamped class (2 lines by default, so the full text never flashes first), line breaks kept
 * (pre-line), and an expand button that starts hidden (runs.js measures the height before revealing it).
 */

const RUN = {
  agentName: 'personal',
  trigger: 'manual',
  state: 'done',
  summary: 'first line\nsecond line\nthird line very long very long very long very long very long very long very long very long very long very long very long very long',
  startedAt: Date.now() - 60_000,
}

test('UI trim: the task body collapses to 2 lines by default (clamped), it is not spread out in full', () => {
  const html = runRow(RUN)
  assert.ok(html.includes('run-body clamped'), 'the body carries the collapse class')
  assert.ok(html.includes('data-run-body'), 'the body can be located (for the post-layout measurement)')
  assert.ok(!html.includes('node-detail'), 'the untruncated node-detail is gone')
})

test('UI trim: the expand button starts hidden -- whether it appears is decided by the real overflow after layout', () => {
  const html = runRow(RUN)
  assert.ok(html.includes('data-run-toggle'), 'there is an expand control')
  assert.ok(/data-run-toggle hidden/.test(html), 'hidden by default (a short task must not grow a useless control)')
  assert.ok(html.includes(DICT['runs.expand']), 'the button text goes through the dictionary')
})

test('UI trim: the body keeps its original line breaks (65% of task bodies contain them; squashed into one line they are harder to read)', () => {
  const html = runRow(RUN)
  assert.ok(html.includes('first line\nsecond line'), 'line breaks are kept as written (rendered with CSS pre-line)')
})

test('UI trim: a task with no body renders neither the body block nor the expand button', () => {
  const html = runRow({ ...RUN, summary: null, error: null })
  assert.ok(!html.includes('data-run-body'), 'no empty body block is rendered')
  assert.ok(!html.includes('data-run-toggle'), 'and no expand button either')
})

test('UI trim: a failed task uses error as the body, collapsed the same way', () => {
  const html = runRow({ ...RUN, state: 'failed', summary: null, error: 'boom: ' + 'x'.repeat(300) })
  assert.ok(html.includes('run-body clamped'), 'the error collapses the same way')
  assert.ok(html.includes('boom:'), 'the error content is there')
})

test('UI trim: state / trigger / time and the chat link are unaffected by the collapse', () => {
  const html = runRow({ ...RUN, sourceChatId: 'chat-1', conflict: 'workspace busy' })
  assert.ok(html.includes('personal'), 'the agent name is there')
  assert.ok(html.includes(DICT['runs.state.done']), 'the state wording is there')
  assert.ok(html.includes(DICT['runs.trigger.manual']), 'the trigger source is there')
  assert.ok(html.includes('/chat/chat-1'), 'the chat link is there')
  assert.ok(html.includes(DICT['runs.conflict']), 'the conflict badge is there')
})

test('UI trim: HTML in the body must be escaped (the collapse does not change the escaping contract)', () => {
  const html = runRow({ ...RUN, summary: '<img src=x onerror=alert(1)>' })
  assert.ok(!html.includes('<img'), 'no real tag is produced')
  assert.ok(html.includes('&lt;img'), 'it comes out escaped')
})
