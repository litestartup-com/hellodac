// Outward API key administration (admin side, session cookie).
//
// Three views + two drawers (the v2 refactor, aligned with the nodes page):
//   - list: rows in the node-row shape, three-dot overflow menu per row (detail / edit / examples /
//     revoke), filter chips per service; the menu is the only way into a key (row clicks do not
//     navigate -- navigating on a stray click is more surprising than helpful). The menu used to
//     carry an "activity log" shortcut too, but it only opened the same detail view (scrolled
//     down), so two items led to one place and the redundant one is gone;
//   - detail (full width): what the key may do, the services it serves (each row ends in an explicit
//     detail link), and its activity log; the back link sits under the title, not beside it;
//   - edit (full width): the same form as creation, saved with PATCH -- the secret is never touched;
//   - drawer: creating a key. Three visible fields (name / service / runs per day, 0 = unlimited),
//     the rest under "more settings"; the result step holds the secret (shown once), the read-only
//     outward test and the copyable handover block (the full agent brief, real token embedded);
//   - drawer: call examples for an existing key -- scope-filtered, copy-ready curl plus the same
//     agent brief in env-var form (the secret is long gone server-side; a local paste, memory
//     only, completes the examples).
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
let examplesKey = null // the key whose call-examples drawer is open
let examplesSecret = '' // pasted secret, MEMORY ONLY -- discarded the moment the drawer closes
let examplesCopies = [] // copy-button texts, parallel to the rendered code blocks

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
    menuItemHtml({ label: t('keys.examples'), attrs: `data-key-examples="${esc(key.id)}"` }),
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

// Rendered through setHtml (write only on real change): the detail refreshes with the list poll,
// and rewriting identical innerHTML every 15s would clear a text selection mid-copy for nothing.
const renderDetail = (key, detail) => {
  setHtml('key-detail-title', `${esc(key.name)} <code class="muted">${esc(key.id)}</code> ${statePill(key)}`)

  const quotaLine = key.quotaRunsDay === null
    ? `${key.usedToday} · ${esc(t('keys.runsUnlimitedShort'))}`
    : `<span class="usage-bar"><span style="width:${Math.min(100, Math.round(key.usedToday / key.quotaRunsDay * 100))}%"></span></span> ${key.usedToday} / ${key.quotaRunsDay}`
  const serviceList = detail.services.map(serviceRow).join('')
  // One hairline-separated line per call (time column + request): the old .node-meta stack at
  // 11.5px/2px read as a cramped wall of tiny text on the detail page.
  const calls = detail.recentCalls.length === 0
    ? `<p class="muted small">${esc(t('keys.detailEmptyCalls'))}</p>`
    : detail.recentCalls.map((call) => `<div class="log-row"><span class="log-at">${esc(stamp(call.at))}</span><code class="log-what">${esc(call.detail)}</code></div>`).join('')

  setHtml('key-detail-body', `
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
      <div class="card"><div class="nodes-list flat">${detail.services.length === 0 ? `<p class="muted small">${esc(t('keys.detailEmptyServices'))}</p>` : serviceList}</div></div>
    </section>`)

  const activity = $('key-activity')
  if (activity !== null) activity.hidden = false
  setHtml('key-activity-body', calls)
}

const fetchKeyDetail = async (id) => {
  const response = await apiJson(`/api/keys/${encodeURIComponent(id)}`)
  if (!response.ok) return false
  const data = response.data
  const services = (pageData?.services ?? []).filter((service) =>
    data.key.scopeServices.includes('*') || data.key.scopeServices.includes(service.id))
  renderDetail(data.key, { services, recentCalls: data.recentCalls })
  return true
}

const openKeyDetail = async (id) => {
  detailKey = id
  showView('detail')
  const ok = await fetchKeyDetail(id)
  if (!ok) showView('list')
}

