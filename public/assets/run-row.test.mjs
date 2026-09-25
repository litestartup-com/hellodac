import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runRow } from './run-row.js'

import { useTestDictionary, testDictionary } from './test-i18n.mjs'

useTestDictionary('en')
const DICT = testDictionary('en')

/**
 * UI 精简（DAC v1.0.0）回归：任务行正文默认 2 行折叠 + 可展开。
 *
 * 改前实测最近 40 条 run 的正文：中位 315 字、p90 1360 字、最长 2266 字，
 * 65% 含换行，且没有任何截断——一屏只看得到两三条任务。
 *
 * 折叠是纯前端（正文本来就在 DOM 里），所以这里断言的是渲染契约：
 * 带 clamped 类（默认就是 2 行，不会先闪一下全文）、保留换行（pre-line）、
 * 有展开按钮且默认隐藏（由 runs.js 量完高度再决定是否露出）。
 */

const RUN = {
  agentName: 'personal',
  trigger: 'manual',
  state: 'done',
  summary: '第一行\n第二行\n第三行很长很长很长很长很长很长很长很长很长很长很长很长',
  startedAt: Date.now() - 60_000,
}

test('UI 精简: 任务正文默认 2 行折叠（clamped），不是整段铺开', () => {
  const html = runRow(RUN)
  assert.ok(html.includes('run-body clamped'), '正文带折叠类')
  assert.ok(html.includes('data-run-body'), '正文可被定位（收尾测量用）')
  assert.ok(!html.includes('node-detail'), '不再用无截断的 node-detail')
})

test('UI 精简: 展开按钮默认隐藏——是否露出由布局后的真实溢出决定', () => {
  const html = runRow(RUN)
  assert.ok(html.includes('data-run-toggle'), '有展开开关')
  assert.ok(/data-run-toggle hidden/.test(html), '默认隐藏（短任务不该多一个没用的控件）')
  assert.ok(html.includes(DICT['runs.expand']), '按钮文案走字典')
})

test('UI 精简: 正文保留原始换行（65% 的任务正文含换行，挤成一行更难读）', () => {
  const html = runRow(RUN)
  assert.ok(html.includes('第一行\n第二行'), '换行原样保留（CSS 用 pre-line 呈现）')
})

test('UI 精简: 没有正文的任务不渲染正文块与展开按钮', () => {
  const html = runRow({ ...RUN, summary: null, error: null })
  assert.ok(!html.includes('data-run-body'), '不渲染空的正文块')
  assert.ok(!html.includes('data-run-toggle'), '也不给展开按钮')
})

test('UI 精简: 失败任务用 error 当正文，同样折叠', () => {
  const html = runRow({ ...RUN, state: 'failed', summary: null, error: 'boom: ' + 'x'.repeat(300) })
  assert.ok(html.includes('run-body clamped'), '错误同样折叠')
  assert.ok(html.includes('boom:'), '错误内容在')
})

test('UI 精简: 状态/触发/时间与会话链接不受折叠影响', () => {
  const html = runRow({ ...RUN, sourceChatId: 'chat-1', conflict: 'workspace busy' })
  assert.ok(html.includes('personal'), 'agent 名在')
  assert.ok(html.includes(DICT['runs.state.done']), '状态文案在')
  assert.ok(html.includes(DICT['runs.trigger.manual']), '触发来源在')
  assert.ok(html.includes('/chat/chat-1'), '会话链接在')
  assert.ok(html.includes(DICT['runs.conflict']), '冲突徽标在')
})

test('UI 精简: 正文里的 HTML 必须转义（折叠不改变转义契约）', () => {
  const html = runRow({ ...RUN, summary: '<img src=x onerror=alert(1)>' })
  assert.ok(!html.includes('<img'), '不产生真实标签')
  assert.ok(html.includes('&lt;img'), '转义后呈现')
})
