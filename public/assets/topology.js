// @ts-check
// Cluster topology (UI wrap-up C): a static three-column view of manager -> machines -> nodes (DSH), built
// purely in the frontend from /api/nodes + /api/agents, with no new API and no dependencies. The machine
// column is the node-agent registered remote machines plus a "local (manager host)" pseudo card (C-P1.5:
// the local host does not go through a node-agent and manages its nodes directly, so its edges start from
// the local card). Card assembly and edge pairing are pure functions (unit-testable in topology.test.mjs);
// the SVG connectors are only drawn in a browser from measured rectangles (drawTopoEdges, a DOM function).
import { esc, platformLabel, t, loadI18n } from './ui.js'

await loadI18n()
import { machineMetricBits } from './machines.js'

/** Node form tag: host dispatch -> remote agent; an image -> container worker; otherwise follow the managed flag. */
export const formTag = (n) => {
  if (typeof n.host === 'string' && n.host !== '') return t('topology.form.agentRemote')
  if (typeof n.image === 'string' && n.image !== '') return t('nodes.local.deployDocker')
  return n.managed === true ? t('nodes.local.deployProcess') : t('nodes.external')
}

/** Machine liveness drives the edge style: online is a solid green line, offline a dashed red one (revoked also uses dashes). */
export const machineAlive = (m) => m.online === true && m.revoked !== true

/** Pseudo machine id of the local (manager host) card in the topology; it cannot collide with agent-* registered ids. */
export const LOCAL_MACHINE_ID = 'local'

// The platform name mapping moved to ui.js (the machine list's local row and the topology's local card share
// it); it is re-exported here so the existing imports in topology.test.mjs keep working.
export { platformLabel } from './ui.js'

/**
 * Local card (C-P1.5): the manager host is not a node-agent registered machine (the machine directory means
 * managed remote hosts), yet the topology draws it as the first card of the machine column and the local
 * nodes' edges start from it, which matches the fact that the manager manages this host directly. No metrics
 * badge: local metrics do not arrive through an agent.
 * @param {{ os: string, arch: string, containerForm: boolean, nodeCount: number }} m
 * @returns {string}
 */
export const localMachineCardHtml = (m) => {
  const deploy = m.containerForm ? t('nodes.local.deployDocker') : t('nodes.local.deployProcess')
  return `<div class="topo-item" data-topo-machine="${LOCAL_MACHINE_ID}" title="${esc(t('topology.local.title'))}">
    <div class="topo-item-head">
      <span class="dot ok"></span><strong>${esc(t('nodes.local.row'))}</strong>
      <span class="pill-mini">${esc(deploy)}</span>
    </div>
    <div class="topo-item-line muted small">${esc(platformLabel(m.os))}/${esc(m.arch)} · ${esc(t('nodes.local.direct'))} ${m.nodeCount}</div>
  </div>`
}

/**
 * Manager card: version + listening surface + deployment form + machine/node counts.
 * @param {{ managerVersion: string, origin: string, containerForm: boolean, machineCount: number, nodeCount: number }} m
 * @returns {string}
 */
export const managerCardHtml = (m) => {
  const deploy = m.containerForm ? t('topology.manager.deployContainer') : t('topology.manager.deployBare')
  return `<div class="topo-item topo-manager-card" data-topo-manager>
    <div class="topo-item-head">
      <span class="dot ok"></span><strong>manager</strong>
      <span class="pill-mini">${esc(deploy)}</span>
    </div>
    <div class="topo-item-line muted small">v${esc(m.managerVersion)}</div>
    <div class="topo-item-line muted small">${esc(t('topology.manager.listen', { origin: m.origin }))}</div>
    <div class="topo-item-line muted small">${esc(t('topology.manager.counts', { machines: m.machineCount, nodes: m.nodeCount }))}</div>
  </div>`
}

/**
 * Machine card: online dot + hostname + metrics badge + update badge; offline and revoked machines go into the collapsed section.
 * @param {{ id: string, hostname: string, os: string, arch: string, nodeVersion: string, online: boolean, revoked: boolean, pendingCommands: number, agentVersion?: string | null, managerVersion?: string, latestMetric?: unknown }} m
 * @param {string} managerVersion
 * @returns {string}
 */
