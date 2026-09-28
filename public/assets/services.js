// Outward service overview + the declaration editor (admin side, session cookie).
//
// Two truths live on this page and they are different things:
//   - the snapshot (`GET /api/services`): what is running right now -- agents online, capacity in
//     use, queue, keys;
//   - the declaration (`GET/POST /api/config/services`): what the config file says should exist.
// The page's whole job is making the second one editable without SSH: the editor previews the exact
// YAML that would be written, asks the real loader whether it would boot, and only then writes.
//
// The editor is deliberately "single form + live verdict", not a multi-step wizard: every field of a
// service declaration fits on one form, and the live preview IS the explanation of each field.
//
// Data contract (the 2026-09-27 incident): `apiJson` resolves to `{ok, status, data}`, not a
// `Response`. services-page.test.mjs is the runtime guard.
import { $, esc, setHtml, apiJson, poll, t, loadI18n } from './ui.js'

await loadI18n()

// ---------------------------------------------------------------------------
// Editor state. The form fields are a projection of this; the DOM updates it on
// change, and the preview/apply read it. One object so the test hook can drive
// the real functions instead of a DOM.
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
  knowledge: [], // { host, mount }
}

let editorCtx = null // { configHash, services, workers, machines }
let editingId = null // null = creating; else the service id being edited
let previewTimer = null
let snapshot = { services: [], keysExist: false }

const editorOpen = () => !($('editor')?.hidden ?? true)

// ---------------------------------------------------------------------------
// The snapshot: what is running (the operational truth, unchanged from before)
// ---------------------------------------------------------------------------
const pill = (text, cls) => `<span class="pill-mini${cls === undefined ? '' : ` ${cls}`}">${esc(text)}</span>`

const agentRow = (agent) => {
  const state = agent.online ? pill(t('services.online')) : pill(t('services.offline'), 'muted')
  const model = agent.provider === null || agent.model === null
    ? `<span class="muted">${esc(t('services.modelHostDefault'))}</span>`
    : `<code>${esc(agent.provider)}/${esc(agent.model)}</code>`
  return `<div class="node-row">
    <div class="node-main">
      <div class="node-title">${esc(agent.name)} ${state} <code class="muted">${esc(agent.id)}</code></div>
      <div class="node-detail">${esc(t('services.sessions'))}: <strong>${agent.sessions}/${agent.maxSessions}</strong>
        · ${esc(t('services.queue'))}: ${agent.queueDepth} · ${model}
        · ${agent.sandboxMode === null ? esc(t('services.permissionUndeclared')) : `<code>${esc(agent.sandboxMode)}</code>`}</div>
      <div class="node-meta">${esc(agent.endpoint)} · ${esc(agent.machine)}</div>
    </div>
  </div>`
}

const keyRow = (key) => {
  const quota = key.quotaRunsDay === null
    ? `${key.usedToday} ${esc(t('services.perDayUnlimited'))}`
    : `${key.usedToday} ${esc(t('services.perDay', { n: key.quotaRunsDay }))}`
  const state = key.revokedAt === null ? '' : ` ${pill(t('services.keyRevoked'), 'muted')}`
  return `<div class="node-row">
    <div class="node-main">
      <div class="node-title">${esc(key.name)}${state} <code class="muted">${esc(key.id)}</code></div>
      <div class="node-meta">${esc(t('services.keyToday'))}: <strong>${quota}</strong>
        · ${esc(t('services.keyInFlight'))}: ${key.active}/${key.maxConcurrency}</div>
    </div>
  </div>`
}

const capacityLine = (service) => {
  const capacity = service.capacity
  const allOnline = capacity.onlineAgents >= capacity.declaredAgents
  return `<div class="node-meta">
    ${esc(t('services.capacity'))}:
    <strong>${capacity.onlineAgents}/${capacity.declaredAgents}</strong> ${esc(t('services.agentsOnline'))}
    · <strong>${capacity.inUse}/${capacity.maxConcurrent}</strong> ${esc(t('services.inUse'))}
    ${allOnline ? '' : ` · <span class="warn">${esc(t('services.reachable', { n: capacity.onlineMaxConcurrent }))}</span>`}
    · ${capacity.queued} ${esc(t('services.queued'))}
  </div>`
}

