// Outward service overview + declaration editor (admin side, session cookie).
//
// The v2 refactor mirrors the nodes page: three views (list / detail / edit) plus a drawer for
// creating. Two truths live here and they are different things:
//   - the snapshot (`GET /api/services`): what is running -- agents online, capacity in use, queue, keys;
//   - the declaration (`GET/POST/DELETE /api/config/services`): what manager.config.yaml says.
// The editor (shared by the create drawer and the full-width edit view) previews the exact YAML that
// would be written and asks the real loader whether it would boot before writing anything.
import { $, esc, setHtml, apiJson, poll, t, loadI18n } from './ui.js'
import { triggerButtonHtml, menuItemHtml, menuPanelHtml, placePanel } from './menu.js'

await loadI18n()

const searchParams = () => {
  try {
    return new URLSearchParams(window.location?.search ?? '')
  } catch {
    return new URLSearchParams('')
  }
}

let lastRedirect = null
const redirect = (url) => {
  lastRedirect = url
  try {
    window.location.href = url
  } catch {
    // The test stub has no real navigation; the assertion reads lastRedirect.
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const draft = {
  id: '',
  label: '',
  workers: [],
  surfaces: ['conversations'],
  permission: 'read',
  sessionIdleHours: 24,
  placement: 'spread',
  machines: [],
  capacity: 4,
  maxAgentsPerMachine: 4,
  thresholds: null, // kept verbatim from the declaration (the form has no such field)
  knowledge: [],
}

let editorCtx = null // { configHash, services, workers, machines }
let snapshot = { services: [], keysExist: false }
let editingId = null // null = creating
let detailId = null // the service whose detail view is open
let view = 'list' // list | detail | form
let previewTimer = null
let openMenuService = null
let openedFromParam = false
let lastRenderedList = ''

const menuId = (id) => `service-menu-${id}`

const show = (id) => { const el = $(id); if (el !== null) el.hidden = false }
const hide = (id) => { const el = $(id); if (el !== null) el.hidden = true }

const showView = (next) => {
  view = next
  hide('view-list'); hide('view-detail'); hide('view-form')
  show(`view-${next}`)
}

// ---------------------------------------------------------------------------
// List view
// ---------------------------------------------------------------------------
const capacityLine = (service) => {
  const capacity = service.capacity
  return `${capacity.onlineAgents}/${capacity.declaredAgents} ${esc(t('services.agentsOnline'))} · ${capacity.inUse}/${capacity.maxConcurrent} ${esc(t('services.inUse'))} · ${capacity.queued} ${esc(t('services.queued'))}`
}

const serviceRow = (service) => {
  const dot = service.capacity.onlineAgents > 0 ? 'ok' : 'bad'
  return `<div class="node-row">
  <div class="node-main">
    <div class="node-title"><span class="dot ${dot}"></span>${esc(service.label)} <code class="muted">${esc(service.id)}</code></div>
    <div class="node-sub">${capacityLine(service)}</div>
  </div>
  <div class="node-ver">${service.keys.length} ${esc(t('services.keysShort'))}</div>
  ${triggerButtonHtml({ id: `service-more-${service.id}`, label: t('common.more'), controls: menuId(service.id) })}
</div>`
}

const serviceMenuHtml = (service) => menuPanelHtml({
  id: menuId(service.id),
  label: t('common.more'),
  items: [
    menuItemHtml({ label: t('services.detail'), attrs: `data-service-detail="${esc(service.id)}"` }),
    menuItemHtml({ label: t('services.edit'), attrs: `data-service-edit="${esc(service.id)}"` }),
    menuItemHtml({ label: t('services.issueKey'), attrs: `data-service-key="${esc(service.id)}"` }),
    menuItemHtml({ kind: 'sep' }),
    menuItemHtml({ kind: 'danger', label: t('services.delete'), attrs: `data-service-delete="${esc(service.id)}" data-service-delete-name="${esc(service.label)}"` }),
  ],
})

const closeMenu = () => {
  if (openMenuService === null) return
  const panel = document.getElementById(menuId(openMenuService))
  if (panel !== null) panel.setAttribute('hidden', '')
  const trigger = document.getElementById(`service-more-${openMenuService}`)
  if (trigger !== null) trigger.setAttribute('aria-expanded', 'false')
  openMenuService = null
}

const openMenu = (service, trigger) => {
  if (openMenuService === service.id) {
    closeMenu()
    return
  }
  closeMenu()
  openMenuService = service.id
  const panel = document.getElementById(menuId(service.id))
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
  const list = $('services-list')
  if (list === null) return
  const services = snapshot.services ?? []
  const count = $('services-count')
  if (count !== null) count.textContent = String(services.length)
  // Same guard as the keys page: re-rendering on every poll wipes an open three-dot menu out from
  // under the cursor -- only render when the visible data actually changed.
  const next = JSON.stringify(services.map((s) => ({ id: s.id, label: s.label, keys: s.keys.length, capacity: s.capacity, agents: s.agents.map((a) => [a.online, a.sessions, a.queueDepth]) })))
  if (next === lastRenderedList) return
  lastRenderedList = next
  closeMenu()
  setHtml('services-list', services.length === 0
    ? `<p class="muted small">${esc(t('services.empty'))}</p>`
    : services.map(serviceRow).join('') + services.map(serviceMenuHtml).join(''))
  const refreshed = $('services-refresh')
  if (refreshed !== null) refreshed.textContent = new Date().toLocaleTimeString()
}

// ---------------------------------------------------------------------------
// The editor form (shared by drawer and edit view; one instance at a time)
// ---------------------------------------------------------------------------
const agentLabel = (worker) => {
  if (worker.blockedReason === null) return `${esc(worker.name)} <code class="muted">${esc(worker.id)}</code>`
  const why = worker.blockedReason === 'already serves'
    ? t('services.form.blockedAlready', { service: worker.serviceId ?? '' })
    : worker.blockedReason === 'no model pin'
      ? t('services.form.blockedNoPin')
      : t('services.form.blockedNoRate', { model: worker.model ?? '' })
  return `${esc(worker.name)} <code class="muted">${esc(worker.id)}</code> <span class="muted small">— ${esc(why)}</span>`
}

const machineLabel = (machine) => {
  const serving = machine.services.length === 0 ? '' : ` <span class="muted small">(${esc(t('services.form.machineServing', { services: machine.services.join(', ') }))})</span>`
  return `${esc(machine.id)}${serving}`
}

const editorFormHtml = () => `<form id="service-form" class="card" novalidate>
  <p id="svc-msg" class="muted" hidden></p>

  <div class="field-row">
    <label class="field">
      <span class="field-label">${esc(t('services.form.label'))}</span>
      <input id="svc-label" class="text-input" maxlength="80" placeholder="${esc(t('services.form.labelHint'))}" />
    </label>
    <label class="field">
      <span class="field-label">${esc(t('services.form.id'))}</span>
      <input id="svc-id" class="text-input mono" maxlength="41" pattern="[a-z0-9][a-z0-9-]{0,40}" placeholder="${esc(t('services.form.idHint'))}" />
    </label>
  </div>

  <label class="field">
    <span class="field-label">${esc(t('services.form.agents'))}</span>
    <span id="svc-agents" class="checks"></span>
    <span class="field-hint muted small">${esc(t('services.form.agentsHint'))}</span>
  </label>

  <div class="field-row">
    <label class="field">
      <span class="field-label">${esc(t('services.form.capacity'))}</span>
      <input id="svc-capacity" class="text-input" type="number" min="1" max="64" value="4" />
    </label>
    <label class="field">
      <span class="field-label">${esc(t('services.form.permission'))}</span>
      <select id="svc-permission" class="text-input pill-select">
        <option value="read">${esc(t('services.form.permission.read'))}</option>
        <option value="write">${esc(t('services.form.permission.write'))}</option>
      </select>
    </label>
  </div>

  <details class="node-advanced">
    <summary>${esc(t('services.form.moreSettings'))}</summary>
    <div class="node-advanced-body">
      <label class="field">
        <span class="field-label">${esc(t('services.form.surfaces'))}</span>
        <span class="checks">
          <label class="checkbox-line"><input id="svc-surface-conversations" type="checkbox" value="conversations" checked /> <span>${esc(t('services.form.surface.conversations'))}</span></label>
          <label class="checkbox-line"><input id="svc-surface-tasks" type="checkbox" value="tasks" /> <span>${esc(t('services.form.surface.tasks'))}</span> <span class="muted small">${esc(t('services.form.surface.tasksNote'))}</span></label>
        </span>
      </label>
      <div class="field-row">
        <label class="field">
          <span class="field-label">${esc(t('services.form.idle'))}</span>
          <input id="svc-idle" class="text-input" type="number" min="1" max="8760" value="24" />
        </label>
        <label class="field">
          <span class="field-label">${esc(t('services.form.maxAgents'))}</span>
          <input id="svc-max-agents" class="text-input" type="number" min="1" max="64" value="4" />
        </label>
      </div>
      <label class="field">
        <span class="field-label">${esc(t('services.form.placement'))}</span>
        <select id="svc-placement" class="text-input pill-select">
          <option value="spread">${esc(t('services.form.placement.spread'))}</option>
          <option value="pack">${esc(t('services.form.placement.pack'))}</option>
          <option value="pin">${esc(t('services.form.placement.pin'))}</option>
        </select>
      </label>
      <div id="svc-machines-wrap" hidden>
        <label class="field">
          <span class="field-label">${esc(t('services.form.machines'))}</span>
          <span id="svc-machines" class="checks"></span>
          <span class="field-hint muted small">${esc(t('services.form.machinesHint'))}</span>
        </label>
      </div>
      <label class="field">
        <span class="field-label">${esc(t('services.form.knowledge'))}</span>
        <span id="svc-knowledge"></span>
      </label>
      <button id="svc-knowledge-add" class="btn-quiet btn-sm" type="button">${esc(t('services.form.knowledgeAdd'))}</button>
      <span class="field-hint muted small">${esc(t('services.form.knowledgeHint'))}</span>
    </div>
  </details>

  <div id="svc-preview-wrap" hidden>
    <h3 class="section-label">${esc(t('services.form.preview'))}</h3>
    <div id="svc-preview-state" class="banner"></div>
    <div id="svc-preview-errors"></div>
    <div id="svc-preview-warnings"></div>
    <div id="svc-preview-diff"></div>
    <!-- The full file is the boring 99%; the diff and the verdict above are the point. Keep the raw
         file available but out of the way for whoever wants to double-check the exact bytes. -->
    <details class="yaml-collapse">
      <summary>${esc(t('services.form.previewFull'))}</summary>
      <pre class="yaml-preview"><code id="svc-preview-yaml"></code></pre>
    </details>
  </div>

  <div class="form-actions">
    <button type="button" id="svc-cancel" class="btn-quiet btn-sm">${esc(t('common.cancel'))}</button>
    <button type="button" id="svc-apply" class="btn btn-sm">${esc(t('services.form.apply'))}</button>
  </div>
</form>`

const renderForm = () => {
  const label = $('svc-label'); if (label !== null) label.value = draft.label
  const id = $('svc-id'); if (id !== null) { id.value = draft.id; id.disabled = editingId !== null }
  const capacity = $('svc-capacity'); if (capacity !== null) capacity.value = String(draft.capacity)
  const idle = $('svc-idle'); if (idle !== null) idle.value = String(draft.sessionIdleHours)
  const maxAgents = $('svc-max-agents'); if (maxAgents !== null) maxAgents.value = String(draft.maxAgentsPerMachine)
  const permission = $('svc-permission'); if (permission !== null) permission.value = draft.permission
  const placement = $('svc-placement'); if (placement !== null) placement.value = draft.placement
  const surfaceConv = $('svc-surface-conversations'); if (surfaceConv !== null) surfaceConv.checked = draft.surfaces.includes('conversations')
  const surfaceTasks = $('svc-surface-tasks'); if (surfaceTasks !== null) surfaceTasks.checked = draft.surfaces.includes('tasks')

  const agents = $('svc-agents')
  if (agents !== null && editorCtx !== null) {
    if (editorCtx.workers.length === 0) {
      agents.innerHTML = `<span class="muted small">${esc(t('services.form.agentsNone'))}</span>`
    } else {
      agents.innerHTML = editorCtx.workers.map((worker) => {
        const picked = draft.workers.includes(worker.id)
        const blocked = worker.blockedReason !== null
        const allowed = picked || !blocked
        return `<label class="checkbox-line">
          <input type="checkbox" data-agent="${esc(worker.id)}" value="${esc(worker.id)}" ${allowed ? '' : 'disabled'} ${picked ? 'checked' : ''} />
          <span>${agentLabel(worker)}</span>
        </label>`
      }).join('')
    }
  }

  const machinesWrap = $('svc-machines-wrap')
  const machines = $('svc-machines')
  if (machinesWrap !== null && machines !== null && editorCtx !== null) {
    machinesWrap.hidden = draft.placement !== 'pin'
    machines.innerHTML = editorCtx.machines.map((machine) => `<label class="checkbox-line">
      <input type="checkbox" data-machine="${esc(machine.id)}" value="${esc(machine.id)}" ${draft.machines.includes(machine.id) ? 'checked' : ''} />
      <span>${machineLabel(machine)}</span>
    </label>`).join('')
  }

  const knowledge = $('svc-knowledge')
  if (knowledge !== null) {
    knowledge.innerHTML = draft.knowledge.map((row, index) => `<span class="form-row">
      <input type="text" data-knowledge="${index}" data-field="host" placeholder="${esc(t('services.form.knowledge.host'))}" value="${esc(row.host)}" />
      <input type="text" data-knowledge="${index}" data-field="mount" placeholder="${esc(t('services.form.knowledge.mount'))}" value="${esc(row.mount)}" />
      <button type="button" class="btn-quiet btn-sm" data-knowledge-remove="${index}">${esc(t('services.form.knowledgeRemove'))}</button>
    </span>`).join('')
  }

  const msg = $('svc-msg'); if (msg !== null) msg.hidden = true
  const previewWrap = $('svc-preview-wrap'); if (previewWrap !== null) previewWrap.hidden = true
  const title = $('service-editor-title')
  if (title !== null) title.textContent = editingId === null ? t('services.editorNew') : t('services.editorEdit', { id: editingId })
}

const resetDraft = () => {
  draft.id = ''
  draft.label = ''
  draft.workers = []
  draft.surfaces = ['conversations']
  draft.permission = 'read'
  draft.sessionIdleHours = 24
  draft.placement = 'spread'
  draft.machines = []
  draft.capacity = 4
  draft.maxAgentsPerMachine = 4
  draft.thresholds = null
  draft.knowledge = []
}

const loadDraft = (serviceId) => {
  const raw = (editorCtx?.services ?? []).find((service) => service.id === serviceId)
  if (raw === undefined) return
  draft.id = raw.id
  draft.label = raw.label
  draft.workers = [...raw.workers]
  draft.surfaces = [...raw.surfaces]
  draft.permission = raw.permission
  draft.sessionIdleHours = raw.session_idle_hours
  draft.placement = raw.placement
  draft.machines = [...raw.machines]
  draft.capacity = raw.capacity.max_sessions_per_agent
  draft.maxAgentsPerMachine = raw.max_agents_per_machine ?? 4
  draft.thresholds = raw.thresholds ?? null
  draft.knowledge = raw.knowledge.map((k) => ({ host: k.host, mount: k.mount }))
}

const renderEditorInto = (slotId) => {
  const slot = $(slotId)
  if (slot !== null) slot.innerHTML = editorFormHtml()
  renderForm()
  schedulePreview()
}

const openEditor = (serviceId = null) => {
  editingId = serviceId
  if (serviceId === null) resetDraft()
  else loadDraft(serviceId)
  renderEditorInto('service-editor-slot')
  const editor = $('service-editor')
  if (editor !== null) editor.hidden = false
}

const closeEditor = () => {
  const editor = $('service-editor')
  if (editor !== null) editor.hidden = true
  editingId = null
}

const currentDraft = () => ({
  id: draft.id,
  label: draft.label,
  workers: [...draft.workers],
  surfaces: [...draft.surfaces],
  permission: draft.permission,
  session_idle_hours: draft.sessionIdleHours,
  placement: draft.placement,
  machines: [...draft.machines],
  max_agents_per_machine: draft.maxAgentsPerMachine,
  ...(draft.thresholds === null ? {} : { thresholds: draft.thresholds }),
  capacity: { max_sessions_per_agent: draft.capacity },
  knowledge: draft.knowledge.map((k) => ({ host: k.host, mount: k.mount, read_only: true })),
})

const schedulePreview = () => {
  if (previewTimer !== null) clearTimeout(previewTimer)
  previewTimer = setTimeout(() => { void runPreview() }, 400)
}

const runPreview = async () => {
  const body = currentDraft()
  if (body.id === '' || body.label === '') {
    const wrap = $('svc-preview-wrap')
    if (wrap !== null) wrap.hidden = true
    return
  }
  const response = await apiJson('/api/config/services/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  renderPreview(response.ok ? response.data : { ok: false, yaml: '', diff: [], errors: [response.detail], warnings: [], resolved: null })
}

const renderPreview = (preview) => {
  const wrap = $('svc-preview-wrap')
  if (wrap !== null) wrap.hidden = false
  const state = $('svc-preview-state')
  if (state !== null) {
    state.className = 'banner'
    state.innerHTML = preview.ok
      ? `<strong>${esc(t('services.form.previewOk'))}</strong>`
      : `<strong>${esc(t('services.form.previewError'))}</strong>`
  }
  const errors = $('svc-preview-errors')
  if (errors !== null) errors.innerHTML = (preview.errors ?? []).map((line) => `<div class="banner warn">${esc(line)}</div>`).join('')
  const warnings = $('svc-preview-warnings')
  if (warnings !== null) warnings.innerHTML = (preview.warnings ?? []).map((line) => `<div class="banner warn">${esc(line)}</div>`).join('')
  const diff = $('svc-preview-diff')
  if (diff !== null) diff.innerHTML = (preview.diff ?? []).map((line) => `<div class="${line.kind === 'add' ? 'diff-add' : 'diff-remove'}">${line.kind === 'add' ? '+' : '-'} ${esc(line.text)}</div>`).join('')
  const yaml = $('svc-preview-yaml')
  if (yaml !== null) yaml.textContent = preview.yaml ?? ''
}

const apply = async () => {
  const applyButton = $('svc-apply')
  if (applyButton !== null) applyButton.disabled = true
  const msg = $('svc-msg')
  if (msg !== null) { msg.hidden = false; msg.textContent = t('services.form.applying') }
  try {
    const response = await apiJson('/api/config/services', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draft: currentDraft(), configHash: editorCtx?.configHash ?? '' }),
    })
    if (!response.ok) {
      if (msg !== null) msg.textContent = `${t('services.form.applyFailed')}: ${response.detail}`
      return
    }
    closeEditor()
    await load()
    // The round trip the key page started ("create a service first"): go back with the new service preselected.
    if (searchParams().get('return') === 'keys') redirect(`/keys?service=${encodeURIComponent(draft.id)}`)
  } finally {
    if (applyButton !== null) applyButton.disabled = false
  }
}