export const machineCardHtml = (m, managerVersion) => {
  const alive = machineAlive(m)
  const stale = typeof m.agentVersion === 'string' && m.agentVersion !== '' && typeof m.managerVersion === 'string' && m.agentVersion !== m.managerVersion
  const metrics = machineMetricBits(m.latestMetric)
  const meta = [m.os, m.arch, `node ${m.nodeVersion}`].filter((v) => typeof v === 'string' && v !== '').join(' · ')
  return `<div class="topo-item ${alive ? '' : 'topo-item-off'}" data-topo-machine="${esc(m.id)}" title="${esc(t('topology.jump.machine'))}">
    <div class="topo-item-head">
      <span class="dot ${m.revoked ? 'muted' : alive ? 'ok' : 'err'}"></span><strong>${esc(m.hostname)}</strong>
      ${stale ? `<span class="badge warn">${esc(t('machines.stale'))}</span>` : ''}
      ${m.revoked ? `<span class="pill-mini muted">${esc(t('machines.revoked'))}</span>` : ''}
    </div>
    <div class="topo-item-line muted small">${esc(meta)}${typeof m.agentVersion === 'string' && m.agentVersion !== '' ? ` · agent v${esc(m.agentVersion)}` : ''}</div>
    ${metrics.length > 0 ? `<div class="topo-item-line muted small">${metrics.map(esc).join(' · ')}</div>` : ''}
  </div>`
}

/**
 * Node card: status dot + workspace + DSH version + form tag; drift and version warnings follow the same wording as the list.
 * @param {{ id: string, state: string, agents?: string[], dshVersion?: string | null, configuredDshVersion?: string | null, dshDrift?: boolean, dshCompatible?: boolean, host?: string | null, image?: string | null, managed: boolean }} n
 * @param {Map<string, string>} hostnameById machine id -> hostname
 * @returns {string}
 */
export const nodeCardHtml = (n, hostnameById) => {
  const NODE_DOT = { live: 'ok', cold: 'muted', starting: 'warn', restarting: 'warn', offline: 'bad' }
  const agents = Array.isArray(n.agents) && n.agents.length > 0 ? n.agents.join(' / ') : '—'
  const versionWarn =
    typeof n.dshVersion === 'string' && n.dshVersion !== '' && n.dshCompatible === false
      ? `<span class="pill-mini warn" title="${esc(t('nodes.versionWarnTitle', { version: n.dshVersion }))}">${esc(t('nodes.versionWarn'))}</span>`
      : ''
  const driftWarn = n.dshDrift === true ? `<span class="pill-mini warn" title="${esc(t('nodes.driftWarnTitle'))}">${esc(t('nodes.driftWarn'))}</span>` : ''
  const bits = []
  if (typeof n.image === 'string' && n.image !== '') bits.push(esc(n.image))
  if (typeof n.dshVersion === 'string' && n.dshVersion !== '') bits.push(`DSH ${esc(n.dshVersion)}`)
  if (typeof n.configuredDshVersion === 'string' && n.configuredDshVersion !== '') bits.push(esc(t('nodes.pinned', { version: n.configuredDshVersion })))
  const hostBit = typeof n.host === 'string' && n.host !== '' ? ` · ${esc(t('nodes.hostBit', { host: hostnameById.get(n.host) ?? n.host }))}` : ''
  return `<div class="topo-item" data-topo-node="${esc(n.id)}" title="${esc(t('topology.jump.node'))}">
    <div class="topo-item-head">
      <span class="dot ${NODE_DOT[n.state] ?? 'muted'}"></span><strong>${esc(n.id)}</strong>
      <span class="pill-mini">${esc(formTag(n))}</span> ${versionWarn} ${driftWarn}
    </div>
    <div class="topo-item-line muted small">${esc(t('topology.node.workspace', { agents }))}</div>
    ${bits.length > 0 ? `<div class="topo-item-line muted small">${bits.join(' · ')}${hostBit}</div>` : ''}
  </div>`
}

/**
 * Edge source-target pairing (a pure function, shared by tests and drawTopoEdges):
 * - manager -> every machine (solid green when online, dashed red when offline)
 * - with local nodes (empty host): manager -> the local card (always green, the manager host is always
 *   reachable), and local nodes start from that card (coloured by node state)
 * - the machine a node belongs to -> that node (dashed red when the machine is offline); a node whose host is
 *   not in the machine directory is connected straight from the manager and coloured by node state.
 * @param {Array<{ id: string, online: boolean, revoked?: boolean }>} machines
 * @param {Array<{ id: string, state: string, host?: string | null }>} nodes
 * @param {boolean} hasLocalNodes whether to render the local card (there are nodes with an empty host)
 * @returns {Array<{ from: string, to: string, on: boolean }>}
 */
