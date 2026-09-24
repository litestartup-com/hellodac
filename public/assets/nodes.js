// 节点总览页（蜂群 Q4）：侧栏只放一行汇总 + 异常，全景在这里。
//
// 两个列表：机器目录（舰队）+ 全部节点（托管读监督器状态机，外管读探活）。
// 15 秒轮询，与侧栏同一数据源 /api/nodes，不另起真相。
// 能力三 v1：节点行挂「原生 GUI」卡（隧道命令 + 打开/配置），纯函数层在
// gui-access.js。UI 收尾 A：全局任务流迁至 /runs（任务页）。
import { $, esc, setHtml, apiJson, poll, t, loadI18n } from './ui.js'

// 动态文案走客户端字典（服务端已渲染静态文案；字典由 /api/i18n/<lang> 提供）。
// 顶层 await：首屏渲染前字典就位，避免先显示键名再补译文。
await loadI18n()
import { guiCardHtml, guiDirectCardHtml, guiSetupButton } from './gui-access.js'
import { nodeCreatePayload, hostRunnerConfirmText, dangerSandboxConfirmText, versionOptionsHtml } from './node-form.js'
import { machineRowHtml, joinCommand, localMachineRowHtml } from './machines.js'
import { topologyHtml, edgePairs, drawTopoEdges } from './topology.js'

const NODE_STATE_DOT = { live: 'ok', cold: 'muted', starting: 'warn', restarting: 'warn', offline: 'bad' }
const NODE_STATE_LABEL = {
  live: 'live',
  cold: t('nodes.state.cold'),
  starting: t('nodes.state.starting'),
  restarting: t('nodes.state.restarting'),
  offline: 'offline',
}

