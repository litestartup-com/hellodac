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

// The create form: the same POST /api/crons the retired page used. The schedule is validated
// server-side before it is stored (a typo accepted here becomes a job that never fires).
$('crons-create').addEventListener('click', () => {
  const msg = $('crons-create-msg')
  const agentId = $('crons-new-agent').value.trim()
  const name = $('crons-new-name').value.trim()
  const schedule = $('crons-new-schedule').value.trim()
  const prompt = $('crons-new-prompt').value
  if (agentId === '' || name === '' || schedule === '' || prompt === '') {
    msg.textContent = t('crons.fillAll')
    return
  }
  msg.textContent = ''
  void apiJson('/api/crons', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId, name, schedule, timezone: 'Asia/Shanghai', prompt }),
  }).then(async (r) => {
    if (r.ok) {
      msg.textContent = t('crons.created')
      $('crons-new-name').value = ''
      $('crons-new-agent').value = ''
      $('crons-new-schedule').value = ''
      $('crons-new-prompt').value = ''
      await load()
    } else {
      msg.textContent = t('crons.createFailed')
    }
  })
})

void load()
