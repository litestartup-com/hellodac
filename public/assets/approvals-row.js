// @ts-check
// Headless approval: one queue row -- pure function layer, DOM assembly lives in approvals.js.
// Unit-testable (approvals-row.test.mjs). Same split as audit-row.js.
import { esc, t, when } from './ui.js'

// Static references on purpose: scripts/check-i18n-keys.mjs counts dictionary usage statically, and a
// dynamically composed key (approvals.outcome. + x) would be reported as an unreferenced key.
const OUTCOME_LABEL = {
  'allowed-once': t('approvals.outcome.allowed-once'),
  rejected: t('approvals.outcome.rejected'),
}

/**
 * @param {{ id: string, agentId: string, toolName: string, reason: string | null, state: string,
 *           outcome: string | null, createdAt: number, resolvedAt: number | null }} a
 * @returns {string}
 */
export const approvalRow = (a) => {
  const meta = [a.agentId, a.toolName === '' ? null : a.toolName].filter(Boolean).map(esc).join(' · ')
  const title = esc(a.toolName === '' ? a.agentId : a.toolName)
  const why = typeof a.reason === 'string' && a.reason !== '' ? `<div class="row-detail">${esc(a.reason)}</div>` : ''
  const time = `<span class="row-time">${esc(when(a.createdAt))}</span>`
  if (a.state !== 'pending') {
    const outcome = a.outcome !== null && a.outcome in OUTCOME_LABEL ? OUTCOME_LABEL[a.outcome] : t('approvals.resolved')
    return `<div class="row muted">
      <div class="row-main">
        <div class="row-title">${title}</div>
        <div class="row-sub">${meta} · ${outcome}${a.resolvedAt !== null ? ` · ${esc(when(a.resolvedAt))}` : ''}</div>
      </div>
      ${time}
    </div>${why}`
  }
  return `<div class="row" data-approval="${esc(a.id)}">
    <div class="row-main">
      <div class="row-title">${title}</div>
      <div class="row-sub">${meta}</div>
    </div>
    ${time}
    <div class="row-actions">
      <button type="button" class="btn small" data-decide="allowed-once" data-id="${esc(a.id)}">${esc(t('approvals.allow'))}</button>
      <button type="button" class="btn small danger" data-decide="rejected" data-id="${esc(a.id)}">${esc(t('approvals.deny'))}</button>
    </div>
  </div>${why}`
}
