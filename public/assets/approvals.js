// @ts-check
// Headless approval (design doc hive/topics/headless-approval-p1.md): the PO's pending permission
// prompt queue. Lists the runner-recorded prompts and decides them through the user-facing door
// (/api/approvals); the brain-token door and this one share the same decide path server-side.
import { $, apiJson, esc, setHtml, t, loadI18n } from './ui.js'
import { approvalRow } from './approvals-row.js'

await loadI18n()

const setStatus = (text) => {
  const el = $('approvals-refresh')
  if (el !== null) el.textContent = text
}

const load = async () => {
  try {
    const r = await apiJson('/api/approvals')
    if (!r.ok) {
      setHtml('approvals-list', `<p class="muted small">${esc(t('approvals.readFailed'))}</p>`)
      return
    }
    const items = Array.isArray(r.data?.approvals) ? r.data.approvals : []
    const pending = items.filter((a) => a.state === 'pending')
    const resolved = items.filter((a) => a.state !== 'pending')
    const body = items.length === 0
      ? `<p class="muted small">${esc(t('approvals.empty'))}</p>`
      : [...pending, ...resolved].map(approvalRow).join('')
    setHtml('approvals-list', body)
    setStatus(t('approvals.refreshAt', { time: new Date().toLocaleTimeString(undefined, { hour12: false }) }))
  } catch {
    setHtml('approvals-list', `<p class="muted small">${esc(t('approvals.readFailed'))}</p>`)
  }
}

const decide = async (id, outcome) => {
  const r = await apiJson(`/api/approvals/${encodeURIComponent(id)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ outcome }),
  })
  if (!r.ok) {
    setStatus(r.error === 'already_decided' ? t('approvals.alreadyDecided') : t('approvals.decideFailed'))
    void load()
    return
  }
  void load()
}

const list = $('approvals-list')
if (list !== null) {
  list.addEventListener('click', (event) => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    const btn = target.closest('button[data-decide]')
    if (btn === null) return
    const id = btn.getAttribute('data-id')
    const outcome = btn.getAttribute('data-decide')
    if (id !== null && (outcome === 'allowed-once' || outcome === 'rejected')) void decide(id, outcome)
  })
}

void load()
