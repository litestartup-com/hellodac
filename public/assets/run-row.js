// @ts-check
// UI 收尾 A：任务流纯函数层——任务行拼装与查询串构造。
// DOM 装配在 runs.js；可单测（runs.test.mjs）。
import { ago, esc, t, loadI18n } from './ui.js'

await loadI18n()

export const RUN_STATE_DOT = { pending: 'muted', running: 'busy', done: 'ok', failed: 'bad', missed: 'warn' }

/**
 * 状态 / 触发来源文案：**惰性求值**。
 *
 * 模块加载期就 t() 会踩两类坑：字典还没到（客户端是异步取），测试里注入字典也
 * 已经来不及——两种情况下拿到的都是键名。改成函数，调用点永远取到当前译文。
 * @param {string} state
 * @returns {string}
 */
export const runStateLabel = (state) => t(`runs.state.${state}`)

/** @param {string} trigger @returns {string} */
export const triggerLabel = (trigger) => (trigger === 'api' ? 'API' : t(`runs.trigger.${trigger}`))

/**
 * 任务行：状态点 / 状态与触发来源文案 / 冲突徽标 / 会话链接。
 * @param {{ agentName: string, trigger: string, state: string, summary?: string | null, error?: string | null, sourceChatId?: string | null, conflict?: string | null, startedAt: number }} r
 * @returns {string}
 */
export const runRow = (r) => {
  const dot = RUN_STATE_DOT[r.state] ?? 'muted'
  const label = runStateLabel(r.state)
  const trigger = triggerLabel(r.trigger)
  const summary = r.summary ?? r.error ?? ''
  const conflict =
    typeof r.conflict === 'string' && r.conflict !== ''
      ? `<span class="pill-mini warn" title="${esc(r.conflict)}">${esc(t('runs.conflict'))}</span>`
      : ''
  const whenText = r.state === 'running' ? esc(t('runs.running')) : esc(ago(r.startedAt))
  const link =
    r.sourceChatId !== null && r.sourceChatId !== undefined
      ? `<a class="node-link" href="/chat/${encodeURIComponent(r.sourceChatId)}" title="${esc(t('runs.sessionTitle'))}">${esc(t('runs.session'))}</a>`
      : ''
  return `<div class="node-row">
    <div class="node-main">
      <div class="node-title">
        <span class="dot ${dot}"></span>${esc(r.agentName)} <span class="muted">· ${esc(label)} · ${esc(trigger)} · ${whenText}</span> ${conflict}
      </div>
      ${summary !== '' ? `<div class="node-detail">${esc(summary)}</div>` : ''}
    </div>
    ${link !== '' ? `<div class="node-side">${link}</div>` : ''}
  </div>`
}

/**
 * 任务流查询串（纯函数，供测试）：筛选 + 游标，空串 = 第一页默认。
 * @param {{ agentId?: string, state?: string, before?: number | null }} f
 * @returns {string}
 */
export const runsQuery = ({ agentId = '', state = '', before = null } = {}) => {
  const params = new URLSearchParams()
  if (agentId !== '') params.set('agent_id', agentId)
  if (state !== '') params.set('state', state)
  if (Number.isFinite(before) && before > 0) params.set('before', String(before))
  return params.toString()
}