// ---------------------------------------------------------------------------
// Detail view
// ---------------------------------------------------------------------------
const keyRowOfService = (key) => `<div class="node-row">
  <div class="node-main">
    <div class="node-title"><span class="dot ok"></span>${esc(key.name)} <code class="muted">${esc(key.id)}</code>${key.revokedAt === null ? '' : ` <span class="pill-mini muted">${esc(t('services.keyRevoked'))}</span>`}</div>
    <div class="node-sub">${esc(t('services.keyToday'))}: ${key.quotaRunsDay === null ? `${key.usedToday} ${esc(t('keys.runsUnlimitedShort'))}` : `${key.usedToday}/${key.quotaRunsDay}`}</div>
  </div>
  <a class="icon-btn" href="/keys?key=${encodeURIComponent(key.id)}" title="${esc(t('keys.detail'))}" aria-label="${esc(t('keys.detail'))}">
    <svg width="16" height="16" aria-hidden="true"><use href="#i-chev" /></svg>
  </a>
</div>`

const agentRowOfService = (agent) => {
  const dot = agent.online ? 'ok' : 'bad'
  const model = agent.provider === null || agent.model === null
    ? `<span class="muted">${esc(t('services.modelHostDefault'))}</span>`
    : `<code>${esc(agent.provider)}/${esc(agent.model)}</code>`
  return `<div class="node-row">
  <div class="node-main">
    <div class="node-title"><span class="dot ${dot}"></span>${esc(agent.name)} <code class="muted">${esc(agent.id)}</code></div>
    <div class="node-sub">${agent.sessions}/${agent.maxSessions} ${esc(t('services.sessionsShort'))} · ${agent.queueDepth} ${esc(t('services.queued'))} · ${model} · ${esc(agent.machine)}</div>
  </div>
</div>`
}