const renderSnapshot = () => {
  const list = $('services-list')
  if (list === null) return
  const services = snapshot.services ?? []

  const newButton = $('service-new')
  if (newButton !== null) newButton.hidden = editorOpen()

  if (services.length === 0) {
    setHtml('services-list', `<div class="card"><p class="muted small">${esc(t('services.empty'))}</p></div>`)
    if (newButton !== null) newButton.hidden = false
    return
  }

  const anyKey = snapshot.keysExist === true
  const html = services.map((service) => `<section class="section">
    <div class="section-head">
      <h2>${esc(service.label)} <code class="muted">${esc(service.id)}</code></h2>
      <span class="muted small">${service.surfaces.map((s) => esc(t(`services.surface.${s}`))).join(', ')} · ${esc(t('services.idleReclaim', { hours: service.sessionIdleHours }))}</span>
      <button class="btn ghost" type="button" data-edit="${esc(service.id)}">${esc(t('services.edit'))}</button>
    </div>
    <div class="card">
      ${capacityLine(service)}
      <div class="node-meta">${esc(t('services.placement'))}: <code>${esc(service.placement)}</code>
        · ${esc(t('services.permission'))}: <code>${esc(service.permission)}</code>
        · ${esc(t('services.declaredCount', { n: service.declaredCount }))}</div>
    </div>
    <div class="nodes-list">${service.agents.map(agentRow).join('')}</div>
    <h3 class="muted small">${esc(t('services.keysServing'))}</h3>
    <div class="nodes-list">${service.keys.length === 0 ? `<p class="muted small">${esc(t('services.noKeys'))}</p>` : service.keys.map(keyRow).join('')}</div>
  </section>`).join('')
  setHtml('services-list', anyKey ? html : `${html}<p class="muted small">${esc(t('services.noKeysAnywhere'))}</p>`)
  const refreshed = $('services-refresh')
  if (refreshed !== null) refreshed.textContent = new Date().toLocaleTimeString()
}

// ---------------------------------------------------------------------------
// The declaration editor
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

const renderKnowledgeRows = () => {
  const wrap = $('svc-knowledge')
  if (wrap === null) return
  wrap.innerHTML = draft.knowledge.map((row, index) => `<div class="form-row">
    <input type="text" data-knowledge="${index}" data-field="host" placeholder="${esc(t('services.form.knowledge.host'))}" value="${esc(row.host)}" />
    <input type="text" data-knowledge="${index}" data-field="mount" placeholder="${esc(t('services.form.knowledge.mount'))}" value="${esc(row.mount)}" />
    <button type="button" class="btn ghost" data-knowledge-remove="${index}">${esc(t('services.form.knowledgeRemove'))}</button>
  </div>`).join('')
}

