// Node overview page (hive Q4): the sidebar keeps one summary line plus anomalies; the full picture is here.
//
// Two lists: the machine directory (fleet) and all nodes (managed ones read the supervisor state machine,
// externally managed ones read reachability). Polled every 15 seconds from the same source as the sidebar,
// /api/nodes, so there is no second truth. Capability three v1: a node row carries the "native GUI" card
// (tunnel command plus open/configure), whose pure layer is gui-access.js. UI wrap-up A: the global task
// stream moved to /runs (the task page).
import { $, esc, setHtml, apiJson, poll, t, loadI18n } from './ui.js'

// Dynamic text comes from the client dictionary (static text is server-rendered, and the dictionary is
// served by /api/i18n/<lang>). Top-level await so the dictionary is in place before the first paint, rather
// than showing key names first and patching translations in later.
await loadI18n()
import { nodeCreatePayload, hostRunnerConfirmText, dangerSandboxConfirmText } from './node-form.js'
import { machineRowHtml, joinCommand, localMachineRowHtml } from './machines.js'
import { topologyHtml, edgePairs, drawTopoEdges } from './topology.js'
import { nodeRow, nodeMenuHtml, nodeMenuId, nodeVersionMenuId } from './node-row.js'
import { placePanel, placeSubmenu } from './menu.js'
import { guiTunnelCommand } from './gui-access.js'

// The node row itself and its three-dot menu live in node-row.js (pure function layer, unit-tested). What
// remains here is assembly: the row plus its two flyouts (main menu, version submenu), appended to body so
// that .card cannot clip them.
const renderNodes = (nodes) => {
  // The list is redrawn every 15 seconds while the menu flyouts hang on body, outside the list: without
  // closing them explicitly, a redraw leaves an orphan flyout pointing at the old row (it only disappears
  // the next time the three-dot button is clicked).
  closeNodeMenu()
  setHtml(
    'nodes-list',
    nodes.length === 0
      ? `<p class="muted small">${esc(t('nodes.empty'))}</p>`
      : nodes.map((n) => nodeRow(n, (host) => agentHostnames.get(host) ?? host) + nodeMenuHtml(n, versionList)).join(''),
  )
}

// ---- Node three-dot menu: open/close, positioning, submenu ----

/** The currently open node menu (its id and its node). Only one at a time. */
let openMenuNode = null
/** The submenu item expanded inside the main menu (null = none). */
let openSub = null

const panelOf = (id) => document.getElementById(id)

const hideSub = () => {
  if (openSub === null) return
  const panelId = openSub.getAttribute('aria-controls')
  if (panelId !== null && panelId !== '') panelOf(panelId)?.setAttribute('hidden', '')
  openSub.setAttribute('aria-expanded', 'false')
  openSub = null
}

const closeNodeMenu = () => {
  if (openMenuNode === null) return
  hideSub()
  panelOf(nodeMenuId(openMenuNode))?.setAttribute('hidden', '')
  document.getElementById(`node-more-${openMenuNode}`)?.setAttribute('aria-expanded', 'false')
  openMenuNode = null
}

const openNodeMenu = (nodeId) => {
  const panel = panelOf(nodeMenuId(nodeId))
  const trigger = document.getElementById(`node-more-${nodeId}`)
  if (panel === null || trigger === null) return
  openMenuNode = nodeId
  trigger.setAttribute('aria-expanded', 'true')
  panel.removeAttribute('hidden')
  const pos = placePanel({
    rect: trigger.getBoundingClientRect(),
    width: panel.offsetWidth,
    height: panel.offsetHeight,
    viewport: { w: window.innerWidth, h: window.innerHeight },
  })
  panel.style.left = `${pos.left}px`
  panel.style.top = `${pos.top}px`
  panel.querySelector('.menu-item')?.focus()
}

/** A main-menu item with a submenu was opened: it sticks to the right of the main menu (flips left when there is no room). */
const openSubmenu = (item) => {
  const panelId = item.getAttribute('aria-controls')
  if (panelId === null || panelId === '') return
  hideSub()
  const panel = panelOf(panelId)
  if (panel === null) return
  openSub = item
  item.setAttribute('aria-expanded', 'true')
  panel.removeAttribute('hidden')
  const pos = placeSubmenu({
    rect: item.getBoundingClientRect(),
    width: panel.offsetWidth,
    height: panel.offsetHeight,
    viewport: { w: window.innerWidth, h: window.innerHeight },
  })
  panel.style.left = `${pos.left}px`
  panel.style.top = `${pos.top}px`
  panel.querySelector('.menu-item')?.focus()
}

