import { test } from 'node:test'
import assert from 'node:assert/strict'
import { auditRow, KIND_META, kindLabel } from './audit-row.js'

import { useTestDictionary, testDictionary } from './test-i18n.mjs'

useTestDictionary('en')
const DICT = testDictionary('en')

/**
 * UI slimming (DAC v1.0.0): the audit page moved from a shadowed card per row to the in-site hairline list language.
 *
 * What is asserted is the render contract, not specific pixels:
 *   - every row is .row (hairline separated), no longer .node-row (a standalone card)
 *   - the semantic dot covers every known event type, unknown types fall back to grey (a new event never renders as a dotless row)
 *   - the time sits on the right of the row (the justify-between side of row-main)
 *   - detail is escaped, and an empty detail is not rendered
 */
const EVENT = { kind: 'login_success', actor: 'admin', at: Date.now() - 60_000, detail: 'from 192.168.0.1' }

test('audit row: the hairline list language, not one card per row', () => {
  const html = auditRow(EVENT)
  assert.ok(html.startsWith('<div class="row">'), `a row should be .row (actual start: ${html.slice(0, 50)})`)
  assert.ok(!html.includes('node-row'), 'the node-row card shape is no longer reused')
  assert.ok(html.includes('row-main'), 'the main row is there (title + time on one line)')
  assert.ok(html.includes('row-title'), 'the title is there')
})

test('audit row: semantic dots -- failure red, destructive orange, health green, neutral grey', () => {
  assert.equal(KIND_META.login_failed, 'bad')
  assert.equal(KIND_META.node_delete, 'warn')
  assert.equal(KIND_META.node_down, 'warn')
  assert.equal(KIND_META.node_restart, 'warn')
  assert.equal(KIND_META.login_success, 'ok')
  assert.equal(KIND_META.node_up, 'ok')
  assert.equal(KIND_META.backup, 'ok')
  assert.equal(KIND_META.node_create, 'muted')
})

test('audit row: a known event renders its dot, the text comes from the dictionary', () => {
  const html = auditRow({ ...EVENT, kind: 'login_failed' })
  assert.ok(html.includes('dot bad'), 'a failed event is a red dot')
  assert.ok(html.includes(DICT['audit.kind.login_failed']), 'the text is the translation, not the key name')
})

test('audit row: an unknown event type falls back to a grey dot and shows the raw kind (no crash, not empty)', () => {
  const html = auditRow({ ...EVENT, kind: 'some_future_kind' })
  assert.ok(html.includes('dot muted'), 'an unknown type falls back to grey')
  assert.ok(html.includes('some_future_kind'), 'the raw kind is visible')
  assert.equal(kindLabel('some_future_kind'), 'some_future_kind', 'a missing key falls back to the kind itself')
})

test('audit row: the time on the right, the actor inside the title, detail on the second line', () => {
  const html = auditRow(EVENT)
  const mainIdx = html.indexOf('row-main')
  const titleIdx = html.indexOf('row-title')
  const timeIdx = html.indexOf('muted small')
  const detailIdx = html.indexOf('detail')
  // Structural order: row-main wraps row-title (dot + event + actor) and the time on the right;
  // detail is its own line after row-main.
  assert.ok(mainIdx < titleIdx && titleIdx < timeIdx, `the title precedes the time (main=${mainIdx} title=${titleIdx} time=${timeIdx})`)
  assert.ok(html.includes('· admin'), 'the actor is on the same line as the event name')
  assert.ok(mainIdx < detailIdx, 'detail becomes a line after main')
})

test('audit row: detail is escaped; an empty detail renders no detail line', () => {
  const evil = auditRow({ ...EVENT, detail: '<img src=x onerror=alert(1)>' })
  assert.ok(!evil.includes('<img'), 'the HTML is escaped')
  assert.ok(evil.includes('&lt;img'), 'readable once escaped')
  const none = auditRow({ ...EVENT, detail: null })
  assert.ok(!none.includes('detail'), 'an empty detail gets no empty line')
})
