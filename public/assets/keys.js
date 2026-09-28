// Outward API key administration (admin side, authenticated by session cookie).
//
// The plaintext appears in the creation response exactly once: it is displayed in the reveal area
// with a "shown once" warning, and the list can never obtain it (the server has no such field).
//
// What the 2026-09-28 UX pass added on top of that promise:
//   - scopes are explained in human terms (the real scope id stays visible in small print);
//   - the form exposes everything the backend already accepts: per-minute rate, in-flight cap,
//     expiry date, unlimited daily quota;
//   - after issuing, the page can **test the key against the real outward door** (read-only, no
//     spend) while the plaintext is still in hand, and offers a copyable handover block -- the
//     endpoint, the service name, a working example, and the quota ground rules;
//   - revoking asks for confirmation instead of firing on one click.
//
// Data contract (corrected after the 2026-09-27 incident): `apiJson` resolves to
// `{ok, status, data}`, **not a Response** -- calling .json() on it leaves the whole page stuck at
// "Loading..." (keys-page.test.mjs is the runtime guard for this now).
import { $, esc, setHtml, apiJson, poll, t, loadI18n, ago } from './ui.js'

await loadI18n()

/** The five scopes, in creation order, with the human explanation the form shows. */
const SCOPES = [
  { id: 'services:read', label: t('keys.scope.services:read'), note: t('keys.scopeNote.services:read'), available: true },
  { id: 'usage:read', label: t('keys.scope.usage:read'), note: t('keys.scopeNote.usage:read'), available: true },
  { id: 'conversations:write', label: t('keys.scope.conversations:write'), note: t('keys.scopeNote.conversations:write'), available: true },
  { id: 'tasks:write', label: t('keys.scope.tasks:write'), note: t('keys.scopeNote.tasks:write'), available: false },
  { id: 'interactions:write', label: t('keys.scope.interactions:write'), note: t('keys.scopeNote.interactions:write'), available: false },
]

const scopeLabel = (id) => SCOPES.find((scope) => scope.id === id)?.label ?? id

const statePill = (key) => {
  if (key.revokedAt !== null) return `<span class="pill-mini muted">${esc(t('keys.revoked'))}</span>`
  if (key.expiresAt !== null && key.expiresAt <= Date.now()) return `<span class="pill-mini warn">${esc(t('keys.expired'))}</span>`
  return `<span class="pill-mini">${esc(t('keys.active'))}</span>`
}

const scopeChips = (key) =>
  key.scopes.map((scope) => `<span class="pill-mini muted">${esc(scopeLabel(scope))}</span>`).join(' ')

const quotaText = (key) => {
  if (key.quotaRunsDay === null) return `${key.usedToday} ${esc(t('keys.perDayUnlimited'))}`
  return `${key.usedToday}/${key.quotaRunsDay} ${esc(t('keys.perDay'))}`
}

const keyRow = (key) => `<div class="node-row">
  <div class="node-main">
    <div class="node-title">${esc(key.name)} ${statePill(key)} <code class="muted">${esc(key.id)}</code></div>
    <div class="node-detail">${esc(t('keys.serving'))}: ${key.serviceLabels.length === 0 ? '—' : esc(key.serviceLabels.join(', '))}</div>
    <div class="node-meta">${scopeChips(key)}</div>
    <div class="node-meta">${esc(t('keys.today'))}: <strong>${quotaText(key)}</strong>
      · ${esc(t('keys.inFlight'))}: ${key.active}/${key.maxConcurrency}
      · ${key.rateLimitRpm}${esc(t('keys.perMinute'))}
      · ${esc(t('keys.lastUsed'))}: ${key.lastUsedAt === null ? '—' : esc(ago(key.lastUsedAt))}</div>
  </div>
  ${key.revokedAt === null ? `<div class="form-actions"><button class="btn" type="button" data-revoke="${esc(key.id)}" data-revoke-name="${esc(key.name)}">${esc(t('keys.revoke'))}</button></div>` : ''}
</div>`

