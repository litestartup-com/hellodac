// @ts-check
// UI slimming (DAC v1.0.0): a node row and its three-dot overflow menu -- pure function layer, DOM
// assembly stays in nodes.js. Unit-testable (node-row.test.mjs), the same division of labour as
// node-form.js and machines.js: anything assertable does not live in a DOM file.
//
// The evidence behind this slimming (measured before the change): one row packed four blocks side by
// side -- title plus two warning pills, meta (managed/pid/lastError), detail (agent/image/DSH version/
// pin/host plus an always-visible version dropdown), up to five action buttons, and a fixed 330px
// "native GUI" card containing a whole SSH tunnel command. Most of the row's pixels went to rarely used
// actions while "which node is alive" was squeezed into a corner.
//
// After slimming the main row is status, ID, ownership and the current version; everything else is in the menu.
import { esc, t } from './ui.js'
import { nodeMenuItems, versionMenuItems, menuPanelHtml, menuItemHtml, triggerButtonHtml } from './menu.js'

/** Status dot classes. live/offline are bare protocol words and are not translated. */
export const NODE_STATE_DOT = { live: 'ok', cold: 'muted', starting: 'warn', restarting: 'warn', offline: 'bad' }

/**
 * Status wording: looked up explicitly rather than by building a key from a template.
 *
 * Building `t(`nodes.state.${state}`)` works at runtime, but the key guard (scripts/check-i18n-keys.mjs)
 * only sees literals: a built key counts as unreferenced, so a missing translation for it would never be
 * noticed. A few hardcoded lines buy a guard that actually holds.
 */
const STATE_LABEL = {
  cold: () => t('nodes.state.cold'),
  starting: () => t('nodes.state.starting'),
  restarting: () => t('nodes.state.restarting'),
}

/** @param {string} state @returns {string} */
export const nodeStateLabel = (state) => (state === 'live' || state === 'offline' ? state : (STATE_LABEL[state]?.() ?? state))

/** DOM ids of the flyouts (one for the node row menu, one for the version submenu). */
export const nodeMenuId = (id) => `node-menu-${id}`
export const nodeVersionMenuId = (id) => `node-version-menu-${id}`

/**
 * Human-readable string for the current DSH version; container form prefers the image tag (the tag is the
 * version). With no version information at all: null, so the section is not rendered as an empty placeholder.
 * @param {{ image?: unknown, dshVersion?: unknown }} n
 * @returns {string | null}
 */
export const nodeVersionText = (n) => {
  if (typeof n.image === 'string' && n.image !== '') return n.image
  if (typeof n.dshVersion === 'string' && n.dshVersion !== '') return `DSH ${n.dshVersion}`
  return null
}

/**
 * Node row.
 * @param {object} n one row from /api/nodes
 * @param {(host: string) => string} hostName host id -> hostname (unknown falls back to the id)
 * @returns {string}
 */
export const nodeRow = (n, hostName) => {
  const dot = NODE_STATE_DOT[n.state] ?? 'muted'
  const label = nodeStateLabel(n.state)
  const agents = Array.isArray(n.agents) && n.agents.length > 0 ? n.agents.join(' / ') : null
  const version = nodeVersionText(n)
  // Ownership: the agent list and its host machine (across machines, "where is it" is key information, so it stays on the main row).
  const owner = [agents, typeof n.host === 'string' && n.host !== '' ? hostName(n.host) : null].filter((x) => x !== null).join(' · ')
  // Warnings have to be visible at a glance, so they stay on the row (that is the whole point of the summary, not something for a menu).
  const versionWarn =
    typeof n.dshVersion === 'string' && n.dshVersion !== '' && n.dshCompatible === false
      ? `<span class="pill-mini warn" title="${esc(t('nodes.versionWarnTitle', { version: n.dshVersion }))}">${esc(t('nodes.versionWarn'))}</span>`
      : ''
  const driftWarn =
    n.dshDrift === true ? `<span class="pill-mini warn" title="${esc(t('nodes.driftWarnTitle'))}">${esc(t('nodes.driftWarn'))}</span>` : ''
  // Errors stay visible but are compressed to one line with the full text on hover: troubleshooting needs them immediately, and they must not stretch the row.
  const err =
    typeof n.lastError === 'string' && n.lastError !== ''
      ? `<div class="node-err" title="${esc(n.lastError)}">${esc(n.lastError)}</div>`
      : ''
  const trigger = triggerButtonHtml({ id: `node-more-${n.id}`, label: t('common.more'), controls: nodeMenuId(n.id) })
  return `<div class="node-row" data-node-row="${esc(n.id)}">
    <div class="node-main">
      <div class="node-title"><span class="dot ${dot}"></span>${esc(n.id)} <span class="node-state">${esc(label)}</span> ${versionWarn} ${driftWarn}</div>
      ${owner === '' ? '' : `<div class="node-sub">${esc(owner)}</div>`}
      ${err}
    </div>
    ${version === null ? '' : `<div class="node-ver" title="${esc(t('nodes.currentVersion'))}">${esc(version)}</div>`}
    ${trigger}
  </div>`
}

/**
 * The node row's flyouts (main menu plus version submenu), appended to body.
 *
 * Both flyouts are created up front and stay in the DOM, only positioned and shown when opened -- rebuilding
 * them on every click would drop focus and kick keyboard users back to the top of the document each time.
 * @param {object} n
 * @param {Array<{ dsh: string, status: string }>} versionList
 * @returns {string}
 */
export const nodeMenuHtml = (n, versionList) => {
  const items = nodeMenuItems({
    id: n.id,
    state: n.state,
    managed: n.managed === true,
    dshDrift: n.dshDrift === true,
    pinnedVersion: typeof n.configuredDshVersion === 'string' ? n.configuredDshVersion : null,
    hasVersions: Array.isArray(versionList) && versionList.length > 0,
    versionMenuId: nodeVersionMenuId(n.id),
  })
  // Native GUI: this used to be an always-visible 330px card holding a whole SSH tunnel command. The tunnel
  // command, opening and configuring all live in the "native access" editor, so the menu keeps one entry point
  // instead of a second copy.
  items.push(menuItemHtml({ label: t('nodes.access.title'), attrs: `data-node-access="${esc(n.id)}"` }))
  const main = menuPanelHtml({ id: nodeMenuId(n.id), label: t('common.more'), items })
  const sub = menuPanelHtml({
    id: nodeVersionMenuId(n.id),
    label: t('nodes.action.version'),
    items: versionMenuItems(versionList, n.configuredDshVersion),
    modifier: 'menu-sub',
  })
  return main + sub
}