const nodeRow = (n) => {
  const dot = NODE_STATE_DOT[n.state] ?? 'muted'
  const label = NODE_STATE_LABEL[n.state] ?? n.state
  const agents = Array.isArray(n.agents) && n.agents.length > 0 ? n.agents.join(' / ') : '—'
  const meta = [n.managed ? t('nodes.managed') : t('nodes.external'), typeof n.pid === 'number' && n.pid !== null ? `pid ${n.pid}` : null]
    .filter(Boolean)
    .join(' · ')
  const err = typeof n.lastError === 'string' && n.lastError !== '' ? ` — ${n.lastError}` : ''
  // 蜂群2计划 P1：DSH 版本与验证版本不符 → 黄标（照跑不装瞎）
  const versionWarn =
    typeof n.dshVersion === 'string' && n.dshVersion !== '' && n.dshCompatible === false
      ? `<span class="pill-mini warn" title="${esc(t('nodes.versionWarnTitle', { version: n.dshVersion }))}">${esc(t('nodes.versionWarn'))}</span>`
      : ''
  // 能力二：profile 种子与配置钉版不一致 = 漂移（对齐按钮入口）
  const driftWarn =
    n.dshDrift === true
      ? `<span class="pill-mini warn" title="${esc(t('nodes.driftWarnTitle'))}">${esc(t('nodes.driftWarn'))}</span>`
      : ''
  // 版本信息：容器形态先展示镜像标签（tag 即 DSH 版本），再补 DSH 版本行。
  const versionBits = []
  if (typeof n.image === 'string' && n.image !== '') versionBits.push(esc(n.image))
  if (typeof n.dshVersion === 'string' && n.dshVersion !== '') versionBits.push(`DSH ${esc(n.dshVersion)}`)
  // 显式钉版值得展示；跟随默认（null）不显示
  if (typeof n.configuredDshVersion === 'string' && n.configuredDshVersion !== '') versionBits.push(esc(t('nodes.pinned', { version: n.configuredDshVersion })))
  // 能力四（M1-7）：舰队节点显示执行主机（hostname 映射，未知回退 id）
  if (typeof n.host === 'string' && n.host !== '') versionBits.push(esc(t('nodes.hostBit', { host: agentHostnames.get(n.host) ?? n.host })))
  const detail = `agent：${esc(agents)}${versionBits.length > 0 ? ` · ${versionBits.join(' · ')}` : ''}`
  const starting = n.state === 'starting'
  const alignBtn =
    n.dshDrift === true
      ? `<button type="button" class="btn-quiet btn-sm" data-node-align="${esc(n.id)}" title="${esc(t('nodes.action.alignTitle'))}">${esc(t('nodes.action.align'))}</button>`
      : ''
  // 能力二/P1：版本切换下拉（矩阵数据源；跟随默认 = 未显式钉版）
  const versionSel =
    n.managed
      ? `<select class="node-version-select" data-node-version="${esc(n.id)}" title="${esc(t('nodes.action.versionTitle'))}">${versionOptionsHtml(versionList, n.configuredDshVersion)}</select>`
      : ''
  const controls = n.managed
    ? `<div class="node-actions">
        ${
          n.state === 'cold' || n.state === 'offline'
            ? `<button type="button" class="btn-quiet btn-sm" data-node-up="${esc(n.id)}">${esc(t('nodes.action.start'))}</button>`
            : `<button type="button" class="btn-quiet btn-sm" data-node-down="${esc(n.id)}" ${starting ? 'disabled' : ''}>${esc(t('nodes.action.stop'))}</button>
               <button type="button" class="btn-quiet btn-sm" data-node-restart="${esc(n.id)}" ${starting ? 'disabled' : ''}>${esc(t('nodes.action.restart'))}</button>`
        }
        ${alignBtn}
        <button type="button" class="btn-quiet btn-sm" data-node-logs="${esc(n.id)}">${esc(t('nodes.action.logs'))}</button>
        <button type="button" class="btn-quiet btn-sm" data-node-rm="${esc(n.id)}" title="${esc(t('nodes.action.removeTitle'))}">${esc(t('nodes.action.remove'))}</button>
      </div>`
    : `<span class="muted small">${esc(t('nodes.externalManual'))}</span>`
  // 能力三 v1：原生 GUI 卡（隧道 / 本机直连 / 配置入口 三形态）。
  const guiBits =
    n.access !== null && n.access !== undefined
      ? `<div class="node-side">${guiCardHtml(n.id, n.access, n.guiUrl)}</div>`
      : n.guiUrl !== null && n.guiUrl !== undefined
        ? `<div class="node-side">${guiDirectCardHtml(n.id, n.guiUrl)}</div>`
        : `<div class="node-side">${guiSetupButton(n.id)}</div>`
  return `<div class="node-row" data-node-row="${esc(n.id)}">
    <div class="node-main">
      <div class="node-title"><span class="dot ${dot}"></span>${esc(n.id)} <span class="muted">· ${esc(label)}</span> ${versionWarn} ${driftWarn}</div>
      <div class="node-meta">${esc(meta)}${esc(err)}</div>
      <div class="node-detail">${detail}${versionSel}</div>
    </div>
    ${controls}
    ${guiBits}
  </div>`
}

// 蜂群 P5.1：节点管控（起/停/重启）+ 日志抽屉。
const nodeAction = async (id, action) => {
  try {
    // 债务 F6:统一 Result 层——失败 alert 读 r.detail,不再手拼 body 与状态码。
    const r = await apiJson(`/api/nodes/${encodeURIComponent(id)}/${action}`, { method: 'POST' })
    if (!r.ok) alert(r.detail)
  } catch (error) {
    alert(t('common.opFailed', { message: error.message }))
  }
  await load()
}

// 能力二：版本对齐 = 异步重播种 + 重装 + 重启（202 即受理）。
const alignNode = async (id) => {
  if (!window.confirm(t('nodes.align.confirm', { id }))) return
  try {
    const r = await apiJson(`/api/nodes/${encodeURIComponent(id)}/align-version`, { method: 'POST' })
    if (!r.ok) alert(r.detail)
    else alert(t('nodes.align.submitted'))
  } catch (error) {
    alert(t('common.opFailed', { message: error.message }))
  }
  await load()
}

let logsNode = null
let logsTimer = null

const refreshLogs = async () => {
  if (logsNode === null) return
  try {
    const r = await apiJson(`/api/nodes/${encodeURIComponent(logsNode)}/logs`)
    const body = r.ok ? r.data : {}
    $('node-logs-body').textContent = typeof body.logs === 'string' && body.logs !== '' ? body.logs : t('nodes.logs.empty')
    $('node-logs-body').scrollTop = $('node-logs-body').scrollHeight
  } catch {
    $('node-logs-body').textContent = t('nodes.logs.readFailed')
  }
}

