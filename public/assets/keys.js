// Outward API key administration (admin side, authenticated by session cookie).
//
// The plaintext appears in the creation response exactly once: it is displayed in the reveal area
// with a "shown once" warning, and the list can never obtain it (the server has no such field).
//
// The operator flow this file serves (user, 2026-09-28, "key-first" blueprint):
//   - the form shows three fields by default; scopes, rate, concurrency and expiry hide behind
//     "more settings" (the defaults are the safe ones, and a credential is not a settings panel);
//   - when no service exists, the service field is replaced by one action: create a service -- and
//     the half-filled form survives the round trip (sessionStorage draft + ?service= return);
//   - the list can be filtered per service, and each row opens a detail panel: which service it
//     serves, its limits, its last calls and turns;
//   - after issuing, the page can test the key against the real outward door (read-only) while the
//     plaintext is still in hand, and offers a copyable handover block;
//   - revoking asks for confirmation instead of firing on one click.
//
// Data contract (corrected after the 2026-09-27 incident): `apiJson` resolves to
// `{ok, status, data}`, **not a Response** -- calling .json() on it leaves the whole page stuck at
// "Loading..." (keys-page.test.mjs is the runtime guard for this now).
import { $, esc, setHtml, apiJson, poll, t, loadI18n, ago, money } from './ui.js'

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

const searchParams = () => {
  try {
    return new URLSearchParams(window.location?.search ?? '')
  } catch {
    return new URLSearchParams('')
  }
}

/**
 * The draft survives the "create a service" round trip (keys -> services -> keys). sessionStorage is
 * per-tab and expires with the session; a browser without it simply loses the draft, never the flow.
 */
const draftStore = {
  load() {
    try {
      const raw = sessionStorage.getItem('dac-key-draft')
      return raw === null ? null : JSON.parse(raw)
    } catch {
      return null
    }
  },
  save(draft) {
    try {
      sessionStorage.setItem('dac-key-draft', JSON.stringify(draft))
    } catch {
      // Storage unavailable: the draft just does not survive navigation.
    }
  },
  clear() {
    try {
      sessionStorage.removeItem('dac-key-draft')
    } catch {
      // nothing to do
    }
  },
}

let pageData = null // the last list payload (access + services), which the handover block is built from
let activeFilter = null // service id being filtered on, or null = all
let openDetail = null // the key id whose detail panel is open
const detailCache = new Map()

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
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

const stamp = (ms) => (ms === null || ms === undefined ? '—' : new Date(ms).toLocaleString())

const detailPanel = (key, detail) => {
  if (detail === undefined || detail === null) return `<div class="node-meta muted">${esc(t('common.loading'))}</div>`
  const calls = detail.recentCalls.length === 0
    ? `<div class="node-meta muted">${esc(t('keys.detailEmptyCalls'))}</div>`
    : detail.recentCalls.map((call) => `<div class="node-meta">${esc(stamp(call.at))} · <code>${esc(call.detail)}</code></div>`).join('')
  const runs = detail.recentRuns.length === 0
    ? `<div class="node-meta muted">${esc(t('keys.detailEmptyRuns'))}</div>`
    : detail.recentRuns.map((run) => `<div class="node-meta">
        <code class="muted">${esc(run.id.slice(0, 8))}</code>
        <span class="pill-mini${run.state === 'done' ? '' : ' muted'}">${esc(run.state)}</span>
        ${esc(stamp(run.startedAt))} · ${esc(t('keys.detailCost'))}: ${esc(money(run.costMicroUsd))}
        ${run.summary === null ? '' : `· ${esc(String(run.summary).slice(0, 80))}`}
      </div>`).join('')
  return `<div class="detail-panel">
    <div class="node-detail">${esc(t('keys.serving'))}: <strong>${key.serviceLabels.length === 0 ? '—' : esc(key.serviceLabels.join(', '))}</strong>
      · ${esc(t('keys.today'))}: <strong>${quotaText(key)}</strong>
      · ${esc(t('keys.inFlight'))}: ${key.active}/${key.maxConcurrency}
      · ${key.rateLimitRpm}${esc(t('keys.perMinute'))}</div>
    <div class="node-meta">${esc(t('keys.expires'))}: ${key.expiresAt === null ? esc(t('keys.expiresNever')) : esc(stamp(key.expiresAt))}
      · ${esc(t('keys.createdLabel'))}: ${esc(stamp(key.createdAt))}
      · ${esc(t('keys.lastUsed'))}: ${key.lastUsedAt === null ? '—' : esc(ago(key.lastUsedAt))}</div>
    <h3 class="section-label">${esc(t('keys.detailCalls'))}</h3>${calls}
    <h3 class="section-label">${esc(t('keys.detailRuns'))}</h3>${runs}
  </div>`
}

