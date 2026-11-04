import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cronRow } from './crons-row.js'
import { useTestDictionary } from './test-i18n.mjs'

useTestDictionary('en')

const CRON = {
  id: 'c-1', name: 'duty-call', agentName: 'kanban-brain', schedule: '*/20 * * * *',
  enabled: true, nextRunAt: null, lastRunAt: null, lastState: null,
}

test('a cron row renders a checked toggle and the edit button', () => {
  const html = cronRow(CRON)
  assert.match(html, /data-cron="c-1"/)
  assert.match(html, /data-toggle/)
  assert.match(html, /checked/)
  assert.match(html, /data-edit/)
  assert.match(html, /duty-call/)
})

test('a disabled cron renders an unchecked toggle', () => {
  const html = cronRow({ ...CRON, enabled: false })
  assert.match(html, /data-toggle/)
  assert.doesNotMatch(html, /checked/)
})