const renderForm = () => {
  const label = $('svc-label'); if (label !== null) label.value = draft.label
  const id = $('svc-id'); if (id !== null) { id.value = draft.id; id.disabled = editingId !== null }
  const capacity = $('svc-capacity'); if (capacity !== null) capacity.value = String(draft.capacity)
  const idle = $('svc-idle'); if (idle !== null) idle.value = String(draft.sessionIdleHours)
  const permission = $('svc-permission'); if (permission !== null) permission.value = draft.permission
  const placement = $('svc-placement'); if (placement !== null) placement.value = draft.placement
  const surfaceConv = $('svc-surface-conversations'); if (surfaceConv !== null) surfaceConv.checked = draft.surfaces.includes('conversations')
  const surfaceTasks = $('svc-surface-tasks'); if (surfaceTasks !== null) surfaceTasks.checked = draft.surfaces.includes('tasks')

  const agents = $('svc-agents')
  if (agents !== null && editorCtx !== null) {
    if (editorCtx.workers.length === 0) {
      agents.innerHTML = `<p class="muted small">${esc(t('services.form.agentsNone'))}</p>`
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

  renderKnowledgeRows()
  const title = $('editor-title')
  if (title !== null) title.textContent = editingId === null ? t('services.editorNew') : t('services.editorEdit', { id: editingId })
  const msg = $('svc-msg')
  if (msg !== null) msg.textContent = ''
  const state = $('svc-preview-state')
  if (state !== null) state.innerHTML = ''
  const previewWrap = $('svc-preview-wrap')
  if (previewWrap !== null) previewWrap.hidden = true
}

const openEditor = (serviceId = null) => {
  editingId = serviceId
  if (serviceId !== null && editorCtx !== null) {
    const raw = editorCtx.services.find((service) => service.id === serviceId)
    if (raw !== undefined) {
      draft.id = raw.id
      draft.label = raw.label
      draft.workers = [...raw.workers]
      draft.surfaces = [...raw.surfaces]
      draft.permission = raw.permission
      draft.sessionIdleHours = raw.session_idle_hours
      draft.placement = raw.placement
      draft.machines = [...raw.machines]
      draft.capacity = raw.capacity.max_sessions_per_agent
      draft.knowledge = raw.knowledge.map((k) => ({ host: k.host, mount: k.mount }))
    }
  } else {
    draft.id = ''
    draft.label = ''
    draft.workers = []
    draft.surfaces = ['conversations']
    draft.permission = 'read'
    draft.sessionIdleHours = 24
    draft.placement = 'spread'
    draft.machines = []
    draft.capacity = 4
    draft.knowledge = []
  }
  const editor = $('editor')
  if (editor !== null) editor.hidden = false
  const newButton = $('service-new')
  if (newButton !== null) newButton.hidden = true
  renderForm()
  schedulePreview()
}

const closeEditor = () => {
  const editor = $('editor')
  if (editor !== null) editor.hidden = true
  const newButton = $('service-new')
  if (newButton !== null) newButton.hidden = false
  editingId = null
}

/** Gather the draft the form currently shows (the values live in `draft`; the form is its projection). */
const currentDraft = () => ({
  id: draft.id,
  label: draft.label,
  workers: [...draft.workers],
  surfaces: [...draft.surfaces],
  permission: draft.permission,
  session_idle_hours: draft.sessionIdleHours,
  placement: draft.placement,
  machines: [...draft.machines],
  capacity: { max_sessions_per_agent: draft.capacity },
  knowledge: draft.knowledge.map((k) => ({ host: k.host, mount: k.mount, read_only: true })),
})

/** The preview lives on the server (it runs the real loader), so "live" means debounced, not local. */
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
  if (errors !== null) {
    errors.innerHTML = (preview.errors ?? []).map((line) => `<div class="banner warn">${esc(line)}</div>`).join('')
  }

  const warnings = $('svc-preview-warnings')
  if (warnings !== null) {
    warnings.innerHTML = (preview.warnings ?? []).map((line) => `<div class="banner warn">${esc(line)}</div>`).join('')
  }

  const diff = $('svc-preview-diff')
  if (diff !== null) {
    diff.innerHTML = (preview.diff ?? []).map((line) => `<div class="${line.kind === 'add' ? 'diff-add' : 'diff-remove'}">${line.kind === 'add' ? '+' : '-'} ${esc(line.text)}</div>`).join('')
  }

  const yaml = $('svc-preview-yaml')
  if (yaml !== null) yaml.textContent = preview.yaml ?? ''
}

const apply = async () => {
  const applyButton = $('svc-apply')
  if (applyButton !== null) applyButton.disabled = true
  const msg = $('svc-msg')
  if (msg !== null) msg.textContent = t('services.form.applying')
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
    if (msg !== null) msg.textContent = t('services.form.applied')
    closeEditor()
    await load()
  } finally {
    if (applyButton !== null) applyButton.disabled = false
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
const load = async () => {
  const snapshotResponse = await apiJson('/api/services')
  if (snapshotResponse.ok) snapshot = snapshotResponse.data ?? snapshot

  const ctxResponse = await apiJson('/api/config/services')
  if (ctxResponse.ok) editorCtx = ctxResponse.data

  renderSnapshot()
  // A poll must never clobber a form someone is filling in.
  if (editorOpen() && editingId !== null && editorCtx !== null) {
    const stillThere = editorCtx.services.some((service) => service.id === editingId)
    if (stillThere) renderForm()
  }
}

document.addEventListener('click', (event) => {
  const target = event.target
  if (!(target instanceof HTMLElement)) return
  const editId = target.dataset.edit
  if (editId !== undefined) {
    openEditor(editId)
    return
  }
  if (target.id === 'service-new') openEditor()
  if (target.id === 'svc-cancel') closeEditor()
  if (target.id === 'svc-apply') { void apply(); return }

  const agent = target.dataset.agent
  if (agent !== undefined && target instanceof HTMLInputElement) {
    if (target.checked && !draft.workers.includes(agent)) draft.workers.push(agent)
    if (!target.checked) draft.workers = draft.workers.filter((id) => id !== agent)
    schedulePreview()
    return
  }
  const machine = target.dataset.machine
  if (machine !== undefined && target instanceof HTMLInputElement) {
    if (target.checked && !draft.machines.includes(machine)) draft.machines.push(machine)
    if (!target.checked) draft.machines = draft.machines.filter((id) => id !== machine)
    schedulePreview()
    return
  }
  const removeIndex = target.dataset.knowledgeRemove
  if (removeIndex !== undefined) {
    draft.knowledge = draft.knowledge.filter((_row, index) => index !== Number(removeIndex))
    renderKnowledgeRows()
    schedulePreview()
    return
  }
  if (target.id === 'svc-knowledge-add') {
    draft.knowledge.push({ host: '', mount: '/knowledge' })
    renderKnowledgeRows()
  }
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

// ---------------------------------------------------------------------------
// Test surface: the smoke test drives the real functions through this hook
// (never present in production -- it is created only when the test flags it).
// ---------------------------------------------------------------------------
if (globalThis.__DAC_TEST__ === true) {
  globalThis.__DAC_SERVICES_TEST__ = {
    openEditor,
    apply,
    runPreview,
    currentDraft,
    snapshot: () => snapshot,
    setDraft: (patch) => { Object.assign(draft, patch) },
  }
}
