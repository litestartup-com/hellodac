// Outward service overview (admin side, authenticated by session cookie).
//
// The operator's question this page answers is "is the outward promise being kept": how many agents a
// service declares, how many are actually reachable, how much of the promised concurrency is in use,
// what is queued behind it, and how much of today's quota the keys serving it have burned.
//
// Read-only by design (user, 2026-09-28): adding or removing an agent needs "provision an agent from
// the declaration", which does not exist yet -- a service's `count` must still equal the number of
// listed workers. The page therefore shows the declaration next to the truth and points at the config
// instead of offering a button that cannot do what it says.
//
// Data contract (the 2026-09-27 incident): `apiJson` resolves to `{ok, status, data}` (or
// `{ok:false, error, detail}` on failure), **not a Response** -- calling `.json()` on it leaves the
// page stuck at "Loading…". services-page.test.mjs is the runtime guard for this.
import { $, esc, setHtml, apiJson, poll, t, loadI18n } from './ui.js'

await loadI18n()

const pill = (text, cls) => `<span class="pill-mini${cls === undefined ? '' : ` ${cls}`}">${esc(text)}</span>`

/** The service's headline numbers: declared vs reachable agents, concurrency in use, queue. */
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

const agentRow = (agent) => {
  const state = agent.online ? pill(t('services.online')) : pill(t('services.offline'), 'muted')
  // Sessions against this agent's own ceiling, spelled out: "3 of 4" is what tells an operator
  // whether one more customer fits.
  const load = `${agent.sessions}/${agent.maxSessions}`
  const model = agent.provider === null || agent.model === null
    ? `<span class="muted">${esc(t('services.modelHostDefault'))}</span>`
    : `<code>${esc(agent.provider)}/${esc(agent.model)}</code>`
  return `<div class="node-row">
    <div class="node-main">
      <div class="node-title">${esc(agent.name)} ${state} <code class="muted">${esc(agent.id)}</code></div>
      <div class="node-detail">${esc(t('services.sessions'))}: <strong>${esc(load)}</strong>
        · ${esc(t('services.queue'))}: ${agent.queueDepth}
        · ${model}
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

const serviceCard = (service) => {
  const surfaces = service.surfaces.map((surface) => esc(t(`services.surface.${surface}`))).join(', ')
  const agents = service.agents.map(agentRow).join('')
  const keys = service.keys.length === 0
    ? `<p class="muted small">${esc(t('services.noKeys'))}</p>`
    : service.keys.map(keyRow).join('')
  const knowledge = service.knowledge.length === 0
    ? ''
    : `<div class="node-meta">${esc(t('services.knowledge'))}: ${service.knowledge.map((k) => `<code>${esc(k.host)}${k.readOnly ? ' (ro)' : ''}</code>`).join(', ')}</div>`
  return `<section class="section">
    <div class="section-head">
      <h2>${esc(service.label)} <code class="muted">${esc(service.id)}</code></h2>
      <span class="muted small">${surfaces} · ${esc(t('services.idleReclaim', { hours: service.sessionIdleHours }))}</span>
    </div>
    <div class="card">
      ${capacityLine(service)}
      <div class="node-meta">${esc(t('services.placement'))}: <code>${esc(service.placement)}</code>
        · ${esc(t('services.permission'))}: <code>${esc(service.permission)}</code>
        · ${esc(t('services.declaredCount', { n: service.declaredCount }))}
        ${service.machines.length === 0 ? '' : ` · ${esc(t('services.machines'))}: ${service.machines.map((m) => `<code>${esc(m)}</code>`).join(', ')}`}</div>
      ${knowledge}
    </div>
    <h3 class="muted small">${esc(t('services.agents'))}</h3>
    <div class="nodes-list">${agents}</div>
    <h3 class="muted small">${esc(t('services.keysServing'))}</h3>
    <div class="nodes-list">${keys}</div>
  </section>`
}

const load = async () => {
  const response = await apiJson('/api/services')
  const list = $('services-list')
  if (list === null) return
  if (!response.ok) {
    // A failed read must say so instead of leaving the previous numbers on screen looking current.
    setHtml('services-list', `<p class="muted small">${esc(t('services.readFailed'))}</p>`)
    return
  }
  const services = response.data?.services ?? []
  const note = $('services-note')
  if (note !== null && services.length === 0) note.textContent = t('services.empty')
  if (services.length === 0) {
    setHtml('services-list', `<p class="muted small">${esc(t('services.empty'))}</p>`)
    return
  }
  // A service with no live key is configured but unreachable for everybody: that is worth saying,
  // because "the API answers 401 on every call" reads like a bug rather than like missing setup.
  const anyKey = response.data?.keysExist === true
  const html = services.map(serviceCard).join('')
  setHtml('services-list', anyKey ? html : `${html}<p class="muted small">${esc(t('services.noKeysAnywhere'))}</p>`)
  const refreshed = $('services-refresh')
  if (refreshed !== null) refreshed.textContent = new Date().toLocaleTimeString()
}

await load()
poll(load, 15_000)