// Hive P5.1: node control (start/stop/restart) plus the log drawer.
const nodeAction = async (id, action) => {
  try {
    // Debt F6: one Result layer -- a failure alert reads r.detail instead of hand-building the body and status code.
    const r = await apiJson(`/api/nodes/${encodeURIComponent(id)}/${action}`, { method: 'POST' })
    if (!r.ok) alert(r.detail)
  } catch (error) {
    alert(t('common.opFailed', { message: error.message }))
  }
  await load()
}

// Capability two: version alignment = asynchronous reseed + reinstall + restart (202 means accepted).
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
  // Three-dot trigger: toggles this node's menu (the menu items are not inside #nodes-list, so they have their own delegation).
  const more = event.target.closest('.menu-trigger')
  if (more !== null) {
    const nodeId = more.id.replace(/^node-more-/, '')
    if (openMenuNode === nodeId) closeNodeMenu()
    else {
      closeNodeMenu()
      openNodeMenu(nodeId)
    }
    return
  }
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
  const access = event.target.closest('[data-node-access]')
  if (access !== null) return void openAccessEditor(access.dataset.nodeAccess)
})

// Clicks on flyout menu items: the menu hangs on body, so the delegation is on document.
// The "native access" item lives in the main menu; clicking it closes the menu before opening the editor,
// otherwise the flyout would sit on top of the drawer.
document.addEventListener('click', (event) => {
  const sub = event.target.closest('[data-node-version-menu]')
  if (sub !== null) return openSubmenu(sub)
  const set = event.target.closest('[data-node-version-set]')
  if (set !== null) {
    const owner = set.closest('.menu-panel')?.id ?? ''
    const nodeId = owner.replace(/^node-version-menu-/, '')
    closeNodeMenu()
    return void setNodeVersion(nodeId, set.dataset.nodeVersionSet ?? '')
  }
  const item = event.target.closest('.menu-panel .menu-item')
  if (item !== null) closeNodeMenu()
  // A click outside both the flyout and the trigger closes it (the trigger itself is handled by the delegation above).
  if (event.target.closest('.menu-panel') === null && event.target.closest('.menu-trigger') === null) closeNodeMenu()
})

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || openMenuNode === null) return
  const trigger = document.getElementById(`node-more-${openMenuNode}`)
  closeNodeMenu()
  trigger?.focus() // a keyboard user closing the menu belongs back on the trigger, not at the top of the document
})

// Capability two / P1: version switching -- after confirmation, POST /api/nodes/:id/version (202 = accepted,
// the rebuild and reinstall run asynchronously). The entry point moved from an always-visible dropdown to
// "three-dot menu -> version submenu"; the logic is unchanged (the same matrix data source).
const setNodeVersion = async (id, value) => {
  const followDefault = value === ''
  const target = followDefault ? (versionList[0]?.dsh ?? '') : value
  if (target === '') return
  const note = followDefault ? t('nodes.version.noteDefault') : ''
  if (!window.confirm(t('nodes.version.confirm', { id, version: target, note }))) return
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
}

$('node-logs-refresh').addEventListener('click', () => void refreshLogs())
$('node-logs-close').addEventListener('click', closeLogs)

// ---- Hive P5.5: the add-node wizard plus delete ----

