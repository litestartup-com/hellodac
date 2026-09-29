// Outward API key administration (admin side, session cookie).
//
// Three views + one drawer (the v2 refactor, aligned with the nodes page):
//   - list: rows in the node-row shape, three-dot overflow menu per row (detail / edit / activity /
//     revoke), filter chips per service; the menu is the only way into a key (row clicks do not
//     navigate -- navigating on a stray click is more surprising than helpful);
//   - detail (full width): what the key may do, the services it serves (each row ends in an explicit
//     detail link), and its activity log; the back link sits under the title, not beside it;
//   - edit (full width): the same form as creation, saved with PATCH -- the secret is never touched;
//   - drawer: creating a key. Three visible fields (name / service / runs per day, 0 = unlimited),
//     the rest under "more settings"; the result step holds the secret (shown once), the read-only
//     outward test and the copyable handover block.
//
// The plaintext exists only inside the drawer's result step and is never in the list payload.
import { $, esc, setHtml, apiJson, poll, t, loadI18n, ago } from './ui.js'
import { triggerButtonHtml, menuItemHtml, menuPanelHtml, placePanel } from './menu.js'

await loadI18n()

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

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let pageData = null
let activeFilter = null
let openMenuKey = null
let detailKey = null
let formMode = 'create' // create | edit
let issuedToken = null
let lastRenderedList = ''

const menuId = (id) => `key-menu-${id}`
const matchesFilter = (key, serviceId) => key.scopeServices.includes('*') || key.scopeServices.includes(serviceId)