const renderDetail = (service) => {
  const draftRaw = (editorCtx?.services ?? []).find((s) => s.id === service.id)
  const title = $('service-detail-title')
  if (title !== null) title.innerHTML = `${esc(service.label)} <code class="muted">${esc(service.id)}</code>`

  const issueKey = $('service-detail-key')
  if (issueKey !== null) issueKey.setAttribute('href', `/keys?service=${encodeURIComponent(service.id)}`)

  const machines = service.machines.length === 0 ? '—' : service.machines.map((m) => `<code>${esc(m)}</code>`).join(', ')
  const knowledge = (draftRaw?.knowledge ?? []).length === 0
    ? '—'
    : (draftRaw?.knowledge ?? []).map((k) => `<code>${esc(k.host)} → ${esc(k.mount)} (ro)</code>`).join(', ')

  const body = $('service-detail-body')
  if (body !== null) {
    body.innerHTML = `
    <section class="section">
      <div class="section-head"><h2>${esc(t('services.overview'))}</h2></div>
      <div class="card dl">
        <div class="dl-row"><span class="dl-label">${esc(t('services.capacity'))}</span><span class="dl-value">${capacityLine(service)}</span></div>
        <div class="dl-row"><span class="dl-label">${esc(t('services.form.permission'))}</span><span class="dl-value"><code>${esc(service.permission)}</code> ${service.permission === 'read' ? `<span class="muted small">${esc(t('services.form.permission.read'))}</span>` : `<span class="muted small">${esc(t('services.form.permission.write'))}</span>`}</span></div>
        <div class="dl-row"><span class="dl-label">${esc(t('services.idleShort'))}</span><span class="dl-value">${service.sessionIdleHours}h</span></div>
        <div class="dl-row"><span class="dl-label">${esc(t('services.form.placement'))}</span><span class="dl-value"><code>${esc(service.placement)}</code></span></div>
        <div class="dl-row"><span class="dl-label">${esc(t('services.form.machines'))}</span><span class="dl-value">${machines}</span></div>
        <div class="dl-row"><span class="dl-label">${esc(t('services.form.knowledge'))}</span><span class="dl-value">${knowledge}</span></div>
      </div>
    </section>
    <section class="section">
      <div class="section-head"><h2>${esc(t('services.agents'))}</h2><span class="muted small">${String(service.agents.length)}</span></div>
      <div class="card"><div class="nodes-list">${service.agents.map(agentRowOfService).join('')}</div></div>
    </section>
    <section class="section">
      <div class="section-head"><h2>${esc(t('services.keysServing'))}</h2><span class="muted small">${String(service.keys.length)}</span></div>
      <div class="card"><div class="nodes-list">${service.keys.length === 0 ? `<p class="muted small">${esc(t('services.noKeys'))}</p>` : service.keys.map(keyRowOfService).join('')}</div></div>
    </section>`
  }
}

