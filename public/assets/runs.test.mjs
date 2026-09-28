import { test } from 'node:test'
import assert from 'node:assert/strict'
import { useTestDictionary } from './test-i18n.mjs'

useTestDictionary('en')

const { runRow, runsQuery, runStateLabel, triggerLabel } = await import('./run-row.js')

test('UI wrap-up A: the task row -- status dot / wording / conflict / chat link / summary', () => {
  const base = {
    id: 'r1',
    agentId: 'spike02',
    agentName: 'spike02',
    trigger: 'manual',
    state: 'done',
    summary: 'finished the weekly report',
    error: null,
    sourceChatId: 'c-1',
    conflict: null,
    startedAt: Date.now() - 60_000,
  }
  const html = runRow(base)
  assert.ok(html.includes('dot ok'), 'done is a green dot')
  assert.ok(html.includes('done'))
  assert.ok(html.includes('manual'))
  assert.ok(html.includes('finished the weekly report'))
  assert.ok(html.includes('/chat/c-1'), 'the chat link')
  assert.ok(!html.includes('conflict'), 'no conflict means no badge is rendered')

  const failed = runRow({ ...base, state: 'failed', summary: null, error: 'boom', sourceChatId: null })
  assert.ok(failed.includes('dot bad'), 'failed is a red dot')
  assert.ok(failed.includes('failed'))
  assert.ok(failed.includes('boom'), 'an empty summary falls back to error')
  assert.ok(!failed.includes('Session ›'), 'no sourceChatId means no link is rendered')

  const running = runRow({ ...base, state: 'running', startedAt: Date.now() - 5_000_000 })
  assert.ok(running.includes('dot busy'), 'running is a busy dot')
  assert.ok(running.includes('running'), 'running shows in progress rather than a duration')

  const conflict = runRow({ ...base, conflict: 'another task is using it' })
  assert.ok(conflict.includes('conflict'), 'the conflict badge')
  assert.ok(conflict.includes('another task is using it'), 'the conflict reason goes into the title')

  const unknown = runRow({ ...base, state: 'weird', trigger: 'aliens' })
  assert.ok(unknown.includes('weird'), 'an unknown state falls back to the raw value')
  assert.ok(unknown.includes('aliens'), 'an unknown trigger falls back to the raw value')
})

test('UI wrap-up A: the labels cover every state and trigger source (lazy evaluation, translatable once the dictionary is injected)', () => {
  assert.deepEqual(['pending', 'running', 'done', 'failed', 'missed'].map(runStateLabel), ['queued', 'running', 'done', 'failed', 'missed'])
  assert.deepEqual(['manual', 'cron', 'api', 'capture', 'brain'].map(triggerLabel), ['manual', 'cron', 'API', 'capture', 'brain'])
  // An unknown value does not blow up: it falls back to the key name rather than undefined
  assert.equal(runStateLabel('weird'), 'runs.state.weird')
})

test('UI wrap-up A: runsQuery -- filters combined with the cursor', () => {
  assert.equal(runsQuery({}), '')
  assert.equal(runsQuery({ agentId: 'spike02' }), 'agent_id=spike02')
  assert.equal(runsQuery({ state: 'failed' }), 'state=failed')
  assert.equal(runsQuery({ agentId: 'spike02', state: 'done', before: 1730000000000 }), 'agent_id=spike02&state=done&before=1730000000000')
  assert.equal(runsQuery({ before: null }), '', 'an empty cursor = the first page')
  assert.equal(runsQuery({ before: 0 }), '', '0 does not count as a cursor')
})
