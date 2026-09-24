import { test } from 'node:test'
import assert from 'node:assert/strict'
import { useTestDictionary } from './test-i18n.mjs'

useTestDictionary('en')

const { runRow, runsQuery, runStateLabel, triggerLabel } = await import('./run-row.js')

test('UI 收尾 A: 任务行——状态点/文案/冲突/会话链接/摘要', () => {
  const base = {
    id: 'r1',
    agentId: 'spike02',
    agentName: 'spike02',
    trigger: 'manual',
    state: 'done',
    summary: '写完了周报',
    error: null,
    sourceChatId: 'c-1',
    conflict: null,
    startedAt: Date.now() - 60_000,
  }
  const html = runRow(base)
  assert.ok(html.includes('dot ok'), 'done 绿点')
  assert.ok(html.includes('done'))
  assert.ok(html.includes('manual'))
  assert.ok(html.includes('写完了周报'))
  assert.ok(html.includes('/chat/c-1'), '会话链接')
  assert.ok(!html.includes('conflict'), '无冲突不渲染徽标')

  const failed = runRow({ ...base, state: 'failed', summary: null, error: 'boom', sourceChatId: null })
  assert.ok(failed.includes('dot bad'), 'failed 红点')
  assert.ok(failed.includes('failed'))
  assert.ok(failed.includes('boom'), 'summary 为空时回退 error')
  assert.ok(!failed.includes('Session ›'), '无 sourceChatId 不渲染链接')

  const running = runRow({ ...base, state: 'running', startedAt: Date.now() - 5_000_000 })
  assert.ok(running.includes('dot busy'), 'running 忙点')
  assert.ok(running.includes('running'), 'running 显示进行中而非时长')

  const conflict = runRow({ ...base, conflict: '另一任务占用' })
  assert.ok(conflict.includes('conflict'), '冲突徽标')
  assert.ok(conflict.includes('另一任务占用'), '冲突原因进 title')

  const unknown = runRow({ ...base, state: 'weird', trigger: 'aliens' })
  assert.ok(unknown.includes('weird'), '未知状态回退原文')
  assert.ok(unknown.includes('aliens'), '未知触发回退原文')
})

test('UI 收尾 A: 标签完整覆盖全部状态与触发来源（惰性求值，字典注入后即可翻译）', () => {
  assert.deepEqual(['pending', 'running', 'done', 'failed', 'missed'].map(runStateLabel), ['queued', 'running', 'done', 'failed', 'missed'])
  assert.deepEqual(['manual', 'cron', 'api', 'capture', 'brain'].map(triggerLabel), ['manual', 'cron', 'API', 'capture', 'brain'])
  // 未知值不炸：回退键名而不是 undefined
  assert.equal(runStateLabel('weird'), 'runs.state.weird')
})

test('UI 收尾 A: runsQuery——筛选与游标组合', () => {
  assert.equal(runsQuery({}), '')
  assert.equal(runsQuery({ agentId: 'spike02' }), 'agent_id=spike02')
  assert.equal(runsQuery({ state: 'failed' }), 'state=failed')
  assert.equal(runsQuery({ agentId: 'spike02', state: 'done', before: 1730000000000 }), 'agent_id=spike02&state=done&before=1730000000000')
  assert.equal(runsQuery({ before: null }), '', '空游标 = 第一页')
  assert.equal(runsQuery({ before: 0 }), '', '0 不算游标')
})