const openDetail = (id) => {
  const service = (snapshot.services ?? []).find((s) => s.id === id)
  if (service === undefined) return
  detailId = id
  renderDetail(service)
  showView('detail')
}

const openEdit = (id) => {
  editingId = id
  loadDraft(id)
  renderEditorInto('edit-form-slot')
  showView('form')
}

const deleteService = async (id, label) => {
  if (!window.confirm(t('services.deleteConfirm', { label }))) return
  const response = await apiJson(`/api/config/services/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!response.ok) return
  detailId = null
  showView('list')
  await load()
}

// ---------------------------------------------------------------------------
// Loading + wiring
// ---------------------------------------------------------------------------
const load = async () => {
  const snapshotResponse = await apiJson('/api/services')
  if (snapshotResponse.ok) snapshot = snapshotResponse.data ?? snapshot

  const ctxResponse = await apiJson('/api/config/services')
  if (ctxResponse.ok) editorCtx = ctxResponse.data

  if (view === 'list') renderList()
  if (view === 'detail' && detailId !== null) {
    const service = (snapshot.services ?? []).find((s) => s.id === detailId)
    if (service !== undefined) renderDetail(service)
  }
  // The keys page's "create a service first" lands here with ?create=1.
  if (!openedFromParam && searchParams().get('create') === '1') {
    openedFromParam = true
    openEditor()
  }
  // Deep link: ?service=<id> opens the detail.
  if (view === 'list' && searchParams().get('service') !== null) {
    const id = searchParams().get('service')
    if (id !== null && id !== '') openDetail(id)
  }
}

document.addEventListener('click', (event) => {
  // Same two lessons as the keys page: SVG icons are Elements, not HTMLElements, and the
  // actionable data-* attribute lives on the button while the click lands on its inner <span> --
  // every branch resolves via closest() so the deepest element still finds its action.
  const target = event.target
  if (!(target instanceof Element)) return
  const trace = globalThis.__DAC_TRACE__ === true

  const closeBtn = target.closest('[data-close]')
  if (closeBtn !== null) {
    closeEditor()
    if (view === 'form') showView('detail')
    return
  }

  const trigger = target.closest('.menu-trigger')
  if (trigger !== null) {
    const serviceId = trigger.id.replace('service-more-', '')
    const service = (snapshot.services ?? []).find((s) => s.id === serviceId)
    if (trace) console.debug('[services:menu]', serviceId, 'service-found:', service !== undefined)
    if (service !== undefined) openMenu(service, trigger)
    return
  }
  if (target.closest('.menu-panel') === null) closeMenu()

  const detail = target.closest('[data-service-detail]')
  if (detail !== null) { closeMenu(); if (trace) console.debug('[services:menu] detail', detail.dataset.serviceDetail); openDetail(detail.dataset.serviceDetail ?? ''); return }
  const edit = target.closest('[data-service-edit]')
  if (edit !== null) { closeMenu(); if (trace) console.debug('[services:menu] edit', edit.dataset.serviceEdit); openEdit(edit.dataset.serviceEdit ?? ''); return }
  const issueKey = target.closest('[data-service-key]')
  if (issueKey !== null) { closeMenu(); if (trace) console.debug('[services:menu] key', issueKey.dataset.serviceKey); redirect(`/keys?service=${encodeURIComponent(issueKey.dataset.serviceKey ?? '')}`); return }
  const del = target.closest('[data-service-delete]')
  if (del !== null) { closeMenu(); if (trace) console.debug('[services:menu] delete', del.dataset.serviceDelete); void deleteService(del.dataset.serviceDelete ?? '', del.dataset.serviceDeleteName ?? del.dataset.serviceDelete ?? ''); return }

  if (target.id === 'new-service') { openEditor(); return }
  if (target.id === 'back-list') { detailId = null; showView('list'); return }
  if (target.id === 'back-detail') { showView('detail'); return }
  if (target.id === 'service-detail-edit' && detailId !== null) { openEdit(detailId); return }
  if (target.id === 'service-detail-delete' && detailId !== null) {
    const service = (snapshot.services ?? []).find((s) => s.id === detailId)
    void deleteService(detailId, service?.label ?? detailId)
    return
  }
  if (target.id === 'svc-cancel') {
    if (view === 'form') showView('detail')
    else closeEditor()
    return
  }
  if (target.id === 'svc-apply') { void apply(); return }
  if (target.id === 'svc-knowledge-add') {
    draft.knowledge.push({ host: '', mount: '/knowledge' })
    renderForm()
    return
  }

  const agent = target.closest('[data-agent]')
  if (agent !== null && agent instanceof HTMLInputElement) {
    if (agent.checked && !draft.workers.includes(agent.dataset.agent ?? '')) draft.workers.push(agent.dataset.agent ?? '')
    if (!agent.checked) draft.workers = draft.workers.filter((id) => id !== agent.dataset.agent)
    schedulePreview()
    return
  }
  const machine = target.closest('[data-machine]')
  if (machine !== null && machine instanceof HTMLInputElement) {
    if (machine.checked && !draft.machines.includes(machine.dataset.machine ?? '')) draft.machines.push(machine.dataset.machine ?? '')
    if (!machine.checked) draft.machines = draft.machines.filter((id) => id !== machine.dataset.machine)
    schedulePreview()
    return
  }
  const removeIndex = target.closest('[data-knowledge-remove]')
  if (removeIndex !== null) {
    draft.knowledge = draft.knowledge.filter((_row, index) => index !== Number(removeIndex.dataset.knowledgeRemove))
    renderForm()
    schedulePreview()
  }
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeMenu()
})

document.addEventListener('input', (event) => {
  const target = event.target
  if (!(target instanceof HTMLInputElement)) return
  const knowledgeHost = target.dataset.knowledge
  if (knowledgeHost !== undefined && target.dataset.field !== undefined) {
    const row = draft.knowledge[Number(knowledgeHost)]
    if (row !== undefined) row[target.dataset.field === 'host' ? 'host' : 'mount'] = target.value
    schedulePreview()
    return
  }
  switch (target.id) {
    case 'svc-label': draft.label = target.value; break
    case 'svc-id': draft.id = target.value.trim().toLowerCase(); break
    case 'svc-capacity': draft.capacity = Number(target.value) || 4; break
    case 'svc-idle': draft.sessionIdleHours = Number(target.value) || 24; break
    case 'svc-max-agents': draft.maxAgentsPerMachine = Number(target.value) || 4; break
    default: return
  }
  schedulePreview()
})

document.addEventListener('change', (event) => {
  const target = event.target
  if (!(target instanceof HTMLSelectElement || target instanceof HTMLInputElement)) return
  if (target.id === 'svc-permission') { draft.permission = target.value; schedulePreview(); return }
  if (target.id === 'svc-placement') {
    draft.placement = target.value
    if (draft.placement !== 'pin') draft.machines = []
    renderForm()
    schedulePreview()
    return
  }
  if (target.id === 'svc-surface-conversations' || target.id === 'svc-surface-tasks') {
    const surface = target.id === 'svc-surface-conversations' ? 'conversations' : 'tasks'
    if (target.checked && !draft.surfaces.includes(surface)) draft.surfaces.push(surface)
    if (!target.checked) draft.surfaces = draft.surfaces.filter((s) => s !== surface)
    schedulePreview()
  }
})

await load()
poll(load, 15_000)

// Test surface: the smoke test drives the real functions through this hook
// (never present in production -- it is created only when the test flags it).
if (globalThis.__DAC_TEST__ === true) {
  globalThis.__DAC_SERVICES_TEST__ = {
    load,
    openEditor,
    openDetail,
    openEdit,
    apply,
    runPreview,
    deleteService,
    currentDraft,
    setDraft: (patch) => { Object.assign(draft, patch) },
    view: () => view,
    lastRedirect: () => lastRedirect,
    snapshot: () => snapshot,
  }
}