const removeNode = async (id) => {
  if (!window.confirm(t('nodes.remove.confirm', { id }))) return
  try {
    // Debt F6: one Result layer.
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

// Advanced settings follow the node name live: fields never edited by hand track the name;
// fields edited by hand (dirty) stay put and only follow again once cleared. Clean fields are
// omitted on submit and the backend generates the same defaults by the same rule -- so what is
// displayed and what is stored always agree.
const advancedFields = ['f-agent-id', 'f-agent-name', 'f-agent-workspace']
const advancedDirty = new Set()
// Hive plan 2 P6: in container mode (docker runner) the default workspace is the path as the manager sees its mount
let dockerMode = false
/** Capability two / P1: matrix data source cache (used by the version dropdown on a node row). */
let versionList = []
/** Capability four (M1-7): agent id -> hostname display map (refreshed on load). */
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

  // Capability one: the host-process form means whole-machine capability, so it takes a yellow-text confirmation (same source as the node_create_host audit).
  const runner = $('f-node-runner').value
  // Capability four (M1-7): a chosen host means an agent-run remote node -- process semantics are forced and the address is required
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
  // Fleet M3-1: the third sandbox tier of an ops node means full machine access, with its own yellow-text confirmation (approval card + audit)
  if ($('f-agent-sandbox').value === 'danger-full-access' && !window.confirm(dangerSandboxConfirmText(name))) return

  // The workspace is always created; clean fields are omitted (the backend generates the same defaults from the node name).
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
    // Debt F6: one Result layer -- a create failure notice reads r.detail.
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

// ---- Capability three v1: native access configuration (SSH tunnel metadata) ----

/** @type {Record<string, { sshUser: string, sshHost: string, sshPort: number, guiPort: number, localPort: number, sshKey: string | null } | null>} */
let accessById = {}
/** @type {Record<string, string | null>} A node's native GUI address (assembled by the backend per request, token included). */
let guiUrlById = {}
/** @type {string | null} The node id currently open in the editor. */
let accessNode = null

/**
 * The "connection" section of the drawer: tunnel command plus open GUI, **computed live from the form's current values**.
 *
 * This used to sit permanently in the node row (a 330px card, one terminal command per node); once the row was
 * slimmed down it moved here -- the command and "what to use it for" side by side, which beats spilling it over the list.
 *
 * Computed from the form values rather than the saved access: you can see which command will be generated while
 * configuring, instead of saving first and coming back (a plain configuration form is filled in blind).
 */
const renderAccessConn = () => {
  const box = $('f-acc-conn')
  const user = $('f-acc-user').value.trim()
  const host = $('f-acc-host').value.trim()
  const local = Number($('f-acc-local').value)
  const gui = Number($('f-acc-gui').value)
  const sshPort = Number($('f-acc-sshport').value)
  // Only once the three required fields are there (matching the backend validation: user / host / local port) is the command offered.
  if (user === '' || host === '' || !Number.isInteger(local) || local <= 0) {
    box.hidden = true
    return
  }
  box.hidden = false
  const command = guiTunnelCommand({
    sshUser: user,
    sshHost: host,
    sshPort: Number.isInteger(sshPort) && sshPort > 0 ? sshPort : 22,
    guiPort: Number.isInteger(gui) && gui > 0 ? gui : 3080,
    localPort: local,
    sshKey: $('f-acc-key').value.trim(),
  })
  $('f-acc-cmd').textContent = command
  const url = accessNode === null ? null : (guiUrlById[accessNode] ?? null)
  $('f-acc-open').disabled = url === null
  $('f-acc-conn-hint').textContent = url === null ? t('gui.notReady') : t('gui.tunnelHint')
}

// Any change to a form field recomputes the command (what you type is what you see, no saving first).
for (const id of ['f-acc-user', 'f-acc-host', 'f-acc-sshport', 'f-acc-gui', 'f-acc-local', 'f-acc-key']) {
  $(id).addEventListener('input', () => renderAccessConn())
}

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
  renderAccessConn()
  $('node-access-editor').hidden = false
  $('f-acc-user').focus()
}

$('f-acc-copy').addEventListener('click', () => {
  const command = $('f-acc-cmd').textContent ?? ''
  navigator.clipboard
    ?.writeText(command)
    .then(() => alert(t('nodes.tunnel.copied')))
    .catch(() => alert(t('nodes.tunnel.copyFailed', { command })))
})

$('f-acc-open').addEventListener('click', () => {
  const url = accessNode === null ? null : (guiUrlById[accessNode] ?? null)
  if (url !== null) window.open(url, '_blank', 'noopener')
})

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

// ---- Capability four (M1-7): machine directory ----
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
  // UI wrap-up C-P1.5: clicking the local row jumps to the "all nodes" section (the local machine has no agent-only actions).
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

// ---- UI wrap-up C-P1: cluster topology (view switching + edge drawing + card navigation) ----
let revokedCount = 0
let topoState = { managerVersion: '', origin: window.location.origin, containerForm: false, machines: [], nodes: [], localHost: null }

const VIEW_KEY = 'nodes-view'

/** Fold button text (the count follows the number of machines; no Chinese string replacement). */
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
  // C-P1.5: the local card is rendered only when some node has an empty host (local nodes start from the local card).
  const hasLocal = topoState.nodes.some((n) => typeof n.host !== 'string' || n.host === '')
  drawTopoEdges(container, edgePairs(topoState.machines, topoState.nodes, hasLocal))
}

const renderTopo = () => {
  // Keep the user's expanded "offline / revoked" fold state across polling redraws.
  const prev = document.querySelector('#topology details.topo-fold')
  const wasOpen = prev !== null && prev.open
  setHtml('topology', topologyHtml(topoState))
  const next = document.querySelector('#topology details.topo-fold')
  if (wasOpen && next !== null) next.open = true
  redrawTopo()
}

