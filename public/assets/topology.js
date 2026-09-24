// @ts-check
// 集群拓扑（UI 收尾 C）：manager → 机器 → 节点（DSH）三列静态拓扑，纯前端
// 聚合 /api/nodes + /api/agents，零新 API、零依赖。机器列 = node-agent 注册
// 的远端机器 + 「本机（manager 宿主）」伪卡（C-P1.5：本机不经 node-agent，
// 直管节点，边从本机卡出发）。卡片拼装与边配对是纯函数（topology.test.mjs
// 可单测）；SVG 连线只在浏览器里按实测矩形画（drawTopoEdges，DOM 函数）。
import { esc, platformLabel, t, loadI18n } from './ui.js'

await loadI18n()
import { machineMetricBits } from './machines.js'

/** 节点形态 tag：host 派发 → agent 远端；有镜像 → 容器工蜂；其余看托管态。 */
export const formTag = (n) => {
  if (typeof n.host === 'string' && n.host !== '') return t('topology.form.agentRemote')
  if (typeof n.image === 'string' && n.image !== '') return t('nodes.local.deployDocker')
  return n.managed === true ? t('nodes.local.deployProcess') : t('nodes.external')
}

/** 机器在线态决定边样式：在线绿实线 / 离线红虚线（revoked 也走虚线）。 */
export const machineAlive = (m) => m.online === true && m.revoked !== true

/** 本机（manager 宿主）在拓扑里的伪机器 id；与 agent-* 注册 id 不冲突。 */
export const LOCAL_MACHINE_ID = 'local'

// 平台名映射搬到 ui.js（机器列表本机行与拓扑本机卡共用）；此处再导出
// 保持 topology.test.mjs 既有导入面不变。
export { platformLabel } from './ui.js'

/**
 * 本机卡（C-P1.5）：manager 宿主机不是 node-agent 注册机器（机器目录语义 =
 * 受管远端主机），但拓扑里画成机器列首张卡，本机节点边从它出发——
 * 图与"manager 直管本机"的事实对齐。无指标徽标：本机指标不经 agent 上报。
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
 * manager 卡片：版本 + 监听面 + 部署形态 + 机器/节点计数。
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
 * 机器卡片：在线点 + 主机名 + 指标徽标 + 待更新徽标；离线/已吊销进折叠区。
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
 * 节点卡片：状态点 + 工作区 + DSH 版本 + 形态 tag；漂移/版本告警同列表口径。
 * @param {{ id: string, state: string, agents?: string[], dshVersion?: string | null, configuredDshVersion?: string | null, dshDrift?: boolean, dshCompatible?: boolean, host?: string | null, image?: string | null, managed: boolean }} n
 * @param {Map<string, string>} hostnameById 机器 id → hostname
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
 * 边的源-目标配对（纯函数，供测试与 drawTopoEdges 共用）：
 * - manager → 每台机器（在线绿实线 / 离线红虚线）
 * - 有本机节点（host 为空）时 manager → 本机卡（常绿，manager 宿主机恒可达），
 *   本机节点从本机卡出发（按节点状态上色）
 * - 节点归属机器 → 节点（机器离线则红虚线）；host 不在机器目录的节点直接从
 *   manager 拉线，按节点状态上色。
 * @param {Array<{ id: string, online: boolean, revoked?: boolean }>} machines
 * @param {Array<{ id: string, state: string, host?: string | null }>} nodes
 * @param {boolean} hasLocalNodes 是否渲染本机卡（有 host 为空的节点）
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
 * 三列拓扑骨架（DOM 装配的前半段）：manager 列 + 机器列（本机卡 + 在线机器
 * + 离线折叠）+ 节点列。localHost 给本机卡提供平台信息（manager 宿主不经
 * node-agent，无指标徽标）。
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
    machineCount: machines.length + (localCard === '' ? 0 : 1), // 本机卡也算一台
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
 * 按实测矩形画 SVG 连线（仅浏览器；隐藏时跳过）。卡片锚点：源右缘中点 →
 * 目标左缘中点。pair 由调用方用 edgePairs(machines, nodes) 从真实数据算出。
 * @param {HTMLElement} container `.topo` 容器
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
