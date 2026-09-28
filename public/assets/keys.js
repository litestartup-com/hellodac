// Outward API key administration (admin side, session cookie).
//
// Three views + one drawer (the v2 refactor, aligned with the nodes page):
//   - list: rows in the node-row shape, three-dot overflow menu per row (detail / edit / activity /
//     revoke), filter chips per service;
//   - detail (full width): what the key may do, the services it serves, and its activity log;
//   - edit (full width): the same fields as creation, saved with PATCH -- the secret is never touched;
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
let pageData = null // the list payload (keys / services / access)
let activeFilter = null // service id or null = all
let openMenuKey = null // which row's three-dot menu is open
let detailKey = null // the id whose detail view is open
let editingKey = null // the id being edited in the full-width form
let issuedToken = null // the fresh plaintext inside the drawer (until it closes)
const detailCache = new Map()

const menuId = (id) => `key-menu-${id}`

const matchesFilter = (key, serviceId) =>
  key.scopeServices.includes('*') || key.scopeServices.includes(serviceId)

const show = (id) => {
  const el = $(id)
  if (el !== null) el.hidden = false
}
const hide = (id) => {
  const el = $(id)
  if (el !== null) el.hidden = true
}

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

const scopeChecklist = (id) => {
  const el = $(id)
  if (el === null) return
  el.innerHTML = SCOPES.map((scope) => `<label class="checkbox-line">
    <input type="checkbox" value="${esc(scope.id)}" ${scope.id === 'services:read' || scope.id === 'usage:read' || scope.id === 'conversations:write' ? 'checked' : ''} ${scope.available ? '' : 'disabled'} />
    <span>${esc(scope.label)}${scope.available ? '' : ` <span class="pill-mini muted">${esc(t('keys.scopeUnreleased'))}</span>`} <code class="muted small">${esc(scope.id)}</code></span>
    <span class="muted small">${esc(scope.note)}</span>
  </label>`).join('')
}

const checkedScopes = (rootId) =>
  Array.from(document.querySelectorAll(`${rootId} input:checked`))
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
const keyRow = (key) => `<div class="node-row" data-key-row="${esc(key.id)}">
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
  if (openMenuKey !== null) closeMenu()
  openMenuKey = key.id
  const panel = document.getElementById(menuId(key.id))
  if (panel === null || trigger === null) return
  panel.removeAttribute('hidden')
  const rect = trigger.getBoundingClientRect()
  const pos = placePanel({ rect, width: panel.offsetWidth, height: panel.offsetHeight, viewport: { w: window.innerWidth, h: window.innerHeight } })
  panel.style.left = `${pos.left}px`
  panel.style.top = `${pos.top}px`
  trigger.setAttribute('aria-expanded', 'true')
}

const renderList = () => {
  const list = $('keys-list')
  if (list === null || pageData === null) return
  const keys = pageData.keys.filter((key) => activeFilter === null || matchesFilter(key, activeFilter))
  const count = $('keys-count')
  if (count !== null) count.textContent = String(pageData.keys.length)
  renderFilter(pageData.services)
  setHtml('keys-list', keys.length === 0
    ? `<p class="muted small">${esc(t('keys.empty'))}</p>`
    : keys.map(keyRow).join('') + keys.map(keyMenuHtml).join(''))
  const refreshed = $('keys-refresh')
  if (refreshed !== null) refreshed.textContent = new Date().toLocaleTimeString()
}

// ---------------------------------------------------------------------------
// Detail view
// ---------------------------------------------------------------------------
const serviceRow = (service) => `<div class="node-row" data-service-row="${esc(service.id)}">
  <div class="node-main">
    <div class="node-title"><span class="dot ok"></span>${esc(service.label)} <code class="muted">${esc(service.id)}</code></div>
    <div class="node-sub">${(service.surfaces ?? []).map((s) => esc(t(`keys.surface.${s}`))).join(', ')}</div>
  </div>
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
  // The detail endpoint carries the key face plus calls/runs; the service list comes from the page
  // payload so the two agree on labels.
  const services = (pageData?.services ?? []).filter((service) =>
    data.key.scopeServices.includes('*') || data.key.scopeServices.includes(service.id))
  renderDetail(data.key, { services, recentCalls: data.recentCalls })
}

const scrollToActivity = async (id) => {
  await openKeyDetail(id)
  document.getElementById('key-activity')?.scrollIntoView({ behavior: 'smooth' })
}

