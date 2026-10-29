import { test } from 'node:test'
import assert from 'node:assert/strict'
import { approvalRow } from './approvals-row.js'
import { useTestDictionary } from './test-i18n.mjs'

useTestDictionary('en')
test('a pending prompt renders decide buttons and its tool/agent/time', () => {
  const html = approvalRow({
    id: 'd-1', agentId: 'kanban-dev-1', toolName: 'bash', reason: 'needs a shell',
    state: 'pending', outcome: null, createdAt: 1_700_000_000_000, resolvedAt: null,
  })
  assert.match(html, /data-approval="d-1"/)
  assert.match(html, /data-decide="allowed-once"/)
  assert.match(html, /data-decide="rejected"/)
  assert.match(html, /kanban-dev-1/)
  assert.match(html, /bash/)
})

test('a resolved prompt renders its outcome instead of buttons', () => {
  const html = approvalRow({
    id: 'd-2', agentId: 'kanban-brain', toolName: 'mail', reason: null,
    state: 'resolved', outcome: 'allowed-once', createdAt: 1_700_000_000_000, resolvedAt: 1_700_000_060_000,
  })
  assert.doesNotMatch(html, /data-decide/)
  assert.match(html, /kanban-brain/)
})
