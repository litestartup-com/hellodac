// @ts-check
// UI 精简（DAC v1.0.0）：审计流水的行——纯函数层，DOM 装配在 audit.js。
// 可单测（audit-row.test.mjs）。与 run-row.js / node-row.js 同一分工。
//
// 这页原来直接复用 .node-row（每行一张独立阴影卡 + 无限长 detail），读起来
// 像一摞卡片而不是一条时间线。改成站内既有的 hairline 列表语言（spend 页同款：
// .row + .row-main + .row-title），事件类型给语义色点，时间右对齐弱化。
import { esc, t, when } from './ui.js'

/** 事件类型 → 语义色点。失败红、破坏性橙、健康绿、中性灰；未知类型灰兜底。 */
export const KIND_META = {
  login_success: 'ok',
  login_failed: 'bad',
  password_change: 'ok',
  node_create: 'muted',
  node_delete: 'warn',
  node_up: 'ok',
  node_down: 'warn',
  node_restart: 'warn',
  backup: 'ok',
}

/** @param {string} kind @returns {string} */
export const kindLabel = (kind) => {
  const label = t(`audit.kind.${kind}`)
  // t() 缺键时返回键名本身（而不是 undefined）——剥离前缀才是可读兜底。
  return label === `audit.kind.${kind}` ? kind : label
}

/**
 * 审计事件行。
 * @param {{ kind: string, actor: string, at: number, detail?: string | null }} e
 * @returns {string}
 */
export const auditRow = (e) => {
  const dot = KIND_META[e.kind] ?? 'muted'
  const label = kindLabel(e.kind)
  const detail = typeof e.detail === 'string' && e.detail !== '' ? `<div class="detail">${esc(e.detail)}</div>` : ''
  return `<div class="row">
    <div class="row-main">
      <div class="row-title"><span class="dot ${dot}"></span>${esc(label)} <span class="muted">· ${esc(e.actor)}</span></div>
      <span class="muted small">${esc(when(e.at))}</span>
    </div>
    ${detail}
  </div>`
}