// ---------------------------------------------------------------------------
// Edit view (full width)
// ---------------------------------------------------------------------------
const fillEditForm = (key) => {
  const name = $('key-name'); if (name !== null) name.value = key.name
  const quota = $('key-quota'); if (quota !== null) quota.value = key.quotaRunsDay === null ? '0' : String(key.quotaRunsDay)
  const rpm = $('key-rpm'); if (rpm !== null) rpm.value = String(key.rateLimitRpm)
  const concurrency = $('key-concurrency'); if (concurrency !== null) concurrency.value = String(key.maxConcurrency)
  const expires = $('key-expires'); if (expires !== null) expires.value = key.expiresAt === null ? '' : new Date(key.expiresAt).toISOString().slice(0, 10)
  const services = $('key-services')
  if (services !== null && pageData !== null) {
    services.innerHTML = serviceOptions(pageData.services, key.scopeServices[0] ?? '')
  }
  // Scopes are shared checkboxes; tick only what this key holds.
  document.querySelectorAll('#key-scopes input').forEach((input) => {
    input.checked = key.scopes.includes(input.value) && !input.disabled
  })
}

const openKeyEdit = async (id) => {
  const response = await apiJson(`/api/keys/${encodeURIComponent(id)}`)
  if (!response.ok) return
  editingKey = id
  fillEditForm(response.data.key)
  showView('form')
}

