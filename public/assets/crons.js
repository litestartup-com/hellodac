// @ts-check
// The cron page (returned): list the schedules, toggle them, and edit a prompt. The engine and
// /api/crons never left; only the page did. apiJson carries the CSRF token for the PATCHes.
import { $, apiJson, esc, setHtml, t, loadI18n } from './ui.js'
import { cronRow } from './crons-row.js'

await loadI18n()

let crons = []
let editing = null

const setStatus = (text) => {
  const el = $('crons-refresh')
  if (el !== null) el.textContent = text
}

const render = () => {
  const list = $('crons-list')
  if (list === null) return
  setHtml('crons-list', crons.length === 0 ? `<p class="muted small">${esc(t('crons.empty'))}</p>` : crons.map(cronRow).join(''))
  setStatus(t('crons.refreshAt', { time: new Date().toLocaleTimeString(undefined, { hour12: false }) }))
}

const load = async () => {
  try {
    const r = await apiJson('/api/crons')
    if (!r.ok) {
      setHtml('crons-list', `<p class="muted small">${esc(t('crons.readFailed'))}</p>`)
      return
    }
    crons = Array.isArray(r.data?.crons) ? r.data.crons : []
    render()
  } catch {
    setHtml('crons-list', `<p class="muted small">${esc(t('crons.readFailed'))}</p>`)
  }
}

const patch = async (id, body) => {
  const r = await apiJson(`/api/crons/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) {
    setStatus(t('crons.saveFailed'))
    return false
  }
  await load()
  return true
}

const openEdit = (id) => {
  const c = crons.find((x) => x.id === id)
  if (c === undefined) return
  editing = id
  $('crons-edit-meta').textContent = `${c.name} · ${c.agentName} · ${c.schedule}`
  $('crons-prompt').value = c.prompt ?? ''
  $('crons-edit').hidden = false
}

const list = $('crons-list')
if (list !== null) {
  list.addEventListener('click', (event) => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    const toggle = target.closest('input[data-toggle]')
    if (toggle instanceof HTMLInputElement) {
      void patch(toggle.getAttribute('data-id') ?? '', { enabled: toggle.checked })
      return
    }
    const edit = target.closest('button[data-edit]')
    if (edit !== null) openEdit(edit.getAttribute('data-id') ?? '')
  })
}

$('crons-save').addEventListener('click', () => {
  if (editing === null) return
  void patch(editing, { prompt: $('crons-prompt').value }).then((ok) => {
    if (ok) {
      editing = null
      $('crons-edit').hidden = true
    }
  })
})
$('crons-cancel').addEventListener('click', () => {
  editing = null
  $('crons-edit').hidden = true
})

void load()