// The open detail refreshes with the same poll as the list (the services detail already does):
// the "Today" counter and the activity log are live data, and a detail frozen at open time
// silently disagrees with the list beside it. A transient fetch failure keeps the last good
// render -- a background poll must not kick the reader back to the list.
const refreshKeyDetail = async () => {
  if (detailKey === null || $('view-detail')?.hidden !== false) return
  await fetchKeyDetail(detailKey)
}

// ---------------------------------------------------------------------------
// Call-examples drawer (right-side panel, same machinery as the create drawer)
// ---------------------------------------------------------------------------
const renderKeyExamples = (key) => {
  const page = pageData
  if (page === null) return
  const base = page.access.baseUrl
  const authRef = '$DAC_API_KEY'
  const service = exampleServiceId(page, key)
  const scopes = briefScopes(key)
  examplesCopies = []

  const warning = key.revokedAt !== null
    ? `<div class="banner warn">${esc(t('keys.examplesRevoked'))}</div>`
    : key.expiresAt !== null && key.expiresAt <= Date.now()
      ? `<div class="banner warn">${esc(t('keys.examplesExpired'))}</div>`
      : ''

  // One label + copy button + code block. The setup block copies by id (its text changes when
  // the secret is pasted, so indexing a snapshot would copy a stale line).
  const block = (label, note, text, opts = {}) => {
    const isSetup = opts.copyRef === 'setup'
    const ref = isSetup ? 'setup' : String(examplesCopies.length)
    if (!isSetup) examplesCopies.push(text)
    const idAttr = opts.preId === undefined ? '' : ` id="${esc(opts.preId)}"`
    return `<div class="ex-block">
      <div class="ex-head"><span class="section-label">${esc(label)}</span><button type="button" class="btn-quiet btn-sm" data-ex-copy="${ref}">${esc(t('keys.copy'))}</button></div>
      ${note === '' ? '' : `<p class="muted small ex-note">${esc(note)}</p>`}
      <pre class="yaml-preview"${idAttr}>${esc(text)}</pre>
    </div>`
  }

  const firstComment = serviceComment(key)
  const parts = [
    warning,
    `<div class="ex-block">
      <div class="ex-head"><span class="section-label">${esc(t('keys.examplesAuth'))}</span></div>
      <p class="muted small ex-note">${esc(t('keys.examplesAuthNote'))}</p>
      <label class="field">
        <span class="field-label">${esc(t('keys.examplesSecretLabel'))}</span>
        <input id="kx-secret" class="text-input mono" type="password" autocomplete="off" spellcheck="false" placeholder="dac_${esc(key.id)}_…" />
        <span class="field-hint muted small">${esc(t('keys.examplesSecretHint'))}</span>
      </label>
    </div>`,
    block(t('keys.examplesSetup'), '', setupLine(key, examplesSecret), { copyRef: 'setup', preId: 'kx-setup' }),
  ]
  if (scopes.includes('conversations:write')) {
    parts.push(block(t('keys.examplesFirst'), t('keys.examplesFirstNote'), (firstComment === null ? '' : `${firstComment}\n`) + curlFirst(base, authRef, service)))
    parts.push(block(t('keys.examplesContinue'), t('keys.examplesContinueNote'), curlContinue(base, authRef)))
  }
  parts.push(block(t('keys.examplesRead'), '', curlReadLines(base, authRef, scopes).join('\n')))
  parts.push(`<div class="ex-block">
      <div class="ex-head"><span class="section-label">${esc(t('keys.examplesErrors'))}</span></div>
      <p class="muted small ex-note">${esc(t('keys.examplesErrorsText'))}</p>
    </div>`)
  parts.push(`<div class="ex-actions">
      <button type="button" class="btn" data-ex-brief="1">${esc(t('keys.examplesBrief'))}</button>
      <span id="kx-msg" class="muted small"></span>
    </div>
    <p class="muted small ex-quota">${esc(t('keys.today'))} ${quotaText(key)} · ${key.rateLimitRpm}${esc(t('keys.perMinute'))} · ${key.maxConcurrency} ${esc(t('keys.concurrentShort'))} · ${key.expiresAt === null ? esc(t('keys.expiresNever')) : esc(stamp(key.expiresAt))}</p>`)

  const title = $('key-examples-title')
  if (title !== null) title.textContent = `${t('keys.examples')} · ${key.name}`
  // Plain innerHTML, not setHtml: reopening the same key must re-render even when the markup is
  // identical -- closeKeyExamples wipes the body so a pasted secret cannot survive in the DOM.
  const body = $('key-examples-body')
  if (body !== null) body.innerHTML = parts.join('')
}