const saveKeyEdit = async () => {
  if (editingKey === null) return
  const name = $('key-name')?.value ?? ''
  if (name.trim() === '') {
    const msg = $('key-edit-msg')
    if (msg !== null) { msg.hidden = false; msg.textContent = t('keys.nameRequired') }
    return
  }
  const quotaRaw = Number($('key-quota')?.value ?? '200')
  const expiresRaw = $('key-expires')?.value ?? ''
  const response = await apiJson(`/api/keys/${encodeURIComponent(editingKey)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: name.trim(),
      services: [$('key-services')?.value ?? ''],
      scopes: checkedScopes('#key-scopes'),
      quotaRunsDay: quotaRaw <= 0 ? null : quotaRaw,
      rateLimitRpm: Number($('key-rpm')?.value ?? '60'),
      maxConcurrency: Number($('key-concurrency')?.value ?? '4'),
      expiresAt: expiresRaw === '' ? null : new Date(`${expiresRaw}T23:59:59`).getTime(),
    }),
  })
  const msg = $('key-edit-msg')
  if (!response.ok && msg !== null) {
    msg.hidden = false
    msg.textContent = `${t('keys.editFailed')}: ${response.detail ?? response.status}`
    return
  }
  editingKey = null
  await openKeyDetail(detailKey ?? (response.data?.key?.id ?? ''))
}

// ---------------------------------------------------------------------------
// Create drawer
// ---------------------------------------------------------------------------
const openCreateDrawer = () => {
  issuedToken = null
  hide('key-issued')
  show('key-create-form')
  const editor = $('key-editor')
  if (editor !== null) editor.hidden = false

  const services = pageData?.services ?? []
  const empty = $('f-key-services-empty')
  const select = $('f-key-services')
  const link = $('f-key-services-link')
  if (empty !== null && select !== null && link !== null) {
    empty.hidden = services.length > 0
    select.hidden = services.length === 0
    link.hidden = services.length === 0
    if (services.length > 0) {
      select.innerHTML = serviceOptions(services, searchParams().get('service') ?? '')
    }
  }
  scopeChecklist('f-key-scopes')
  // Draft from the "create a service" round trip.
  const draft = draftStore.load()
  if (draft !== null) {
    const name = $('f-key-name'); if (name !== null && typeof draft.name === 'string') name.value = draft.name
    const quota = $('f-key-quota'); if (quota !== null && typeof draft.quota === 'string') quota.value = draft.quota
    const rpm = $('f-key-rpm'); if (rpm !== null && typeof draft.rpm === 'string') rpm.value = draft.rpm
    const concurrency = $('f-key-concurrency'); if (concurrency !== null && typeof draft.concurrency === 'string') concurrency.value = draft.concurrency
    const expires = $('f-key-expires'); if (expires !== null && typeof draft.expires === 'string') expires.value = draft.expires
  }
}

const closeCreateDrawer = () => {
  const editor = $('key-editor')
  if (editor !== null) editor.hidden = true
  issuedToken = null
}

const readCreateForm = () => ({
  name: $('f-key-name')?.value ?? '',
  service: $('f-key-services')?.value ?? '',
  quota: $('f-key-quota')?.value ?? '200',
  rpm: $('f-key-rpm')?.value ?? '60',
  concurrency: $('f-key-concurrency')?.value ?? '4',
  expires: $('f-key-expires')?.value ?? '',
  scopes: checkedScopes('#f-key-scopes'),
})

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

const setCreateMsg = (text) => {
  const msg = $('key-create-msg')
  if (msg === null) return
  msg.hidden = text === ''
  msg.textContent = text
}

const createKey = async () => {
  const form = readCreateForm()
  if (form.name.trim() === '') {
    setCreateMsg(t('keys.nameRequired'))
    return
  }
  if (form.service === '' && (pageData?.services ?? []).length > 0) {
    setCreateMsg(t('keys.serviceRequired'))
    return
  }
  const quotaRaw = Number(form.quota)
  const expiresRaw = form.expires
  const response = await apiJson('/api/keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: form.name.trim(),
      services: [form.service],
      scopes: form.scopes,
      quotaRunsDay: quotaRaw <= 0 ? null : quotaRaw,
      rateLimitRpm: Number(form.rpm),
      maxConcurrency: Number(form.concurrency),
      expiresAt: expiresRaw === '' ? null : new Date(`${expiresRaw}T23:59:59`).getTime(),
    }),
  })
  if (!response.ok) {
    setCreateMsg(`${t('keys.createFailed')}: ${response.detail ?? response.status}`)
    return
  }
  const payload = response.data ?? {}
  issuedToken = payload.token
  hide('key-create-form')
  show('key-issued')
  const value = $('key-token-value')
  if (value !== null) value.textContent = payload.token
  const handover = $('key-handover')
  if (handover !== null && pageData !== null) handover.innerHTML = `<pre class="yaml-preview">${esc(handoverText(pageData, payload.key ?? {}, payload.token))}</pre>`
  const probeResult = $('key-probe-result')
  if (probeResult !== null) probeResult.innerHTML = ''
  draftStore.clear()
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
  // Deep link: ?key=<id> opens the detail view.
  if (searchParams().get('key') !== null) {
    const id = searchParams().get('key')
    if (id !== null && id !== '' && detailKey !== id) await openKeyDetail(id)
  }
  if (searchParams().get('create') === '1') openCreateDrawer()
}

document.addEventListener('click', (event) => {
  const target = event.target
  if (!(target instanceof HTMLElement)) return

  // Drawer close (backdrop + × + cancel).
  if (target.dataset.close !== undefined) {
    closeCreateDrawer()
    return
  }

  // Three-dot menu: open/close per row.
  const trigger = target.closest('.menu-trigger')
  if (trigger !== null) {
    const rowId = trigger.id.replace('key-more-', '')
    const key = (pageData?.keys ?? []).find((k) => k.id === rowId)
    if (key !== undefined) {
      if (openMenuKey === key.id) closeMenu()
      else openMenu(key, trigger)
    }
    return
  }
  // A click inside a menu panel keeps it open; any other click closes it.
  if (!target.closest('.menu-panel')) closeMenu()

  if (target.dataset.keyDetail !== undefined) { closeMenu(); void openKeyDetail(target.dataset.keyDetail); return }
  if (target.dataset.keyEdit !== undefined) { closeMenu(); void openKeyEdit(target.dataset.keyEdit); return }
  if (target.dataset.keyLogs !== undefined) { closeMenu(); void scrollToActivity(target.dataset.keyLogs); return }
  if (target.dataset.keyRevoke !== undefined) { closeMenu(); void revokeKey(target.dataset.keyRevoke, target.dataset.keyRevokeName ?? target.dataset.keyRevoke); return }
  if (target.dataset.filter !== undefined) {
    activeFilter = target.dataset.filter === '' ? null : target.dataset.filter
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
  if (target.id === 'key-edit-cancel') { showView('detail'); return }
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

  // Row click -> detail (the trigger and menus are excluded above).
  const row = target.closest('[data-key-row]')
  if (row !== null) {
    const id = row.dataset.keyRow ?? ''
    void openKeyDetail(id)
    return
  }
  const serviceLink = target.closest('[data-service-row]')
  if (serviceLink !== null) {
    window.location.href = `/services?service=${encodeURIComponent(serviceLink.dataset.serviceRow ?? '')}`
  }
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeMenu()
})

$('key-create-form')?.addEventListener('submit', (event) => {
  event.preventDefault()
  void createKey()
})
$('key-edit-form')?.addEventListener('submit', (event) => {
  event.preventDefault()
  void saveKeyEdit()
})

document.addEventListener('input', () => {
  if ($('key-editor')?.hidden === false) draftStore.save(readCreateForm())
})

// The checklist on the edit form is static too (the drawer's lives in #f-key-scopes).
scopeChecklist('key-scopes')

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
    createKey,
    saveKeyEdit,
    revokeKey,
    setFilter: (id) => { activeFilter = id },
    pageData: () => pageData,
    issuedToken: () => issuedToken,
    view: () => ($('view-list')?.hidden === false ? 'list' : $('view-detail')?.hidden === false ? 'detail' : 'form'),
  }
}