const keyRow = (key) => {
  const detail = openDetail === key.id ? detailCache.get(key.id) ?? null : null
  const panel = detail === null
    ? ''
    : detailPanel(key, detail)
  return `<div class="node-row">
  <div class="node-main">
    <div class="node-title">${esc(key.name)} ${statePill(key)} <code class="muted">${esc(key.id)}</code></div>
    <div class="node-detail">${esc(t('keys.serving'))}: ${key.serviceLabels.length === 0 ? '—' : esc(key.serviceLabels.join(', '))}</div>
    <div class="node-meta">${scopeChips(key)}</div>
    <div class="node-meta">${esc(t('keys.today'))}: <strong>${quotaText(key)}</strong>
      · ${esc(t('keys.inFlight'))}: ${key.active}/${key.maxConcurrency}
      · ${key.rateLimitRpm}${esc(t('keys.perMinute'))}
      · ${esc(t('keys.lastUsed'))}: ${key.lastUsedAt === null ? '—' : esc(ago(key.lastUsedAt))}</div>
    ${panel}
  </div>
  <div class="form-actions">
    <button class="btn ghost" type="button" data-detail="${esc(key.id)}">${openDetail === key.id ? esc(t('keys.detailClose')) : esc(t('keys.detail'))}</button>
    ${key.revokedAt === null ? `<button class="btn" type="button" data-revoke="${esc(key.id)}" data-revoke-name="${esc(key.name)}">${esc(t('keys.revoke'))}</button>` : ''}
  </div>
</div>`
}

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

/** A key matches a service filter when it may enter it ('*' enters everything). */
const matchesFilter = (key, serviceId) =>
  key.scopeServices.includes('*') || key.scopeServices.includes(serviceId)