const renderListener = (state, access) => {
  const el = $('keys-listener')
  if (el === null) return
  const where = `${state.host}:${state.port}`
  if (state.status === 'listening') {
    el.innerHTML = `${esc(t('keys.listenerUp'))} <code>http://${esc(where)}/v1</code>`
  } else {
    const reason = state.detail === null ? '' : ` — ${esc(state.detail)}`
    el.innerHTML = `${esc(state.status === 'disabled' ? t('keys.listenerOff') : t('keys.listenerFailed'))}${reason}`
  }
  const accessEl = $('keys-access')
  if (accessEl === null) return
  accessEl.hidden = state.status !== 'listening'
  if (!accessEl.hidden) {
    accessEl.innerHTML = `${esc(t('keys.accessEndpoint'))}: <code>${esc(access?.baseUrl ?? `http://${where}/v1`)}</code>
      · ${esc(t('keys.accessQuota', { tz: access?.quotaTimeZone ?? '?' }))}`
  }
}

const setMessage = (text) => {
  const msg = $('key-create-msg')
  if (msg === null) return
  msg.hidden = text === ''
  msg.textContent = text
}

/** The outward handover block: what an operator copies into an email to the customer. */
const handoverText = (page, key, token) => {
  const exampleService = key.scopeServices[0] !== '*' ? key.scopeServices[0] ?? '' : (page.services[0]?.id ?? '')
  return [
    `${t('keys.handoverEndpoint')}: ${page.access.baseUrl}`,
    `${t('keys.handoverService')}: ${key.serviceLabels.join(', ') || '—'}`,
    `${t('keys.handoverToken')}: ${token}`,
    '',
    `${t('keys.handoverExample')}:`,
    `curl -H "Authorization: Bearer ${token}" -X POST ${page.access.baseUrl}/conversations -H "content-type: application/json" -d '{"service":"${exampleService}","externalUserId":"customer-1","text":"hello"}'`,
    '',
    `${t('keys.handoverQuota')}: ${t('keys.accessQuota', { tz: page.access.quotaTimeZone })}`,
  ].join('\n')
}

const renderProbe = (result, target) => {
  if (target === null) return
  target.innerHTML = (result.steps ?? []).map((step) => `<div class="node-meta">${step.ok ? '✓' : '✗'} <code>${esc(step.path)}</code> ${step.status} — ${esc(step.detail)}</div>`).join('')
    + (result.notes ?? []).map((note) => `<div class="node-meta muted">· ${esc(note)}</div>`).join('')
}

const probeToken = async (token, target) => {
  if (target !== null) target.innerHTML = `<p class="muted small">${esc(t('keys.testRunning'))}</p>`
  const response = await apiJson('/api/keys/probe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  if (target === null) return
  if (!response.ok) {
    target.innerHTML = `<div class="banner warn">${esc(t('keys.testFailed'))}: ${esc(response.detail)}</div>`
    return
  }
  renderProbe(response.data, target)
}

let pageData = null // the last list payload (access + services), which the handover block is built from

const load = async () => {
  const r = await apiJson('/api/keys')
  if (!r.ok) return
  const data = r.data ?? { keys: [], publicApi: { status: 'failed', host: '?', port: 0, detail: null }, services: [], access: { baseUrl: '', quotaTimeZone: '?' } }
  pageData = data
  renderListener(data.publicApi, data.access)

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
  const quotaEl = $('key-quota')
  const unlimited = $('key-quota-unlimited')?.checked === true
  const quotaRaw = unlimited ? null : Number(quotaEl?.value ?? '200')
  const expiresRaw = $('key-expires')?.value ?? ''
  const expiresAt = expiresRaw === '' ? null : new Date(`${expiresRaw}T23:59:59`).getTime()

  const response = await apiJson('/api/keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name,
      services: [service],
      scopes: checkedScopes(),
      quotaRunsDay: unlimited ? null : Number.isFinite(quotaRaw) && quotaRaw > 0 ? quotaRaw : 200,
      rateLimitRpm: Number($('key-rpm')?.value ?? '60'),
      maxConcurrency: Number($('key-concurrency')?.value ?? '4'),
      expiresAt,
    }),
  })
  if (!response.ok) {
    setMessage(`${t('keys.createFailed')}: ${response.detail ?? response.status}`)
    return
  }
  setMessage(t('keys.created'))
  const payload = response.data ?? {}
  const reveal = $('key-token')
  if (reveal !== null) {
    reveal.hidden = false
    const value = $('key-token-value')
    if (value !== null) value.textContent = payload.token
    const handover = $('key-handover')
    if (handover !== null && pageData !== null) handover.innerHTML = `<pre class="yaml-preview">${esc(handoverText(pageData, payload.key ?? {}, payload.token))}</pre>`
    const probeResult = $('key-probe-result')
    if (probeResult !== null) probeResult.innerHTML = ''
  }
  if (nameEl !== null) nameEl.value = ''
  await load()
}

const copyText = async (text) => {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

$('key-form')?.addEventListener('submit', (event) => {
  event.preventDefault()
  void create()
})

$('key-token-copy')?.addEventListener('click', async () => {
  const value = $('key-token-value')?.textContent ?? ''
  const msg = $('key-handover-msg')
  if (msg === null) return
  msg.textContent = (await copyText(value)) ? t('keys.copied') : t('keys.copyFailed')
})

$('key-probe')?.addEventListener('click', () => {
  const token = $('key-token-value')?.textContent ?? ''
  void probeToken(token, $('key-probe-result'))
})

$('key-handover-copy')?.addEventListener('click', async () => {
  const handover = $('key-handover')?.textContent ?? ''
  const msg = $('key-handover-msg')
  if (msg === null) return
  msg.textContent = (await copyText(handover)) ? t('keys.copied') : t('keys.copyFailed')
})

$('key-verify-open')?.addEventListener('click', () => {
  const verify = $('key-verify')
  if (verify !== null) verify.hidden = false
})

$('key-verify-cancel')?.addEventListener('click', () => {
  const verify = $('key-verify')
  if (verify !== null) verify.hidden = true
})

$('key-verify-form')?.addEventListener('submit', (event) => {
  event.preventDefault()
  const token = $('key-verify-token')?.value ?? ''
  void probeToken(token, $('key-verify-result'))
})

document.addEventListener('click', (event) => {
  const target = event.target
  if (!(target instanceof HTMLElement)) return
  const id = target.dataset.revoke
  if (id === undefined) return
  const name = target.dataset.revokeName ?? id
  if (!window.confirm(t('keys.revokeConfirm', { name }))) return
  target.disabled = true
  void apiJson(`/api/keys/${encodeURIComponent(id)}/revoke`, { method: 'POST' }).then(async (response) => {
    setMessage(response.ok ? t('keys.revokedNow') : t('keys.revokeFailed'))
    await load()
  })
})

await load()
poll(load, 15_000)

// The scope checklist is static across loads: render it once with the explanations. Unreleased
// scopes stay visible so keys minted elsewhere still display, but cannot be granted here by mistake.
const scopesEl = $('key-scopes')
if (scopesEl !== null) {
  scopesEl.innerHTML = SCOPES.map((scope) => `<label class="checkbox-line">
    <input type="checkbox" value="${esc(scope.id)}" ${scope.id === 'services:read' || scope.id === 'usage:read' ? 'checked' : ''} ${scope.available ? '' : 'disabled'} />
    <span>${esc(scope.label)}${scope.available ? '' : ` <span class="pill-mini muted">${esc(t('keys.scopeUnreleased'))}</span>`} <code class="muted small">${esc(scope.id)}</code></span>
    <span class="muted small">${esc(scope.note)}</span>
  </label>`).join('')
}