const openKeyExamples = (id) => {
  if (pageData === null) return
  const key = pageData.keys.find((k) => k.id === id)
  if (key === undefined) return
  examplesKey = id
  examplesSecret = ''
  renderKeyExamples(key)
  const panel = $('key-examples')
  if (panel !== null) panel.hidden = false
}

const closeKeyExamples = () => {
  const panel = $('key-examples')
  if (panel !== null) panel.hidden = true
  const body = $('key-examples-body')
  if (body !== null) body.innerHTML = '' // a pasted secret must not linger in a hidden DOM
  examplesKey = null
  examplesSecret = ''
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
  if (handover !== null && pageData !== null) handover.innerHTML = `<pre class="yaml-preview">${esc(agentBrief(pageData, result.key ?? {}, result.token))}</pre>`
  const probeResult = $('key-probe-result')
  if (probeResult !== null) probeResult.innerHTML = ''
  draftStore.clear()
  await loadList()
}

// ---------------------------------------------------------------------------
// The call brief: one self-contained English block an AI coding agent (or a human with a
// terminal) can run as-is. Two callers, two forms of the same text, one generator so the
// customer handover and the after-the-fact examples can never drift:
//   - the creation drawer embeds the real, only-ever-shown-once token;
//   - the examples drawer cannot (the server keeps hashes only), so the secret stays an env
//     var unless the admin pastes it locally -- memory only, discarded on close.
// ---------------------------------------------------------------------------
const briefScopes = (key) => (Array.isArray(key.scopes) ? key.scopes : [])

const exampleServiceId = (page, key) => {
  const scopeServices = Array.isArray(key.scopeServices) ? key.scopeServices : []
  if (scopeServices.includes('*')) return page.services[0]?.id ?? '<service-id>'
  return scopeServices[0] ?? '<service-id>'
}

const setupLine = (key, secret) =>
  `export DAC_API_KEY="dac_${key.id}_${secret === '' ? '<secret — shown once at creation>' : secret}"`

const curlFirst = (base, authRef, service) => [
  `curl -X POST "${base}/conversations" \\`,
  `  -H "Authorization: Bearer ${authRef}" \\`,
  '  -H "content-type: application/json" \\',
  `  -d '{"service":"${service}","externalUserId":"customer-1","text":"hello"}'`,
].join('\n')

const curlContinue = (base, authRef) => [
  `curl -X POST "${base}/conversations/<conversation-id>/messages" \\`,
  `  -H "Authorization: Bearer ${authRef}" \\`,
  '  -H "content-type: application/json" \\',
  `  -d '{"text":"follow-up"}'`,
].join('\n')

const curlReadLines = (base, authRef, scopes) => [
  ...(scopes.includes('services:read') ? [`curl "${base}/services" -H "Authorization: Bearer ${authRef}"   # scope services:read`] : []),
  ...(scopes.includes('usage:read') ? [`curl "${base}/usage" -H "Authorization: Bearer ${authRef}"   # scope usage:read`] : []),
  `curl "${base}/health"   # no auth — liveness probe`,
]

