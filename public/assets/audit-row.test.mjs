import { test } from 'node:test'
import assert from 'node:assert/strict'
import { auditRow, KIND_META, kindLabel } from './audit-row.js'

import { useTestDictionary, testDictionary } from './test-i18n.mjs'

useTestDictionary('en')
const DICT = testDictionary('en')

/**
 * UI 精简（DAC v1.0.0）：审计页从「每行一张阴影卡」改成站内 hairline 列表语言。
 *
 * 断言的是渲染契约，而不是具体像素：
 *   - 每行是 .row（hairline 分隔），不再是 .node-row（独立卡片）
 *   - 语义色点覆盖全部已知事件类型，未知类型灰兜底（新增事件不会渲染成无点行）
 *   - 时间在行右侧（row-main 的 justify-between 一侧）
 *   - detail 转义、为空时不渲染
 */
const EVENT = { kind: 'login_success', actor: 'admin', at: Date.now() - 60_000, detail: 'from 192.168.0.1' }

test('审计行: hairline 列表语言，不是每行一张卡片', () => {
  const html = auditRow(EVENT)
  assert.ok(html.startsWith('<div class="row">'), `行应是 .row（实际开头：${html.slice(0, 50)}）`)
  assert.ok(!html.includes('node-row'), '不再复用节点行的卡片形态')
  assert.ok(html.includes('row-main'), '主行在（标题+时间一行）')
  assert.ok(html.includes('row-title'), '标题在')
})

test('审计行: 语义色点——失败红、破坏性橙、健康绿、中性灰', () => {
  assert.equal(KIND_META.login_failed, 'bad')
  assert.equal(KIND_META.node_delete, 'warn')
  assert.equal(KIND_META.node_down, 'warn')
  assert.equal(KIND_META.node_restart, 'warn')
  assert.equal(KIND_META.login_success, 'ok')
  assert.equal(KIND_META.node_up, 'ok')
  assert.equal(KIND_META.backup, 'ok')
  assert.equal(KIND_META.node_create, 'muted')
})

test('审计行: 已知事件渲染对应色点，文案走字典', () => {
  const html = auditRow({ ...EVENT, kind: 'login_failed' })
  assert.ok(html.includes('dot bad'), '失败事件是红点')
  assert.ok(html.includes(DICT['audit.kind.login_failed']), '文案是译文不是键名')
})

test('审计行: 未知事件类型灰点兜底，显示原始 kind（不炸、不空）', () => {
  const html = auditRow({ ...EVENT, kind: 'some_future_kind' })
  assert.ok(html.includes('dot muted'), '未知类型灰兜底')
  assert.ok(html.includes('some_future_kind'), 'kind 原文可见')
  assert.equal(kindLabel('some_future_kind'), 'some_future_kind', '缺键回退 kind 本身')
})

test('审计行: 时间在右侧、actor 在标题内、detail 在第二行', () => {
  const html = auditRow(EVENT)
  const mainIdx = html.indexOf('row-main')
  const titleIdx = html.indexOf('row-title')
  const timeIdx = html.indexOf('muted small')
  const detailIdx = html.indexOf('detail')
  // 结构顺序：row-main 包着 row-title（含色点+事件+actor）与右侧时间；
  // detail 在 row-main 之后单独一行。
  assert.ok(mainIdx < titleIdx && titleIdx < timeIdx, `标题先于时间（main=${mainIdx} title=${titleIdx} time=${timeIdx}）`)
  assert.ok(html.includes('· admin'), 'actor 跟事件名同一行')
  assert.ok(mainIdx < detailIdx, 'detail 在 main 之后成行')
})

test('审计行: detail 转义；为空时不渲染 detail 行', () => {
  const evil = auditRow({ ...EVENT, detail: '<img src=x onerror=alert(1)>' })
  assert.ok(!evil.includes('<img'), 'HTML 被转义')
  assert.ok(evil.includes('&lt;img'), '转义后可读')
  const none = auditRow({ ...EVENT, detail: null })
  assert.ok(!none.includes('detail'), '空 detail 不给空行')
})