const openLogs = (id) => {
  logsNode = id
  $('node-logs').hidden = false
  $('node-logs-title').textContent = t('nodes.logs.title', { id })
  void refreshLogs()
  if (logsTimer !== null) clearInterval(logsTimer)
  logsTimer = setInterval(() => void refreshLogs(), 5_000)
}

const closeLogs = () => {
  logsNode = null
  $('node-logs').hidden = true
  if (logsTimer !== null) clearInterval(logsTimer)
  logsTimer = null
}

$('nodes-list').addEventListener('click', (event) => {
  const up = event.target.closest('[data-node-up]')
  if (up !== null) return void nodeAction(up.dataset.nodeUp, 'up')
  const down = event.target.closest('[data-node-down]')
  if (down !== null) return void nodeAction(down.dataset.nodeDown, 'down')
  const restart = event.target.closest('[data-node-restart]')
  if (restart !== null) return void nodeAction(restart.dataset.nodeRestart, 'restart')
  const align = event.target.closest('[data-node-align]')
  if (align !== null) return void alignNode(align.dataset.nodeAlign)
  const logs = event.target.closest('[data-node-logs]')
  if (logs !== null) return void openLogs(logs.dataset.nodeLogs)
  const rm = event.target.closest('[data-node-rm]')
  if (rm !== null) return void removeNode(rm.dataset.nodeRm)
  // 能力三 v1：原生 GUI 卡操作
  const guiOpen = event.target.closest('[data-gui-open]')
  if (guiOpen !== null) {
    const url = guiOpen.dataset.guiUrl
    if (typeof url === 'string' && url !== '') window.open(url, '_blank', 'noopener')
    return
  }
  const guiCopy = event.target.closest('[data-gui-copy]')
  if (guiCopy !== null) {
    const command = guiCopy.dataset.guiCmd ?? ''
    navigator.clipboard
      ?.writeText(command)
      .then(() => alert(t('nodes.tunnel.copied')))
      .catch(() => alert(t('nodes.tunnel.copyFailed', { command })))
    return
  }
  const access = event.target.closest('[data-node-access]')
  if (access !== null) return void openAccessEditor(access.dataset.nodeAccess)
})

// 能力二/P1：版本切换下拉——确认后 POST /api/nodes/:id/version（202 = 受理，异步重建/重装）
$('nodes-list').addEventListener('change', (event) => {
  const sel = event.target.closest('[data-node-version]')
  if (sel === null) return
  const id = sel.dataset.nodeVersion
  const followDefault = sel.value === ''
  const target = followDefault ? (versionList[0]?.dsh ?? '') : sel.value
  if (target === '') return
  const note = followDefault ? t('nodes.version.noteDefault') : ''
  if (!window.confirm(t('nodes.version.confirm', { id, version: target, note }))) {
    void load() // 取消选择 → 还原下拉
    return
  }
  void (async () => {
    try {
      const r = await apiJson(`/api/nodes/${encodeURIComponent(id)}/version`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dsh_version: target }),
      })
      if (!r.ok) alert(r.detail)
      else {
        const rData = r.data ?? {}
        alert(typeof rData.image === 'string' ? t('nodes.version.switchedImage', { image: rData.image }) : t('nodes.version.switchedDsh', { version: rData.version }))
      }
    } catch (error) {
      alert(t('common.opFailed', { message: error.message }))
    }
    await load()
  })()
})

$('node-logs-refresh').addEventListener('click', () => void refreshLogs())
$('node-logs-close').addEventListener('click', closeLogs)

// ---- 蜂群 P5.5：新增节点向导 + 删除 ----