export const edgePairs = (machines, nodes, hasLocalNodes = false) => {
  const byId = new Map(machines.map((m) => [m.id, m]))
  const pairs = []
  for (const m of machines) pairs.push({ from: 'manager', to: `machine:${m.id}`, on: machineAlive(m) })
  if (hasLocalNodes) pairs.push({ from: 'manager', to: `machine:${LOCAL_MACHINE_ID}`, on: true })
  for (const n of nodes) {
    const host = typeof n.host === 'string' && n.host !== '' && byId.has(n.host) ? byId.get(n.host) : null
    const isLocal = typeof n.host !== 'string' || n.host === ''
    if (host !== null) {
      pairs.push({ from: `machine:${host.id}`, to: `node:${n.id}`, on: machineAlive(host) })
    } else if (hasLocalNodes && isLocal) {
      pairs.push({ from: `machine:${LOCAL_MACHINE_ID}`, to: `node:${n.id}`, on: n.state === 'live' })
    } else {
      pairs.push({ from: 'manager', to: `node:${n.id}`, on: n.state === 'live' })
    }
  }
  return pairs
}

/**
 * The three-column topology skeleton (the first half of DOM assembly): the manager column, the machine
 * column (local card + online machines + collapsed offline ones) and the node column. localHost supplies the
 * platform information for the local card (the manager host does not go through a node-agent and has no
 * metrics badge).
 * @param {{ managerVersion: string, origin: string, containerForm: boolean, machines: any[], nodes: any[], localHost?: { os: string, arch: string } | null }} data
 * @returns {string}
 */
export const topologyHtml = (data) => {
  const { managerVersion, origin, containerForm, machines, nodes, localHost = null } = data
  const hostnameById = new Map(machines.map((m) => [m.id, m.hostname]))
  const online = machines.filter(machineAlive)
  const offline = machines.filter((m) => !machineAlive(m))
  const localNodes = nodes.filter((n) => typeof n.host !== 'string' || n.host === '')
  const localCard =
    localHost !== null && localNodes.length > 0
      ? localMachineCardHtml({ ...localHost, containerForm, nodeCount: localNodes.length })
      : ''
  const manager = managerCardHtml({
    managerVersion,
    origin,
    containerForm,
    machineCount: machines.length + (localCard === '' ? 0 : 1), // the local card counts as a machine too
    nodeCount: nodes.length,
  })
  return `<div class="topo">
    <svg class="topo-edges" aria-hidden="true"></svg>
    <div class="topo-col">
      <div class="topo-col-head">manager</div>
      ${manager}
    </div>
    <div class="topo-col">
      <div class="topo-col-head">${esc(t('topology.col.machines'))}</div>
      ${localCard}
      ${online.length === 0 && localCard === '' ? `<p class="muted small">${esc(t('topology.empty.machines'))}</p>` : online.map((m) => machineCardHtml(m, managerVersion)).join('')}
      ${offline.length === 0
        ? ''
        : `<details class="topo-fold"><summary class="muted small">${esc(t('topology.fold.offline', { count: offline.length }))}</summary>${offline.map((m) => machineCardHtml(m, managerVersion)).join('')}</details>`}
    </div>
    <div class="topo-col">
      <div class="topo-col-head">${esc(t('topology.col.nodes'))}</div>
      ${nodes.length === 0 ? `<p class="muted small">${esc(t('topology.empty.nodes'))}</p>` : nodes.map((n) => nodeCardHtml(n, hostnameById)).join('')}
    </div>
  </div>`
}

/**
 * Draw the SVG connectors from measured rectangles (browser only; skipped while hidden). Card anchors: the
 * midpoint of the source's right edge -> the midpoint of the target's left edge. The caller computes pairs
 * from real data with edgePairs(machines, nodes).
 * @param {HTMLElement} container the `.topo` container
 * @param {Array<{ from: string, to: string, on: boolean }>} pairs
 */
export const drawTopoEdges = (container, pairs) => {
  if (container.clientWidth === 0) return
  const svg = container.querySelector('.topo-edges')
  if (svg === null) return
  svg.innerHTML = ''
  svg.setAttribute('viewBox', `0 0 ${container.clientWidth} ${container.clientHeight}`)
  svg.setAttribute('width', String(container.clientWidth))
  svg.setAttribute('height', String(container.clientHeight))
  const base = container.getBoundingClientRect()
  const anchor = (el, side) => {
    const r = el.getBoundingClientRect()
    return { x: Math.round((side === 'right' ? r.right : r.left) - base.left), y: Math.round(r.top + r.height / 2 - base.top) }
  }
  const find = (key) => {
    if (key === 'manager') return container.querySelector('[data-topo-manager]')
    const [kind, id] = key.split(':')
    const attr = kind === 'machine' ? 'data-topo-machine' : 'data-topo-node'
    return container.querySelector(`[${attr}="${CSS.escape(id)}"]`)
  }
  const lines = []
  for (const pair of pairs) {
    const fromEl = find(pair.from)
    const toEl = find(pair.to)
    if (fromEl === null || toEl === null) continue
    const a = anchor(fromEl, 'right')
    const b = anchor(toEl, 'left')
    lines.push(`<line class="topo-edge ${pair.on ? 'on' : 'off'}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" />`)
  }
  svg.innerHTML = lines.join('')
}