const renderFilter = (services) => {
  const row = $('keys-filter')
  if (row === null) return
  const all = `<button type="button" class="pill${activeFilter === null ? ' active' : ''}" data-filter="">${esc(t('keys.filterAll'))}</button>`
  const chips = services.map((service) => `<button type="button" class="pill${activeFilter === service.id ? ' active' : ''}" data-filter="${esc(service.id)}">${esc(service.label)}</button>`).join('')
  row.innerHTML = all + chips
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

// ---------------------------------------------------------------------------
// The form: three visible fields, the rest under "more settings"
// ---------------------------------------------------------------------------
const readForm = () => ({
  name: $('key-name')?.value ?? '',
  service: $('key-services')?.value ?? '',
  quota: $('key-quota')?.value ?? '200',
  unlimited: $('key-quota-unlimited')?.checked === true,
  rpm: $('key-rpm')?.value ?? '60',
  concurrency: $('key-concurrency')?.value ?? '4',
  expires: $('key-expires')?.value ?? '',
  scopes: checkedScopes(),
})

const restoreDraft = (draft) => {
  if (draft === null) return
  const name = $('key-name'); if (name !== null && typeof draft.name === 'string') name.value = draft.name
  const quota = $('key-quota'); if (quota !== null && typeof draft.quota === 'string') quota.value = draft.quota
  const unlimited = $('key-quota-unlimited'); if (unlimited !== null) unlimited.checked = draft.unlimited === true
  const rpm = $('key-rpm'); if (rpm !== null && typeof draft.rpm === 'string') rpm.value = draft.rpm
  const concurrency = $('key-concurrency'); if (concurrency !== null && typeof draft.concurrency === 'string') concurrency.value = draft.concurrency
  const expires = $('key-expires'); if (expires !== null && typeof draft.expires === 'string') expires.value = draft.expires
}

const saveDraft = () => draftStore.save(readForm())

const checkedScopes = () =>
  Array.from(document.querySelectorAll('#key-scopes input:checked'))
    .map((input) => input.value)
    .filter((value) => value !== '')

const load = async () => {
  const r = await apiJson('/api/keys')
  if (!r.ok) return
  const data = r.data ?? { keys: [], publicApi: { status: 'failed', host: '?', port: 0, detail: null }, services: [], access: { baseUrl: '', quotaTimeZone: '?' } }
  pageData = data
  renderListener(data.publicApi, data.access)

  const services = $('key-services')
  const empty = $('key-services-empty')
  const createButton = $('key-create')
  if (services !== null && empty !== null) {
    const hasServices = data.services.length > 0
    empty.hidden = hasServices
    services.hidden = !hasServices
    if (hasServices && services.options.length === 0) {
      services.innerHTML = data.services.map((s) => `<option value="${esc(s.id)}">${esc(s.label)} (${esc(s.id)})</option>`).join('')
      // The round trip back from creating a service preselects it here.
      const wanted = searchParams().get('service')
      if (wanted !== null && data.services.some((s) => s.id === wanted)) services.value = wanted
    }
    if (createButton !== null) createButton.disabled = !hasServices
    if (!hasServices) setMessage(t('keys.noServices'))
  }

  // A draft that survived the round trip comes back with its service preselect deferred to here
  // (the options had to exist first).
  const draft = draftStore.load()
  if (draft !== null && services !== null && draft.service !== '' && services.value === '' && !services.hidden) {
    services.value = draft.service
  }

  const visible = data.keys.filter((key) => activeFilter === null || matchesFilter(key, activeFilter))
  renderFilter(data.services)
  setHtml('keys-list', visible.length === 0
    ? `<p class="muted small">${esc(t('keys.empty'))}</p>`
    : visible.map(keyRow).join(''))
  const refreshed = $('keys-refresh')
  if (refreshed !== null) refreshed.textContent = new Date().toLocaleTimeString()
}

const openKeyDetail = async (id) => {
  if (openDetail === id) {
    openDetail = null
    await load()
    return
  }
  openDetail = id
  await load()
  if (!detailCache.has(id)) {
    const response = await apiJson(`/api/keys/${encodeURIComponent(id)}`)
    if (response.ok) detailCache.set(id, response.data)
    await load()
  }
}

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
  draftStore.clear()
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

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
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

document.addEventListener('input', saveDraft)
document.addEventListener('change', saveDraft)

document.addEventListener('click', (event) => {
  const target = event.target
  if (!(target instanceof HTMLElement)) return
  const id = target.dataset.revoke
  if (id !== undefined) {
    const name = target.dataset.revokeName ?? id
    if (!window.confirm(t('keys.revokeConfirm', { name }))) return
    target.disabled = true
    void apiJson(`/api/keys/${encodeURIComponent(id)}/revoke`, { method: 'POST' }).then(async (response) => {
      setMessage(response.ok ? t('keys.revokedNow') : t('keys.revokeFailed'))
      await load()
    })
    return
  }
  const detailId = target.dataset.detail
  if (detailId !== undefined) {
    void openKeyDetail(detailId)
    return
  }
  if (target.dataset.filter !== undefined) {
    activeFilter = target.dataset.filter === '' ? null : target.dataset.filter
    void load()
  }
})

// Restore the draft from before the "create a service" round trip (and keep refreshing it).
restoreDraft(draftStore.load())
await load()
poll(load, 15_000)

// The scope checklist is static across loads: render it once with the explanations. Unreleased
// scopes stay visible so keys minted elsewhere still display, but cannot be granted here by mistake.
const scopesEl = $('key-scopes')
if (scopesEl !== null) {
  scopesEl.innerHTML = SCOPES.map((scope) => `<label class="checkbox-line">
    <input type="checkbox" value="${esc(scope.id)}" ${scope.id === 'services:read' || scope.id === 'usage:read' || scope.id === 'conversations:write' ? 'checked' : ''} ${scope.available ? '' : 'disabled'} />
    <span>${esc(scope.label)}${scope.available ? '' : ` <span class="pill-mini muted">${esc(t('keys.scopeUnreleased'))}</span>`} <code class="muted small">${esc(scope.id)}</code></span>
    <span class="muted small">${esc(scope.note)}</span>
  </label>`).join('')
}

// Test surface: the smoke test drives the real functions through this hook
// (never present in production -- it is created only when the test flags it).
if (globalThis.__DAC_TEST__ === true) {
  globalThis.__DAC_KEYS_TEST__ = {
    create,
    load,
    openKeyDetail,
    readForm,
    restoreDraft,
    setFilter: (id) => { activeFilter = id },
    draft: () => draftStore.load(),
  }
}