// ── Three views (DAC v1.0.0): topology / nodes / machines ────────────────────────
const VIEWS = ['topo', 'nodes', 'machines']
const VIEW_PANELS = { topo: 'topology-section', nodes: 'nodes-view', machines: 'machines-view' }
const VIEW_BUTTONS = { topo: 'view-topo', nodes: 'view-nodes', machines: 'view-machines' }

const setView = (view) => {
  // The old preference ('list') maps to the node view, so an upgrade does not land on an empty view.
  const active = VIEWS.includes(view) ? view : view === 'list' ? 'nodes' : 'topo'
  for (const name of VIEWS) {
    $(VIEW_PANELS[name]).hidden = name !== active
    $(VIEW_BUTTONS[name]).classList.toggle('on', name === active)
  }
  try {
    localStorage.setItem(VIEW_KEY, active)
  } catch {
    // Storage failures such as private mode are ignored -- the preference is simply not remembered, which does not affect use.
  }
  if (active === 'topo') redrawTopo()
  return active
}

for (const name of VIEWS) $(VIEW_BUTTONS[name]).addEventListener('click', () => setView(name))

// Clicking a topology card jumps to the matching view and focuses that row (a revoked fold is expanded before focusing).
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

// ── Drawers (add-node wizard / native access configuration): background click and Esc close them ─────────
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

// Default to the topology view (the fleet at a glance is the most informative); once the user switches, remember the preference.
let savedView = 'topo'
try {
  savedView = localStorage.getItem(VIEW_KEY) ?? 'topo'
} catch {
  savedView = 'topo'
}
setView(savedView)

const load = async () => {
  try {
    // Debt F6: one Result layer.
    const [nodesResult, agentsResult] = await Promise.all([apiJson('/api/nodes'), apiJson('/api/agents')])
    if (!nodesResult.ok) return
    const { nodes, dockerMode: isDocker, supportedDsh, containerForm, hostOs, hostArch, hostName, hostNodeVersion } = nodesResult.data
    dockerMode = isDocker === true
    if (Array.isArray(supportedDsh)) versionList = supportedDsh
    // Capability four (M1-7/M4-3/UI wrap-up B): the machine directory plus the host dropdown, the node-row
    // hostname map and the update-pending badge; revoked machines are folded by default (expandable, with record deletion).
    if (agentsResult.ok && Array.isArray(agentsResult.data.agents)) {
      const machines = agentsResult.data.agents
      const managerVersion = agentsResult.data.managerVersion
      agentHostnames = new Map(machines.map((m) => [m.id, m.hostname]))
      const active = machines.filter((m) => !m.revoked)
      const revoked = machines.filter((m) => m.revoked)
      revokedCount = revoked.length
      // UI wrap-up C-P1.5: the first row of the machine list is the local machine (a pure UI projection, never written to agent_machine).
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
      // UI wrap-up C-P1: the cluster topology data frame (the frontend aggregates /api/nodes + /api/agents
      // only, it does not start a second truth; SVG edges are drawn only while the topology view is visible).
      // managerVersion is injected on the same basis as the list rows, otherwise the "update pending" badge
      // would never light up in the topology.
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
    // A container-form deployment (manager inside a container) does not support host-process nodes -- the
    // wizard disables that option and rewrites its text; bare-metal deployments (including a mixed
    // docker.sock deployment) are unaffected.
    const processOpt = $('f-node-runner').querySelector('option[value="process"]')
    if (processOpt !== null) {
      processOpt.disabled = containerForm === true
      processOpt.textContent = containerForm === true ? t('nodes.form.runnerProcessDisabled') : t('nodes.form.runnerProcess')
    }
    // Capability two: the version dropdown is the matrix data source (filled once, never repeated)
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
    // Capability three v1: access truth cache (for editor prefill) plus GUI address cache (for the connection section)
    accessById = Object.fromEntries(nodes.map((n) => [n.id, n.access ?? null]))
    guiUrlById = Object.fromEntries(nodes.map((n) => [n.id, typeof n.guiUrl === 'string' && n.guiUrl !== '' ? n.guiUrl : null]))
    const live = nodes.filter((n) => n.state === 'live').length
    const abnormal = nodes.filter((n) => n.state !== 'live').length
    $('nodes-count').textContent =
      abnormal > 0
        ? t('nodes.countAbnormal', { live, total: nodes.length, abnormal })
        : t('nodes.count', { live, total: nodes.length })
    renderNodes(nodes)

    $('nodes-refresh').textContent = t('nodes.refreshAt', { time: new Date().toLocaleTimeString(undefined, { hour12: false }) })
  } catch {
    // Keep the previous frame on a network failure rather than repainting an error page.
  }
}

void load()
poll(() => void load(), 15_000)