// A key scoped to several services deserves a say-so right above the first example.
const serviceComment = (key) => {
  const scopeServices = Array.isArray(key.scopeServices) ? key.scopeServices : []
  if (scopeServices.includes('*')) return '# "service" may be any declared service (wildcard key)'
  if (scopeServices.length > 1) return `# "service" may be any of: ${scopeServices.join(', ')}`
  return null
}

const quotaBriefLine = (page, key) => {
  const runs = key.quotaRunsDay === null || key.quotaRunsDay === undefined ? 'unlimited dispatches' : `${key.quotaRunsDay} dispatches`
  const expires = key.expiresAt === null || key.expiresAt === undefined ? '' : ` Key expires ${new Date(key.expiresAt).toISOString().slice(0, 10)}.`
  return `Quota: ${runs} per local day (${page.access.quotaTimeZone}; resets at local midnight; failed dispatches count), ${key.rateLimitRpm ?? 0} req/min, ${key.maxConcurrency ?? 0} in flight.${expires}`
}

/**
 * @param {{ access: { baseUrl: string, quotaTimeZone: string }, services: Array<{ id: string }> }} page
 * @param {object} rawKey a keyFace-shaped key (tolerates the just-created minimal shape)
 * @param {string | null | undefined} token the real plaintext, or null for the env-var form
 * @returns {string}
 */
const agentBrief = (page, rawKey, token) => {
  const key = rawKey ?? {}
  const tok = typeof token === 'string' && token !== '' ? token : null
  const base = page.access.baseUrl
  const scopes = briefScopes(key)
  const labels = Array.isArray(key.serviceLabels) ? key.serviceLabels : []
  const scopeServices = Array.isArray(key.scopeServices) ? key.scopeServices : []
  const service = exampleServiceId(page, key)
  const authRef = tok ?? '$DAC_API_KEY'
  const servicesLine = scopeServices.includes('*')
    ? 'any declared service (wildcard key)'
    : labels.length === 0 ? '—' : labels.join(', ')

  const lines = [
    `DAC outward API brief — key "${key.name ?? ''}" (${key.id ?? ''})`,
    '',
    `Endpoint: ${base}`,
    `Auth: Authorization: Bearer ${authRef}   (or the same value in X-API-Key)`,
  ]
  if (tok === null) {
    lines.push(`      In a shell first:  ${setupLine(key, '')}`)
    lines.push('      (the secret was shown once, at creation — the server stores only its hash)')
  }
  lines.push(`Services this key may enter: ${servicesLine}`, `Scopes: ${scopes.join(', ') || '—'}`, '')
  const indent = (text) => text.split('\n').map((line) => `  ${line}`).join('\n')
  if (scopes.includes('conversations:write')) {
    lines.push(
      'Start a conversation and run the first turn (scope conversations:write):',
      indent(curlFirst(base, authRef, service)),
      '  -> 201 with the conversation and the first reply. The same externalUserId always',
      '     returns to the same conversation (stickiness); idle past session_idle_hours',
      '     (24h default) it is reclaimed and answering it 404s.',
      '',
      'Continue by conversation id:',
      indent(curlContinue(base, authRef)),
      '',
    )
  }
  lines.push('Read-only:', indent(curlReadLines(base, authRef, scopes).join('\n')), '')
  lines.push(
    'Behaviour: if something is unclear the agent asks in its reply text and ends the turn --',
    '           a turn never blocks on an interactive prompt. A turn that cannot finish within the',
    '           service timeout comes back as state "failed" with the reason, honestly.',
    '',
  )
  lines.push(
    quotaBriefLine(page, key),
    '',
    'Errors: {"error":"<code>","detail":"<text>"} — 401 bad/revoked key, 403 scope or',
    '        service not allowed, 404 unknown or reclaimed conversation, 429 quota/rate/',
    '        concurrency (Retry-After where applicable), 502 the turn ran and failed (body',
    '        carries state/error), 503 no agent online.',
    'Full contract: docs/openapi.yaml',
  )
  return lines.join('\n')
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

  const closeExamples = target.closest('[data-close-examples]')
  if (closeExamples !== null) {
    closeKeyExamples()
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
  const examplesItem = target.closest('[data-key-examples]')
  if (examplesItem !== null) { closeMenu(); if (trace) console.debug('[keys:menu] examples', examplesItem.dataset.keyExamples); openKeyExamples(examplesItem.dataset.keyExamples ?? ''); return }
  const revoke = target.closest('[data-key-revoke]')
  if (revoke !== null) { closeMenu(); if (trace) console.debug('[keys:menu] revoke', revoke.dataset.keyRevoke); void revokeKey(revoke.dataset.keyRevoke ?? '', revoke.dataset.keyRevokeName ?? revoke.dataset.keyRevoke ?? ''); return }
  const filter = target.closest('[data-filter]')
  if (filter !== null) {
    activeFilter = filter.dataset.filter === '' ? null : filter.dataset.filter
    lastRenderedList = ''
    void loadList()
    return
  }
  const exCopy = target.closest('[data-ex-copy]')
  if (exCopy !== null) {
    // The setup block copies live from its <pre> (a pasted secret updates it in place); the
    // other blocks copy the snapshot taken at render time.
    const ref = exCopy.dataset.exCopy ?? ''
    const text = ref === 'setup' ? ($('kx-setup')?.textContent ?? '') : (examplesCopies[Number(ref)] ?? '')
    void copyText(text).then((ok) => {
      const msg = $('kx-msg')
      if (msg !== null) msg.textContent = ok ? t('keys.copied') : t('keys.copyFailed')
    })
    return
  }
  const exBrief = target.closest('[data-ex-brief]')
  if (exBrief !== null) {
    // Built at click time, not render time: a secret pasted after the drawer opened must ride along.
    const key = (pageData?.keys ?? []).find((k) => k.id === examplesKey)
    if (key !== undefined && pageData !== null) {
      const token = examplesSecret === '' ? null : `dac_${key.id}_${examplesSecret}`
      void copyText(agentBrief(pageData, key, token)).then((ok) => {
        const msg = $('kx-msg')
        if (msg !== null) msg.textContent = ok ? t('keys.copied') : t('keys.copyFailed')
      })
    }
    return
  }
  if (target.id === 'new-key') { openCreateDrawer(); return }
  if (target.id === 'back-list') { detailKey = null; showView('list'); return }
  if (target.id === 'back-detail') { showView('detail'); return }
  if (target.id === 'key-detail-examples' && detailKey !== null) { openKeyExamples(detailKey); return }
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
  if (event.key === 'Escape') { closeMenu(); closeKeyExamples() }
})

