// @ts-check
// UI wrap-up A: pure function layer of the task stream -- task row assembly and query string building.
// DOM assembly lives in runs.js; unit-testable (runs.test.mjs).
import { ago, esc, t, loadI18n } from './ui.js'

await loadI18n()

export const RUN_STATE_DOT = { pending: 'muted', running: 'busy', done: 'ok', failed: 'bad', missed: 'warn' }

/**
 * Status / trigger wording: **lazy evaluation**.
 *
 * Calling t() at module load hits two problems: the dictionary is not there yet (the client fetches it
 * asynchronously) and injecting a dictionary in tests is already too late -- both yield the key name.
 * Making it a function means every call site sees the current translation.
 * @param {string} state
 * @returns {string}
 */
export const runStateLabel = (state) => t(`runs.state.${state}`)

/** @param {string} trigger @returns {string} */
export const triggerLabel = (trigger) => (trigger === 'api' ? 'API' : t(`runs.trigger.${trigger}`))

/**
 * Task row: status dot / status and trigger wording / conflict badge / conversation link / body (2 lines by default).
 *
 * Why collapse (measured over the last 40 runs before the change): median body 315 characters, p90 1360,
 * max 2266, and 65% contain line breaks -- rendered in full, one screen held two or three tasks.
 *
 * The body always renders with the `clamped` class (2 lines, so the full text never flashes first);
 * whether it really overflows is decided by runs.js measuring scrollHeight after layout -- if it does not
 * overflow, the class is removed and no expand button appears: a short task ("ok") must not grow a control.
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
      ${
        summary === ''
          ? ''
          : `<div class="run-body clamped" data-run-body>${esc(summary)}</div>
      <button type="button" class="run-toggle" data-run-toggle hidden>${esc(t('runs.expand'))}</button>`
      }
    </div>
    ${link !== '' ? `<div class="node-side">${link}</div>` : ''}
  </div>`
}

/**
 * Task stream query string (pure function, for tests): filters plus cursor; empty means the default first page.
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
