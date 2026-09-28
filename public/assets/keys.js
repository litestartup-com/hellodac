// Outward API key administration (admin side, authenticated by session cookie).
//
// The plaintext appears in the creation response exactly once: it is displayed in the token-reveal area
// with a "shown once" warning, and the list can never obtain it (the server has no such field).
//
// Data contract (corrected after the 2026-09-27 incident): `apiJson` resolves to `{ok, status, data}` (or
// `{ok:false, error, detail}` on failure), **not a Response** -- calling .json() on it leaves the whole page
// stuck at "Loading..." (keys-page.test.mjs is the runtime guard for this now).
import { $, esc, setHtml, apiJson, poll, t, loadI18n } from './ui.js'

await loadI18n()

const stamp = (ms) => (ms === null || ms === undefined ? '—' : new Date(ms).toLocaleString())

const statePill = (key) => {
  if (key.revokedAt !== null) return `<span class="pill-mini muted">${esc(t('keys.revoked'))}</span>`
  if (key.expiresAt !== null && key.expiresAt <= Date.now()) return `<span class="pill-mini muted">${esc(t('keys.expired'))}</span>`
  return `<span class="pill-mini">${esc(t('keys.active'))}</span>`
}

const keyRow = (key) => `<div class="node-row">
  <div class="node-main">
    <div class="node-title">${esc(key.name)} ${statePill(key)}</div>
    <div class="node-detail"><code>${esc(key.id)}</code> · ${esc(key.scopeServices.join(', '))}</div>
    <div class="node-meta">${esc(key.scopes.join(', '))} · ${key.quotaRunsDay === null ? esc(t('keys.unlimited')) : `${key.quotaRunsDay}${esc(t('keys.perDay'))}`} · ${key.rateLimitRpm}${esc(t('keys.perMinute'))}</div>
    <div class="node-meta">${esc(t('keys.lastUsed'))}: ${esc(stamp(key.lastUsedAt))} · ${esc(t('keys.createdLabel'))}: ${esc(stamp(key.createdAt))}</div>
  </div>
  ${key.revokedAt === null ? `<div class="form-actions"><button class="btn" type="button" data-revoke="${esc(key.id)}">${esc(t('keys.revoke'))}</button></div>` : ''}
</div>`

const renderListener = (state) => {
  const el = $('keys-listener')
  if (el === null) return
  const where = `${state.host}:${state.port}`
  if (state.status === 'listening') {
    el.innerHTML = `${esc(t('keys.listenerUp'))} <code>http://${esc(where)}/v1</code>`
    return
  }
  const reason = state.detail === null ? '' : ` — ${esc(state.detail)}`
  el.innerHTML = `${esc(state.status === 'disabled' ? t('keys.listenerOff') : t('keys.listenerFailed'))}${reason}`
}

const setMessage = (text) => {
  const msg = $('key-create-msg')
  if (msg === null) return
  msg.hidden = text === ''
  msg.textContent = text
}

const load = async () => {
  const r = await apiJson('/api/keys')
  if (!r.ok) return
  const data = r.data ?? { keys: [], publicApi: { status: 'failed', host: '?', port: 0, detail: null }, services: [] }
  renderListener(data.publicApi)

  const services = $('key-services')
  if (services !== null && services.options.length === 0) {
    services.innerHTML = data.services.map((s) => `<option value="${esc(s.id)}">${esc(s.label)} (${esc(s.id)})</option>`).join('')
  }
  // With no service configured the create form cannot submit, so give clear guidance instead of a dead button.
  const createButton = $('key-create')
  if (createButton !== null) createButton.disabled = data.services.length === 0
  setMessage(data.services.length === 0 ? t('keys.noServices') : '')

  setHtml('keys-list', data.keys.length === 0 ? `<p class="muted small">${esc(t('keys.empty'))}</p>` : data.keys.map(keyRow).join(''))
  const refreshed = $('keys-refresh')
  if (refreshed !== null) refreshed.textContent = new Date().toLocaleTimeString()
}

const checkedScopes = () =>
  Array.from(document.querySelectorAll('#key-scopes input:checked'))
    .map((input) => input.value)
    .filter((value) => value !== '')

const create = async () => {
  const nameEl = $('key-name')
  const name = nameEl === null ? '' : String(nameEl.value).trim()
  if (name === '') {
    setMessage(t('keys.nameRequired'))
    return
  }
  const service = $('key-services')?.value ?? ''
  if (service === '') {
    setMessage(t('keys.serviceRequired'))
    return
  }
  const quotaRaw = Number($('key-quota')?.value ?? '200')
  const response = await apiJson('/api/keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name,
      services: [service],
      scopes: checkedScopes(),
      quotaRunsDay: Number.isFinite(quotaRaw) && quotaRaw > 0 ? quotaRaw : null,
    }),
  })
  if (!response.ok) {
    setMessage(`${t('keys.createFailed')}: ${response.detail ?? response.status}`)
    return
  }
  const payload = response.data ?? {}
  setMessage(t('keys.created'))
  const reveal = $('key-token')
  if (reveal !== null) {
    reveal.hidden = false
    reveal.innerHTML = `<div class="node-title">${esc(t('keys.tokenOnce'))}</div>
       <code class="token-value">${esc(payload.token)}</code>
       <div class="node-meta">${esc(t('keys.id'))}: <code>${esc(payload.key.id)}</code></div>`
  }
  if (nameEl !== null) nameEl.value = ''
  await load()
}

$('key-form')?.addEventListener('submit', (event) => {
  event.preventDefault()
  void create()
})

document.addEventListener('click', (event) => {
  const target = event.target
  if (!(target instanceof HTMLElement)) return
  const id = target.dataset.revoke
  if (id !== undefined) {
    void apiJson(`/api/keys/${encodeURIComponent(id)}/revoke`, { method: 'POST' }).then(async (response) => {
      setMessage(response.ok ? t('keys.revokedNow') : t('keys.revokeFailed'))
      await load()
    })
  }
})

await load()
poll(load, 15_000)
