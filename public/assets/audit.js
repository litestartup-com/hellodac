// Hive plan P3: the audit stream page (read-only). Row assembly lives in audit-row.js (pure function layer).
import { $, apiJson, esc, setHtml, t, loadI18n } from './ui.js'

await loadI18n()
import { auditRow } from './audit-row.js'

const load = async () => {
  try {
    const r = await apiJson('/api/audit')
    if (!r.ok) return
    setHtml('audit-list', r.data.entries.length === 0 ? `<p class="muted small">${esc(t('audit.empty'))}</p>` : r.data.entries.map(auditRow).join(''))
    $('audit-refresh').textContent = t('audit.refreshAt', { time: new Date().toLocaleTimeString(undefined, { hour12: false }) })
  } catch {
    setHtml('audit-list', `<p class="muted small">${esc(t('audit.readFailed'))}</p>`)
  }
}

void load()
