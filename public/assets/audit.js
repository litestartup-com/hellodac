// 蜂群2计划 P3：审计流水页（只读）。
import { $, apiJson, esc, setHtml, when, t, loadI18n } from './ui.js'

await loadI18n()

const KIND_LABEL = {
  login_success: t('audit.kind.login_success'),
  login_failed: t('audit.kind.login_failed'),
  password_change: t('audit.kind.password_change'),
  node_create: t('audit.kind.node_create'),
  node_delete: t('audit.kind.node_delete'),
  node_up: t('audit.kind.node_up'),
  node_down: t('audit.kind.node_down'),
  node_restart: t('audit.kind.node_restart'),
  backup: t('audit.kind.backup'),
}

const row = (e) => `<div class="node-row">
  <div class="node-main">
    <div class="node-title">${esc(KIND_LABEL[e.kind] ?? e.kind)} <span class="muted">· ${esc(e.actor)} · ${esc(when(e.at))}</span></div>
    <div class="node-detail">${esc(e.detail)}</div>
  </div>
</div>`

const load = async () => {
  try {
    const r = await apiJson('/api/audit')
    if (!r.ok) return
    setHtml('audit-list', r.data.entries.length === 0 ? `<p class="muted small">${esc(t('audit.empty'))}</p>` : r.data.entries.map(row).join(''))
    $('audit-refresh').textContent = t('audit.refreshAt', { time: new Date().toLocaleTimeString(undefined, { hour12: false }) })
  } catch {
    setHtml('audit-list', `<p class="muted small">${esc(t('audit.readFailed'))}</p>`)
  }
}

void load()
