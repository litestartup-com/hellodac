// @ts-check
// UI slimming (DAC v1.0.0): a row of the audit stream -- pure function layer, DOM assembly lives in audit.js.
// Unit-testable (audit-row.test.mjs). Same split as run-row.js / node-row.js.
//
// This page used to reuse .node-row directly (one shadowed card per row, unbounded detail), which read
// like a stack of cards instead of a timeline. It now speaks the in-site hairline list language (the
// same .row + .row-main + .row-title as the spend page): a semantic colour dot per event type, with the
// timestamp right-aligned and de-emphasised.
import { esc, t, when } from './ui.js'

/** Event type -> semantic colour dot. Failure red, destructive orange, healthy green, neutral grey;
 * unknown types fall back to grey. */
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
  // t() returns the key itself when the key is missing (never undefined), so stripping the prefix is the readable fallback.
  return label === `audit.kind.${kind}` ? kind : label
}

/**
 * Audit event row.
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