document.addEventListener('submit', (event) => {
  if (event.target instanceof Element && event.target.id === 'key-form') {
    event.preventDefault()
    void submitForm()
  }
})

document.addEventListener('input', (event) => {
  const target = event?.target
  if (target !== null && target !== undefined && target.id === 'kx-secret') {
    // A pasted secret updates the export line in place (the only spot it appears) -- never a
    // drawer re-render, which would drop the input focus mid-paste, and never storage.
    examplesSecret = String(target.value ?? '')
    const key = (pageData?.keys ?? []).find((k) => k.id === examplesKey)
    const pre = $('kx-setup')
    if (key !== undefined && pre !== null) pre.textContent = setupLine(key, examplesSecret)
    return
  }
  if ($('key-editor')?.hidden === false && formMode === 'create') draftStore.save(readForm())
})

await load()
poll(async () => {
  await loadList()
  await refreshKeyDetail()
}, 15_000)

// Test surface: the smoke test drives the real functions through this hook
// (never present in production -- it is created only when the test flags it).
if (globalThis.__DAC_TEST__ === true) {
  globalThis.__DAC_KEYS_TEST__ = {
    loadList,
    openKeyDetail,
    refreshKeyDetail,
    openKeyEdit,
    openKeyExamples,
    closeKeyExamples,
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