const removeNode = async (id) => {
  if (!window.confirm(t('nodes.remove.confirm', { id }))) return
  try {
    // 债务 F6:统一 Result 层。
    const r = await apiJson(`/api/nodes/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (!r.ok) {
      alert(r.detail)
      return
    }
    await load()
  } catch (error) {
    alert(t('common.deleteFailed', { message: error.message }))
  }
}

$('new-node').addEventListener('click', () => {
  $('node-editor').hidden = false
  $('f-node-name').focus()
})

$('f-cancel').addEventListener('click', () => {
  $('node-editor').hidden = true
})

// 高级设置随节点名实时联动：没被手改过的字段跟着节点名走；手改过（dirty）
// 的字段保持不动，清空才重新跟随。提交时 clean 字段省略，后端按同一规则
// 自动生成——展示与落盘永远一致。
const advancedFields = ['f-agent-id', 'f-agent-name', 'f-agent-workspace']
const advancedDirty = new Set()
// 蜂群2计划 P6：容器模式（docker runner）下默认工作区 = manager 挂载视角路径
let dockerMode = false
/** 能力二/P1：矩阵数据源缓存（节点行版本下拉用）。 */
let versionList = []
/** 能力四（M1-7）：agent id → hostname 展示映射（load 时刷新）。 */
let agentHostnames = new Map()

for (const id of advancedFields) {
  const el = $(id)
  el.addEventListener('input', () => {
    if (el.value.trim() === '') advancedDirty.delete(id)
    else advancedDirty.add(id)
  })
}

$('f-node-name').addEventListener('input', () => {
  const name = $('f-node-name').value.trim()
  if (!advancedDirty.has('f-agent-id')) $('f-agent-id').value = name
  if (!advancedDirty.has('f-agent-name')) $('f-agent-name').value = name
  if (!advancedDirty.has('f-agent-workspace')) {
    const base = dockerMode ? '/opt/dac/workspaces' : '~/.dac/workspaces'
    $('f-agent-workspace').value = name === '' ? '' : `${base}/${name}`
  }
})

$('node-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const name = $('f-node-name').value.trim()
  const portRaw = $('f-node-port').value.trim()
  if (name === '') return

  // 能力一：宿主机进程形态 = 整机能力，黄字确认（与审计 node_create_host 同源）。
  const runner = $('f-node-runner').value
  // 能力四（M1-7）：选了主机 = agent 远端节点——强制 process 语义 + 地址必填
  const hostId = $('f-node-host').value.trim()
  const hostUrl = $('f-node-url').value.trim()
  if (hostId !== '' && hostUrl === '') {
    $('f-warn').textContent = t('nodes.form.hostNeedsUrl')
    return
  }
  if (hostId !== '' && runner === 'docker') {
    $('f-warn').textContent = t('nodes.form.hostNoDocker')
    return
  }
  if ((hostId !== '' || runner === 'process') && !window.confirm(hostRunnerConfirmText(name))) return
  // 舰队 M3-1：ops 第三档沙箱 = 整机全量，独立黄字确认（审批卡片 + 审计）
  if ($('f-agent-sandbox').value === 'danger-full-access' && !window.confirm(dangerSandboxConfirmText(name))) return

  // 工作区总是创建；clean 的字段省略（后端按节点名生成同款默认）。
  const payload = nodeCreatePayload({
    name,
    port: portRaw,
    runner,
    dshVersion: $('f-node-version').value,
    host: hostId,
    url: hostUrl,
    agent: {
      ...(advancedDirty.has('f-agent-id') ? { id: $('f-agent-id').value.trim() } : {}),
      ...(advancedDirty.has('f-agent-name') ? { name: $('f-agent-name').value.trim() } : {}),
      ...(advancedDirty.has('f-agent-workspace') ? { workspace: $('f-agent-workspace').value.trim() } : {}),
      ...($('f-agent-preset').value.trim() === '' ? {} : { preset: $('f-agent-preset').value.trim() }),
      sandboxMode: $('f-agent-sandbox').value,
    },
  })

  const save = $('f-save')
  save.disabled = true
  save.textContent = t('nodes.form.creating')
  try {
    // 债务 F6:统一 Result 层——创建失败提示读 r.detail。
    const r = await apiJson('/api/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!r.ok) {
      $('f-warn').textContent = r.detail
      return
    }
    const body = r.data
    $('f-warn').textContent =
      body.workspaceWarning === null || body.workspaceWarning === undefined
        ? ''
        : t('nodes.form.createdWithWarning', { warning: body.workspaceWarning })
    $('node-editor').hidden = true
    $('node-form').reset()
    advancedDirty.clear()
    await load()
  } catch (error) {
    $('f-warn').textContent = t('common.createFailed', { message: error.message })
  } finally {
    save.disabled = false
    save.textContent = t('common.create')
  }
})

// ---- 能力三 v1：原生访问配置（SSH 隧道元数据） ----

/** @type {Record<string, { sshUser: string, sshHost: string, sshPort: number, guiPort: number, localPort: number, sshKey: string | null } | null>} */
let accessById = {}
/** @type {string | null} 编辑器当前编辑的节点 id。 */
let accessNode = null

const openAccessEditor = (id) => {
  accessNode = id
  const current = accessById[id]
  $('f-acc-title').textContent = t('nodes.access.titleWith', { id })
  $('f-acc-user').value = current?.sshUser ?? ''
  $('f-acc-host').value = current?.sshHost ?? ''
  $('f-acc-sshport').value = current !== null && current !== undefined ? String(current.sshPort) : ''
  $('f-acc-gui').value = current !== null && current !== undefined ? String(current.guiPort) : ''
  $('f-acc-local').value = current !== null && current !== undefined ? String(current.localPort) : ''
  $('f-acc-key').value = current?.sshKey ?? ''
  $('f-acc-warn').textContent = ''
  $('node-access-editor').hidden = false
  $('f-acc-user').focus()
}

const closeAccessEditor = () => {
  accessNode = null
  $('node-access-editor').hidden = true
}

$('f-acc-cancel').addEventListener('click', closeAccessEditor)

$('f-acc-clear').addEventListener('click', async () => {
  if (accessNode === null) return
  if (!window.confirm(t('nodes.access.clearConfirm', { id: accessNode }))) return
  try {
    const r = await apiJson(`/api/nodes/${encodeURIComponent(accessNode)}/access`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clear: true }),
    })
    if (!r.ok) {
      $('f-acc-warn').textContent = r.detail
      return
    }
    closeAccessEditor()
    await load()
  } catch (error) {
    $('f-acc-warn').textContent = t('nodes.access.clearFailed', { message: error.message })
  }
})

$('node-access-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  if (accessNode === null) return
  const user = $('f-acc-user').value.trim()
  const host = $('f-acc-host').value.trim()
  const local = Number($('f-acc-local').value.trim())
  if (user === '' || host === '' || !Number.isInteger(local) || local <= 0) {
    $('f-acc-warn').textContent = t('nodes.access.required')
    return
  }
  const sshPort = Number($('f-acc-sshport').value.trim())
  const guiPort = Number($('f-acc-gui').value.trim())
  const sshKey = $('f-acc-key').value.trim()
  const payload = {
    ssh_user: user,
    ssh_host: host,
    local_port: local,
    ...(Number.isInteger(sshPort) && sshPort > 0 ? { ssh_port: sshPort } : {}),
    ...(Number.isInteger(guiPort) && guiPort > 0 ? { gui_port: guiPort } : {}),
    ...(sshKey === '' ? {} : { ssh_key: sshKey }),
  }
  try {
    const r = await apiJson(`/api/nodes/${encodeURIComponent(accessNode)}/access`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!r.ok) {
      $('f-acc-warn').textContent = r.detail
      return
    }
    closeAccessEditor()
    await load()
  } catch (error) {
    $('f-acc-warn').textContent = t('nodes.access.saveFailed', { message: error.message })
  }
})

// ---- 能力四（M1-7）：机器目录 ----
$('add-machine').addEventListener('click', async () => {
  try {
    const r = await apiJson('/api/agents/join', { method: 'POST' })
    if (!r.ok) {
      alert(r.detail)
      return
    }
    const { token, expiresAt } = r.data
    const origin = window.location.origin
    $('join-command').textContent = joinCommand(origin, token)
    $('join-box').hidden = false
    $('join-command').title = t('nodes.join.expiresAt', { time: new Date(expiresAt).toLocaleTimeString(undefined, { hour12: false }) })
  } catch (error) {
    alert(t('nodes.join.issueFailed', { message: error.message }))
  }
})

$('join-copy').addEventListener('click', () => {
  void navigator.clipboard?.writeText($('join-command').textContent ?? '')
  alert(t('nodes.join.copied'))
})

$('join-close').addEventListener('click', () => {
  $('join-box').hidden = true
})

$('machines-list').addEventListener('click', (event) => {
  // UI 收尾 C-P1.5：点本机行跳「全部节点」区块（本机没有 agent 专属动作）。
  if (event.target.closest('[data-local-machine-row]') !== null) {
    const list = $('nodes-list')
    if (list !== null) list.scrollIntoView({ behavior: 'smooth', block: 'start' })
    return
  }
  const toggle = event.target.closest('#machines-revoked-toggle')
  if (toggle !== null) {
    const box = $('machines-revoked')
    if (box !== null) {
      box.hidden = !box.hidden
      toggle.textContent = revokedToggleLabel(!box.hidden)
    }
    return
  }
  const del = event.target.closest('[data-agent-delete]')
  if (del !== null) {
    const id = del.dataset.agentDelete
    if (!window.confirm(t('nodes.machine.deleteConfirm', { host: agentHostnames.get(id) ?? id }))) return
    void apiJson(`/api/agents/${encodeURIComponent(id)}/delete`, { method: 'POST' })
      .then((r) => {
        if (!r.ok) alert(r.detail)
        return load()
      })
      .catch((error) => alert(t('common.deleteFailed', { message: error.message })))
    return
  }
  const rotate = event.target.closest('[data-agent-rotate]')
  if (rotate !== null) {
    const id = rotate.dataset.agentRotate
    if (!window.confirm(t('nodes.machine.rotateConfirm', { host: agentHostnames.get(id) ?? id }))) return
    void apiJson(`/api/agents/${encodeURIComponent(id)}/rotate`, { method: 'POST' })
      .then((r) => {
        if (!r.ok) alert(r.detail)
        return load()
      })
      .catch((error) => alert(t('nodes.machine.rotateFailed', { message: error.message })))
    return
  }
  const revoke = event.target.closest('[data-agent-revoke]')
  if (revoke === null) return
  const id = revoke.dataset.agentRevoke
  if (!window.confirm(t('nodes.machine.revokeConfirm', { host: agentHostnames.get(id) ?? id }))) return
  void apiJson(`/api/agents/${encodeURIComponent(id)}/revoke`, { method: 'POST' })
    .then((r) => {
      if (!r.ok) alert(r.detail)
      return load()
    })
    .catch((error) => alert(t('nodes.machine.revokeFailed', { message: error.message })))
})

// ---- UI 收尾 C-P1：集群拓扑（视图切换 + 边线绘制 + 卡片跳转） ----
let revokedCount = 0
let topoState = { managerVersion: '', origin: window.location.origin, containerForm: false, machines: [], nodes: [], localHost: null }

const VIEW_KEY = 'nodes-view'

/** 折叠按钮文案（计数随机器数走；不靠中文字符串替换）。 */
const revokedToggleLabel = (visible) =>
  visible
    ? t('nodes.revoked.hide', { count: revokedCount })
    : t('nodes.revoked.show', { count: revokedCount })

const setRevokedFold = (show) => {
  const box = $('machines-revoked')
  const toggle = $('machines-revoked-toggle')
  if (box === null) return
  box.hidden = !show
  if (toggle !== null) toggle.textContent = revokedToggleLabel(show)
}

const redrawTopo = () => {
  const container = document.querySelector('#topology .topo')
  if (container === null) return
  // C-P1.5：有 host 为空的节点才渲染本机卡（本机节点从本机卡出发）。
  const hasLocal = topoState.nodes.some((n) => typeof n.host !== 'string' || n.host === '')
  drawTopoEdges(container, edgePairs(topoState.machines, topoState.nodes, hasLocal))
}

const renderTopo = () => {
  // 轮询重绘时保留用户展开的「离线/已吊销」折叠区状态。
  const prev = document.querySelector('#topology details.topo-fold')
  const wasOpen = prev !== null && prev.open
  setHtml('topology', topologyHtml(topoState))
  const next = document.querySelector('#topology details.topo-fold')
  if (wasOpen && next !== null) next.open = true
  redrawTopo()
}

// ── 三视图（DAC v1.0.0）：拓扑 / 节点 / 机器 ────────────────────────
const VIEWS = ['topo', 'nodes', 'machines']
const VIEW_PANELS = { topo: 'topology-section', nodes: 'nodes-view', machines: 'machines-view' }
const VIEW_BUTTONS = { topo: 'view-topo', nodes: 'view-nodes', machines: 'view-machines' }

const setView = (view) => {
  // 旧偏好（'list'）映射到节点视图，避免升级后落在空视图上。
  const active = VIEWS.includes(view) ? view : view === 'list' ? 'nodes' : 'topo'
  for (const name of VIEWS) {
    $(VIEW_PANELS[name]).hidden = name !== active
    $(VIEW_BUTTONS[name]).classList.toggle('on', name === active)
  }
  try {
    localStorage.setItem(VIEW_KEY, active)
  } catch {
    // 隐私模式等存储失败忽略——只是记不住偏好，不影响使用。
  }
  if (active === 'topo') redrawTopo()
  return active
}

for (const name of VIEWS) $(VIEW_BUTTONS[name]).addEventListener('click', () => setView(name))

// 点拓扑卡片 → 跳对应视图并定位到那一行（吊销折叠区先展开再定位）。
const jumpTo = (view, selector) => {
  setView(view)
  const row = document.querySelector(selector)
  if (row === null) return
  const fold = row.closest('#machines-revoked')
  if (fold !== null && fold.hidden) setRevokedFold(true)
  row.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

$('topology').addEventListener('click', (event) => {
  const mach = event.target.closest('[data-topo-machine]')
  if (mach !== null) {
    jumpTo('machines', `[data-machine-row="${CSS.escape(mach.dataset.topoMachine)}"]`)
    return
  }
  const nd = event.target.closest('[data-topo-node]')
  if (nd !== null) jumpTo('nodes', `[data-node-row="${CSS.escape(nd.dataset.topoNode)}"]`)
})

// ── 抽屉（新增节点向导 / 原生访问配置）：背景点击与 Esc 关闭 ─────────
const DRAWERS = ['node-editor', 'node-access-editor']
for (const id of DRAWERS) {
  $(id).addEventListener('click', (event) => {
    if (event.target.closest('[data-close]') !== null) $(id).hidden = true
  })
}
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  for (const id of DRAWERS) if (!$(id).hidden) $(id).hidden = true
})

window.addEventListener('resize', redrawTopo)

// 默认落在拓扑视图（舰队全貌最有信息量）；用户切换后记住偏好。
let savedView = 'topo'
try {
  savedView = localStorage.getItem(VIEW_KEY) ?? 'topo'
} catch {
  savedView = 'topo'
}
setView(savedView)

const load = async () => {
  try {
    // 债务 F6:统一 Result 层。
    const [nodesResult, agentsResult] = await Promise.all([apiJson('/api/nodes'), apiJson('/api/agents')])
    if (!nodesResult.ok) return
    const { nodes, dockerMode: isDocker, supportedDsh, containerForm, hostOs, hostArch, hostName, hostNodeVersion } = nodesResult.data
    dockerMode = isDocker === true
    if (Array.isArray(supportedDsh)) versionList = supportedDsh
    // 能力四（M1-7/M4-3/UI 收尾 B）：机器目录 + 主机下拉 + 节点行主机名映射 +
    // 待更新徽标；已吊销机器默认折叠（可展开 + 删除记录）。
    if (agentsResult.ok && Array.isArray(agentsResult.data.agents)) {
      const machines = agentsResult.data.agents
      const managerVersion = agentsResult.data.managerVersion
      agentHostnames = new Map(machines.map((m) => [m.id, m.hostname]))
      const active = machines.filter((m) => !m.revoked)
      const revoked = machines.filter((m) => m.revoked)
      revokedCount = revoked.length
      // UI 收尾 C-P1.5：机器列表首行 = 本机（纯 UI 投影，不进 agent_machine）。
      const localNodes = nodes.filter((n) => typeof n.host !== 'string' || n.host === '')
      const localRow = localMachineRowHtml({
        hostname: typeof hostName === 'string' ? hostName : t('nodes.local.hostnameFallback'),
        os: typeof hostOs === 'string' ? hostOs : 'unknown',
        arch: typeof hostArch === 'string' ? hostArch : 'unknown',
        nodeVersion: typeof hostNodeVersion === 'string' ? hostNodeVersion.replace(/^v/, '') : '—',
        containerForm: containerForm === true,
        nodeCount: localNodes.length,
      })
      setHtml('machines-list', [
        localRow,
        machines.length === 0
          ? `<p class="muted small">${t('nodes.emptyMachines')}</p>`
          : `<div class="muted small" style="margin-top:6px">${esc(t('nodes.machines.remote'))}</div>${[
              ...active.map((m) => machineRowHtml({ ...m, managerVersion })),
              revoked.length > 0
                ? `<div class="muted small" style="margin-top:8px"><button type="button" id="machines-revoked-toggle" class="btn-quiet btn-sm">${esc(t('nodes.revoked.show', { count: revoked.length }))}</button><div id="machines-revoked" hidden>${revoked.map((m) => machineRowHtml({ ...m, managerVersion })).join('')}</div></div>`
                : '',
            ].join('')}`,
      ].join(''))
      const hostSel = $('f-node-host')
      const online = machines.filter((m) => !m.revoked && m.online)
      while (hostSel.options.length > 1) hostSel.remove(1)
      for (const m of online) {
        const opt = document.createElement('option')
        opt.value = m.id
        opt.textContent = `${m.hostname}（${m.os}/${m.arch}）`
        hostSel.appendChild(opt)
      }
      // UI 收尾 C-P1：集群拓扑数据帧（纯前端聚合 /api/nodes + /api/agents，
      // 不另起真相；拓扑视图可见时才画 SVG 边线）。managerVersion 注入与
      // 列表行同口径，否则「待更新」徽标在拓扑里永远不亮。
      topoState = {
        managerVersion,
        origin: window.location.origin,
        containerForm: containerForm === true,
        machines: machines.map((m) => ({ ...m, managerVersion })),
        nodes,
        localHost: typeof hostOs === 'string' && typeof hostArch === 'string' ? { os: hostOs, arch: hostArch } : null,
      }
      renderTopo()
    }
    // 容器形态部署（manager 在容器内）不支持宿主机进程节点——向导里禁用该
    // 选项并改写文案；裸机部署（含混合 docker.sock 部署）不受限。
    const processOpt = $('f-node-runner').querySelector('option[value="process"]')
    if (processOpt !== null) {
      processOpt.disabled = containerForm === true
      processOpt.textContent = containerForm === true ? t('nodes.form.runnerProcessDisabled') : t('nodes.form.runnerProcess')
    }
    // 能力二：版本下拉 = 矩阵数据源（首次填充后不再重复）
    if (Array.isArray(supportedDsh)) {
      const sel = $('f-node-version')
      if (sel.options.length <= 1) {
        for (const v of supportedDsh) {
          const opt = document.createElement('option')
          opt.value = v.dsh
          opt.textContent = v.status === 'pending' ? t('nodes.version.pending', { version: v.dsh }) : t('nodes.version.verified', { version: v.dsh })
          sel.appendChild(opt)
        }
      }
    }
    // 能力三 v1：access 真相缓存（编辑器预填用）
    accessById = Object.fromEntries(nodes.map((n) => [n.id, n.access ?? null]))
    const live = nodes.filter((n) => n.state === 'live').length
    const abnormal = nodes.filter((n) => n.state !== 'live').length
    $('nodes-count').textContent =
      abnormal > 0
        ? t('nodes.countAbnormal', { live, total: nodes.length, abnormal })
        : t('nodes.count', { live, total: nodes.length })
    setHtml(
      'nodes-list',
      nodes.length === 0
        ? `<p class="muted small">${esc(t('nodes.empty'))}</p>`
        : nodes.map(nodeRow).join(''),
    )

    $('nodes-refresh').textContent = t('nodes.refreshAt', { time: new Date().toLocaleTimeString(undefined, { hour12: false }) })
  } catch {
    // 网络失败时保留上一帧，不刷成错误页。
  }
}

void load()
poll(() => void load(), 15_000)