const show = (id) => { const el = $(id); if (el !== null) el.hidden = false }
const hide = (id) => { const el = $(id); if (el !== null) el.hidden = true }
const showView = (view) => {
  hide('view-list'); hide('view-detail'); hide('view-form')
  show(`view-${view}`)
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------
const statePill = (key) => {
  if (key.revokedAt !== null) return `<span class="pill-mini muted">${esc(t('keys.revoked'))}</span>`
  if (key.expiresAt !== null && key.expiresAt <= Date.now()) return `<span class="pill-mini warn">${esc(t('keys.expired'))}</span>`
  return `<span class="pill-mini">${esc(t('keys.active'))}</span>`
}

const stateDot = (key) => {
  if (key.revokedAt !== null) return 'muted'
  if (key.expiresAt !== null && key.expiresAt <= Date.now()) return 'warn'
  return 'ok'
}

const scopeChips = (key) =>
  key.scopes.map((scope) => `<span class="pill-mini muted">${esc(scopeLabel(scope))}</span>`).join(' ')

const quotaText = (key) => {
  if (key.quotaRunsDay === null) return `${key.usedToday} ${esc(t('keys.runsUnlimitedShort'))}`
  return `${key.usedToday}/${key.quotaRunsDay}`
}

const stamp = (ms) => (ms === null || ms === undefined ? '—' : new Date(ms).toLocaleString())

const scopeChecklist = () => SCOPES.map((scope) => `<label class="checkbox-line">
    <input type="checkbox" value="${esc(scope.id)}" ${scope.id === 'services:read' || scope.id === 'usage:read' || scope.id === 'conversations:write' ? 'checked' : ''} ${scope.available ? '' : 'disabled'} />
    <span>${esc(scope.label)}${scope.available ? '' : ` <span class="pill-mini muted">${esc(t('keys.scopeUnreleased'))}</span>`} <code class="muted small">${esc(scope.id)}</code></span>
    <span class="muted small">${esc(scope.note)}</span>
  </label>`).join('')

const checkedScopes = () =>
  Array.from(document.querySelectorAll('#kf-scopes input:checked'))
    .map((input) => input.value)
    .filter((value) => value !== '')

const serviceOptions = (services, selected) =>
  services.map((s) => `<option value="${esc(s.id)}"${s.id === selected ? ' selected' : ''}>${esc(s.label)} (${esc(s.id)})</option>`).join('')

const renderFilter = (services) => {
  const row = $('keys-filter')
  if (row === null) return
  row.innerHTML = `<button type="button" class="pill${activeFilter === null ? ' active' : ''}" data-filter="">${esc(t('keys.filterAll'))}</button>`
    + services.map((service) => `<button type="button" class="pill${activeFilter === service.id ? ' active' : ''}" data-filter="${esc(service.id)}">${esc(service.label)}</button>`).join('')
}

// ---------------------------------------------------------------------------
// List view
// ---------------------------------------------------------------------------
const keyRow = (key) => `<div class="node-row">
  <div class="node-main">
    <div class="node-title"><span class="dot ${stateDot(key)}"></span>${esc(key.name)} <code class="muted">${esc(key.id)}</code> ${statePill(key)}</div>
    <div class="node-sub">${key.serviceLabels.length === 0 ? '—' : esc(key.serviceLabels.join(', '))} · ${esc(t('keys.today'))} ${quotaText(key)} · ${key.maxConcurrency} ${esc(t('keys.concurrentShort'))}</div>
  </div>
  ${triggerButtonHtml({ id: `key-more-${key.id}`, label: t('common.more'), controls: menuId(key.id) })}
</div>`

const keyMenuHtml = (key) => menuPanelHtml({
  id: menuId(key.id),
  label: t('common.more'),
  items: [
    menuItemHtml({ label: t('keys.detail'), attrs: `data-key-detail="${esc(key.id)}"` }),
    menuItemHtml({ label: t('keys.edit'), attrs: `data-key-edit="${esc(key.id)}"` }),
    menuItemHtml({ label: t('keys.recordLogs'), attrs: `data-key-logs="${esc(key.id)}"` }),
    menuItemHtml({ kind: 'sep' }),
    menuItemHtml({ kind: 'danger', label: t('keys.revoke'), attrs: `data-key-revoke="${esc(key.id)}" data-key-revoke-name="${esc(key.name)}"` }),
  ],
})

const closeMenu = () => {
  if (openMenuKey === null) return
  const panel = document.getElementById(menuId(openMenuKey))
  if (panel !== null) panel.setAttribute('hidden', '')
  const trigger = document.getElementById(`key-more-${openMenuKey}`)
  if (trigger !== null) trigger.setAttribute('aria-expanded', 'false')
  openMenuKey = null
}

const openMenu = (key, trigger) => {
  if (openMenuKey === key.id) {
    closeMenu()
    return
  }
  closeMenu()
  openMenuKey = key.id
  const panel = document.getElementById(menuId(key.id))
  if (panel === null || trigger === null) return
  panel.removeAttribute('hidden')
  const rect = trigger.getBoundingClientRect()
  const pos = placePanel({ rect, width: panel.offsetWidth, height: panel.offsetHeight, viewport: { w: window.innerWidth, h: window.innerHeight } })
  panel.style.left = `${pos.left}px`
  panel.style.top = `${pos.top}px`
  trigger.setAttribute('aria-expanded', 'true')
  panel.querySelector('.menu-item')?.focus()
}

const renderList = () => {
  const list = $('keys-list')
  if (list === null || pageData === null) return
  const keys = pageData.keys.filter((key) => activeFilter === null || matchesFilter(key, activeFilter))
  const count = $('keys-count')
  if (count !== null) count.textContent = String(pageData.keys.length)
  renderFilter(pageData.services)
  // Re-rendering only on real change: the poll would otherwise rebuild the rows mid-interaction and
  // wipe an open three-dot menu out from under the cursor (the "menu flashes and stops working" bug).
  const next = JSON.stringify(keys.map((key) => ({ id: key.id, name: key.name, usedToday: key.usedToday, active: key.active, revokedAt: key.revokedAt, lastUsedAt: key.lastUsedAt, expiresAt: key.expiresAt })))
  if (next === lastRenderedList) return
  lastRenderedList = next
  closeMenu()
  setHtml('keys-list', keys.length === 0
    ? `<p class="muted small">${esc(t('keys.empty'))}</p>`
    : keys.map(keyRow).join('') + keys.map(keyMenuHtml).join(''))
  const refreshed = $('keys-refresh')
  if (refreshed !== null) refreshed.textContent = new Date().toLocaleTimeString()
}

// ---------------------------------------------------------------------------
// Detail view
// ---------------------------------------------------------------------------
const serviceRow = (service) => `<div class="node-row">
  <div class="node-main">
    <div class="node-title"><span class="dot ok"></span>${esc(service.label)} <code class="muted">${esc(service.id)}</code></div>
    <div class="node-sub">${(service.surfaces ?? []).map((s) => esc(t(`keys.surface.${s}`))).join(', ')}</div>
  </div>
  <a class="icon-btn" href="/services?service=${encodeURIComponent(service.id)}" title="${esc(t('keys.detail'))}" aria-label="${esc(t('keys.detail'))}">
    <svg width="16" height="16" aria-hidden="true"><use href="#i-chev" /></svg>
  </a>
</div>`

const renderDetail = (key, detail) => {
  const title = $('key-detail-title')
  if (title !== null) title.innerHTML = `${esc(key.name)} <code class="muted">${esc(key.id)}</code> ${statePill(key)}`

  const quotaLine = key.quotaRunsDay === null
    ? `${key.usedToday} · ${esc(t('keys.runsUnlimitedShort'))}`
    : `<span class="usage-bar"><span style="width:${Math.min(100, Math.round(key.usedToday / key.quotaRunsDay * 100))}%"></span></span> ${key.usedToday} / ${key.quotaRunsDay}`
  const serviceList = detail.services.map(serviceRow).join('')
  const calls = detail.recentCalls.length === 0
    ? `<div class="node-meta muted">${esc(t('keys.detailEmptyCalls'))}</div>`
    : detail.recentCalls.map((call) => `<div class="node-meta">${esc(stamp(call.at))} · <code>${esc(call.detail)}</code></div>`).join('')

  const body = $('key-detail-body')
  if (body !== null) {
    body.innerHTML = `
    <section class="section">
      <div class="section-head"><h2>${esc(t('keys.overview'))}</h2></div>
      <div class="card dl">
        <div class="dl-row"><span class="dl-label">${esc(t('keys.services'))}</span><span class="dl-value">${key.serviceLabels.length === 0 ? '—' : key.serviceLabels.map((label) => esc(label)).join(', ')}</span></div>
        <div class="dl-row"><span class="dl-label">${esc(t('keys.scopes'))}</span><span class="dl-value">${scopeChips(key)}</span></div>
        <div class="dl-row"><span class="dl-label">${esc(t('keys.today'))}</span><span class="dl-value">${quotaLine}</span></div>
        <div class="dl-row"><span class="dl-label">${esc(t('keys.limits'))}</span><span class="dl-value">${key.rateLimitRpm}${esc(t('keys.perMinute'))} · ${key.maxConcurrency} ${esc(t('keys.concurrentShort'))}</span></div>
        <div class="dl-row"><span class="dl-label">${esc(t('keys.expires'))}</span><span class="dl-value">${key.expiresAt === null ? esc(t('keys.expiresNever')) : esc(stamp(key.expiresAt))}</span></div>
        <div class="dl-row"><span class="dl-label">${esc(t('keys.createdLabel'))}</span><span class="dl-value">${esc(stamp(key.createdAt))}</span></div>
        <div class="dl-row"><span class="dl-label">${esc(t('keys.createdBy'))}</span><span class="dl-value">${esc(key.createdBy)}</span></div>
        <div class="dl-row"><span class="dl-label">${esc(t('keys.lastUsed'))}</span><span class="dl-value">${key.lastUsedAt === null ? '—' : esc(ago(key.lastUsedAt))}</span></div>
      </div>
    </section>
    <section class="section">
      <div class="section-head"><h2>${esc(t('keys.serving'))}</h2><span class="muted small">${String(detail.services.length)}</span></div>
      <div class="card"><div class="nodes-list">${detail.services.length === 0 ? `<p class="muted small">${esc(t('keys.detailEmptyServices'))}</p>` : serviceList}</div></div>
    </section>`
  }

  const activity = $('key-activity')
  const activityBody = $('key-activity-body')
  if (activity !== null && activityBody !== null) {
    activity.hidden = false
    activityBody.innerHTML = calls
  }
}

const openKeyDetail = async (id) => {
  detailKey = id
  showView('detail')
  const response = await apiJson(`/api/keys/${encodeURIComponent(id)}`)
  if (!response.ok) {
    showView('list')
    return
  }
  const data = response.data
  const services = (pageData?.services ?? []).filter((service) =>
    data.key.scopeServices.includes('*') || data.key.scopeServices.includes(service.id))
  renderDetail(data.key, { services, recentCalls: data.recentCalls })
}

const scrollToActivity = async (id) => {
  await openKeyDetail(id)
  document.getElementById('key-activity')?.scrollIntoView({ behavior: 'smooth' })
}

// ---------------------------------------------------------------------------
// The shared key form (create drawer and full-width edit; one instance at a time)
// ---------------------------------------------------------------------------
const keyFormHtml = () => `<form id="key-form" class="card" novalidate>
  <p id="kf-msg" class="muted" hidden></p>

  <div class="field-row">
    <label class="field">
      <span class="field-label">${esc(t('keys.name'))}</span>
      <input id="kf-name" class="text-input" maxlength="80" placeholder="${esc(t('keys.nameHint'))}" />
    </label>
    <label class="field">
      <span class="field-label">${esc(t('keys.services'))}</span>
      <select id="kf-services" class="text-input pill-select"></select>
    </label>
  </div>
  <div id="kf-services-empty" hidden>
    <a class="btn" href="/services?create=1&return=keys">${esc(t('keys.createService'))}</a>
  </div>
  <a id="kf-services-link" class="muted small" href="/services?create=1&return=keys">${esc(t('keys.newServiceLink'))}</a>

  <div class="field-row">
    <label class="field">
      <span class="field-label">${esc(t('keys.runsPerDay'))}</span>
      <input id="kf-quota" class="text-input" type="number" min="0" value="200" />
      <span class="field-hint muted small">${esc(t('keys.runsUnlimited'))}</span>
    </label>
  </div>

  <details class="node-advanced">
    <summary>${esc(t('keys.moreSettings'))}</summary>
    <div class="node-advanced-body">
      <label class="field">
        <span class="field-label">${esc(t('keys.scopes'))}</span>
        <span id="kf-scopes" class="checks"></span>
      </label>
      <div class="field-row">
        <label class="field">
          <span class="field-label">${esc(t('keys.rpm'))}</span>
          <input id="kf-rpm" class="text-input" type="number" min="1" max="6000" value="60" />
        </label>
        <label class="field">
          <span class="field-label">${esc(t('keys.concurrency'))}</span>
          <input id="kf-concurrency" class="text-input" type="number" min="1" max="64" value="4" />
        </label>
      </div>
      <label class="field">
        <span class="field-label">${esc(t('keys.expires'))}</span>
        <input id="kf-expires" class="text-input" type="date" />
      </label>
    </div>
  </details>

  <div class="form-actions">
    <button type="button" id="kf-cancel" class="btn-quiet btn-sm">${esc(t('common.cancel'))}</button>
    <button type="submit" id="kf-save" class="btn btn-sm">${formMode === 'edit' ? esc(t('common.save')) : esc(t('common.create'))}</button>
  </div>
</form>`

const readForm = () => ({
  name: $('kf-name')?.value ?? '',
  service: $('kf-services')?.value ?? '',
  quota: $('kf-quota')?.value ?? '200',
  rpm: $('kf-rpm')?.value ?? '60',
  concurrency: $('kf-concurrency')?.value ?? '4',
  expires: $('kf-expires')?.value ?? '',
  scopes: checkedScopes(),
})

const fillForm = (values) => {
  const name = $('kf-name'); if (name !== null) name.value = values.name ?? ''
  const quota = $('kf-quota'); if (quota !== null) quota.value = values.quota ?? '200'
  const rpm = $('kf-rpm'); if (rpm !== null) rpm.value = values.rpm ?? '60'
  const concurrency = $('kf-concurrency'); if (concurrency !== null) concurrency.value = values.concurrency ?? '4'
  const expires = $('kf-expires'); if (expires !== null) expires.value = values.expires ?? ''
}

const renderServicesField = () => {
  const services = pageData?.services ?? []
  const empty = $('kf-services-empty')
  const select = $('kf-services')
  const link = $('kf-services-link')
  if (empty === null || select === null || link === null) return
  empty.hidden = services.length > 0
  select.hidden = services.length === 0
  link.hidden = services.length === 0
  if (services.length > 0) {
    const wanted = formMode === 'create' ? searchParams().get('service') ?? '' : ''
    select.innerHTML = serviceOptions(services, wanted)
  }
}

const setFormMsg = (text) => {
  const msg = $('kf-msg')
  if (msg === null) return
  msg.hidden = text === ''
  msg.textContent = text
}

const renderKeyFormInto = (slotId) => {
  const slot = $(slotId)
  if (slot === null) return
  slot.innerHTML = keyFormHtml()
  const scopes = $('kf-scopes')
  if (scopes !== null) scopes.innerHTML = scopeChecklist()
  renderServicesField()
}

const openCreateDrawer = () => {
  formMode = 'create'
  issuedToken = null
  hide('key-issued')
  renderKeyFormInto('key-form-slot')
  const editor = $('key-editor')
  if (editor !== null) editor.hidden = false
  const title = $('key-editor-title')
  if (title !== null) title.textContent = t('keys.new')
  const draft = draftStore.load()
  if (draft !== null) fillForm(draft)
}

const closeCreateDrawer = () => {
  const editor = $('key-editor')
  if (editor !== null) editor.hidden = true
  issuedToken = null
}

const openKeyEdit = async (id) => {
  const response = await apiJson(`/api/keys/${encodeURIComponent(id)}`)
  if (!response.ok) return
  const key = response.data.key
  formMode = 'edit'
  renderKeyFormInto('edit-form-slot')
  fillForm({
    name: key.name,
    quota: key.quotaRunsDay === null ? '0' : String(key.quotaRunsDay),
    rpm: String(key.rateLimitRpm),
    concurrency: String(key.maxConcurrency),
    expires: key.expiresAt === null ? '' : new Date(key.expiresAt).toISOString().slice(0, 10),
  })
  const services = $('kf-services')
  if (services !== null && pageData !== null) {
    services.innerHTML = serviceOptions(pageData.services, key.scopeServices[0] ?? '')
  }
  document.querySelectorAll('#kf-scopes input').forEach((input) => {
    input.checked = key.scopes.includes(input.value) && !input.disabled
  })
  detailKey = id
  showView('form')
}

const submitForm = async () => {
  const form = readForm()
  if (form.name.trim() === '') {
    setFormMsg(t('keys.nameRequired'))
    return
  }
  if (form.service === '' && formMode === 'create' && (pageData?.services ?? []).length > 0) {
    setFormMsg(t('keys.serviceRequired'))
    return
  }
  const quotaRaw = Number(form.quota)
  const expiresRaw = form.expires
  const payload = {
    name: form.name.trim(),
    services: [form.service],
    scopes: form.scopes,
    quotaRunsDay: quotaRaw <= 0 ? null : quotaRaw,
    rateLimitRpm: Number(form.rpm),
    maxConcurrency: Number(form.concurrency),
    expiresAt: expiresRaw === '' ? null : new Date(`${expiresRaw}T23:59:59`).getTime(),
  }

  if (formMode === 'edit') {
    if (detailKey === null) return
    const response = await apiJson(`/api/keys/${encodeURIComponent(detailKey)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!response.ok) {
      setFormMsg(`${t('keys.editFailed')}: ${response.detail ?? response.status}`)
      return
    }
    await openKeyDetail(detailKey)
    await loadList()
    return
  }

  const response = await apiJson('/api/keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    setFormMsg(`${t('keys.createFailed')}: ${response.detail ?? response.status}`)
    return
  }
  const result = response.data ?? {}
  issuedToken = result.token
  const slot = $('key-form-slot')
  if (slot !== null) slot.innerHTML = ''
  show('key-issued')
  const value = $('key-token-value')
  if (value !== null) value.textContent = result.token
  const handover = $('key-handover')
  if (handover !== null && pageData !== null) handover.innerHTML = `<pre class="yaml-preview">${esc(handoverText(pageData, result.key ?? {}, result.token))}</pre>`
  const probeResult = $('key-probe-result')
  if (probeResult !== null) probeResult.innerHTML = ''
  draftStore.clear()
  await loadList()
}

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

const revokeKey = async (id, name) => {
  if (!window.confirm(t('keys.revokeConfirm', { name }))) return
  const response = await apiJson(`/api/keys/${encodeURIComponent(id)}/revoke`, { method: 'POST' })
  if (!response.ok) return
  await loadList()
  if (detailKey === id) {
    detailKey = null
    showView('list')
  }
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
// Loading + wiring
// ---------------------------------------------------------------------------
const loadList = async () => {
  const r = await apiJson('/api/keys')
  if (!r.ok) return
  pageData = r.data ?? pageData
  renderList()
}

const load = async () => {
  await loadList()
  if (searchParams().get('key') !== null) {
    const id = searchParams().get('key')
    if (id !== null && id !== '' && detailKey !== id) await openKeyDetail(id)
  }
  if (searchParams().get('create') === '1') openCreateDrawer()
}

document.addEventListener('click', (event) => {
  // Two lessons from the "menu does not react" bug:
  //   1. an SVG inside a button (the icon) is an Element, not an HTMLElement -- guarding on
  //      HTMLElement made every icon click a no-op;
  //   2. the actionable attribute lives on the *button*, while the click lands on its inner <span>:
  //      reading event.target.dataset misses it. Every branch below resolves via closest() so the
  //      deepest element (span/svg/use) still finds its action.
  const target = event.target
  if (!(target instanceof Element)) return
  const trace = globalThis.__DAC_TRACE__ === true
  if (trace) console.debug('[keys:click]', target.tagName, target.className, 'closest-close:', target.closest('[data-close]') !== null)

  const closeBtn = target.closest('[data-close]')
  if (closeBtn !== null) {
    closeCreateDrawer()
    return
  }

  const trigger = target.closest('.menu-trigger')
  if (trigger !== null) {
    const rowId = trigger.id.replace('key-more-', '')
    const key = (pageData?.keys ?? []).find((k) => k.id === rowId)
    if (trace) console.debug('[keys:menu]', rowId, 'key-found:', key !== undefined)
    if (key !== undefined) openMenu(key, trigger)
    return
  }
  if (target.closest('.menu-panel') === null) closeMenu()

  const detail = target.closest('[data-key-detail]')
  if (detail !== null) { closeMenu(); if (trace) console.debug('[keys:menu] detail', detail.dataset.keyDetail); void openKeyDetail(detail.dataset.keyDetail ?? ''); return }
  const edit = target.closest('[data-key-edit]')
  if (edit !== null) { closeMenu(); if (trace) console.debug('[keys:menu] edit', edit.dataset.keyEdit); void openKeyEdit(edit.dataset.keyEdit ?? ''); return }
  const logs = target.closest('[data-key-logs]')
  if (logs !== null) { closeMenu(); if (trace) console.debug('[keys:menu] logs', logs.dataset.keyLogs); void scrollToActivity(logs.dataset.keyLogs ?? ''); return }
  const revoke = target.closest('[data-key-revoke]')
  if (revoke !== null) { closeMenu(); if (trace) console.debug('[keys:menu] revoke', revoke.dataset.keyRevoke); void revokeKey(revoke.dataset.keyRevoke ?? '', revoke.dataset.keyRevokeName ?? revoke.dataset.keyRevoke ?? ''); return }
  const filter = target.closest('[data-filter]')
  if (filter !== null) {
    activeFilter = filter.dataset.filter === '' ? null : filter.dataset.filter
    lastRenderedList = ''
    void loadList()
    return
  }
  if (target.id === 'new-key') { openCreateDrawer(); return }
  if (target.id === 'back-list') { detailKey = null; showView('list'); return }
  if (target.id === 'back-detail') { showView('detail'); return }
  if (target.id === 'key-detail-edit' && detailKey !== null) { void openKeyEdit(detailKey); return }
  if (target.id === 'key-detail-revoke' && detailKey !== null) {
    const key = (pageData?.keys ?? []).find((k) => k.id === detailKey)
    void revokeKey(detailKey, key?.name ?? detailKey)
    return
  }
  if (target.id === 'kf-cancel') {
    if (formMode === 'edit') showView('detail')
    else closeCreateDrawer()
    return
  }
  if (target.id === 'key-token-copy') {
    void copyText($('key-token-value')?.textContent ?? '').then((ok) => {
      const msg = $('key-handover-msg')
      if (msg !== null) msg.textContent = ok ? t('keys.copied') : t('keys.copyFailed')
    })
    return
  }
  if (target.id === 'key-probe') { void probeToken(issuedToken ?? '', $('key-probe-result')); return }
  if (target.id === 'key-handover-copy') {
    void copyText($('key-handover')?.textContent ?? '').then((ok) => {
      const msg = $('key-handover-msg')
      if (msg !== null) msg.textContent = ok ? t('keys.copied') : t('keys.copyFailed')
    })
    return
  }
  if (target.id === 'key-done') { closeCreateDrawer(); void loadList(); return }
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeMenu()
})

document.addEventListener('submit', (event) => {
  if (event.target instanceof Element && event.target.id === 'key-form') {
    event.preventDefault()
    void submitForm()
  }
})

document.addEventListener('input', () => {
  if ($('key-editor')?.hidden === false && formMode === 'create') draftStore.save(readForm())
})

await load()
poll(loadList, 15_000)

// Test surface: the smoke test drives the real functions through this hook
// (never present in production -- it is created only when the test flags it).
if (globalThis.__DAC_TEST__ === true) {
  globalThis.__DAC_KEYS_TEST__ = {
    loadList,
    openKeyDetail,
    openKeyEdit,
    openCreateDrawer,
    closeCreateDrawer,
    submitForm,
    revokeKey,
    setFilter: (id) => { activeFilter = id },
    pageData: () => pageData,
    issuedToken: () => issuedToken,
    view: () => ($('view-list')?.hidden === false ? 'list' : $('view-detail')?.hidden === false ? 'detail' : 'form'),
  }
}
