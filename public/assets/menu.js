// @ts-check
// Generic flyout menu primitives (DAC v1.0.0 UI slimming): the pure function layer behind the overflow
// menu (the three-dot button) and its submenus.
//
// Why the layer exists: node rows and the language/about entries at the bottom of a drawer all share the
// shape "one trigger row -> open a column of items -> one item expands a second level". Each site used to
// write its own flyout and positioning, so looks and behaviour drifted apart; here "how a row is drawn",
// "how a menu is ordered" and "where a flyout is placed" are three pure functions, while DOM assembly and
// event binding stay in the pages (unit-testable: menu.test.mjs).
//
// Positioning constraints (measured the hard way; do not reach for CSS absolute):
//   node rows and drawers live inside containers that clip, scroll or transform (.card rounds its corners,
//   drawers apply a transform), so an absolute submenu gets clipped. Flyouts are therefore always
//   position: fixed and appended to body, with coordinates derived in JS from the trigger rect and clamped.
import { esc, t } from './ui.js'

/** Trigger button: the standard shape of a three-dot overflow menu (icon button, marked when expanded). */
export const triggerButtonHtml = ({ id, label, controls }) =>
  `<button type="button" class="icon-btn menu-trigger" id="${esc(id)}" aria-haspopup="true" aria-expanded="false" aria-controls="${esc(controls)}" title="${esc(label)}" aria-label="${esc(label)}"><svg width="16" height="16" aria-hidden="true"><use href="#i-more-v" /></svg></button>`

/**
 * One menu item row.
 *
 * The icon is **optional** and only rendered when the caller explicitly provides one: node actions have no
 * corresponding semantic icon (the icon set has no stop/restart/tag), and forcing one would express the
 * wrong meaning -- those items stay text-only; sidebar navigation items do have conventional icons
 * (spark/archive/coin/shield/pencil) and would become unrecognisable without them.
 *
 * **Items with an href render as `<a>`, everything else as `<button>`** (measured incident 2026-09-25):
 * this used to always return `<button>` while callers passed `href` as an attribute -- `<button href>` is
 * not a valid attribute, so clicking did nothing. The symptom was "the language picker does not react",
 * and the whole Skills/Cost/... navigation column at the bottom was dead the same way. Navigation items
 * should be links (middle-click, copyable address, announced as links by screen readers); actions buttons.
 * @param {{ kind?: 'item' | 'submenu' | 'danger' | 'sep' | 'note' | 'group', label?: string, icon?: string | null, attrs?: string, trailing?: string | null }} spec
 * @returns {string}
 */
export const menuItemHtml = (spec) => {
  const kind = spec.kind ?? 'item'
  const attrs = typeof spec.attrs === 'string' ? ` ${spec.attrs}` : ''
  if (kind === 'sep') return '<div class="menu-sep" role="separator"></div>'
  // note/group must pass attrs through as well (incident 2026-09-26: the data-about-version marker used
  // to backfill the version was silently dropped -> querySelector never matched -> the version never showed).
  if (kind === 'group') return `<div class="menu-group"${attrs}>${esc(spec.label ?? '')}</div>`
  if (kind === 'note') return `<div class="menu-note"${attrs}>${esc(spec.label ?? '')}</div>`
  const cls = kind === 'danger' ? ' class="menu-item danger"' : ' class="menu-item"'
  /**
   * Two icon forms:
   *   icon: 'spark'      -> sprite icon <use href="#i-spark"> (the same glyphs as the sidebar)
   *   icon: { raw: svg } -> inline SVG (for glyphs the sprite lacks, such as the envelope: adding one
   *                        to the sprite means editing layout.html and restarting; inline does not)
   */
  const icon =
    spec.icon === null || spec.icon === undefined || spec.icon === ''
      ? ''
      : typeof spec.icon === 'string'
        ? `<svg width="14" height="14" aria-hidden="true"><use href="#i-${esc(spec.icon)}" /></svg>`
        : `${String(spec.icon.raw ?? '')}`
  const trailing = typeof spec.trailing === 'string' && spec.trailing !== '' ? `<span class="menu-trailing">${esc(spec.trailing)}</span>` : ''
  const isLink = /\bhref\s*=/.test(attrs)
  // Submenu/flyout triggers are marked with aria-haspopup (to tell them apart from plain items).
  const popup = kind === 'submenu' ? ' aria-haspopup="true" aria-expanded="false"' : ''
  const tag = isLink ? 'a' : 'button'
  const typeAttr = isLink ? '' : ' type="button"'
  const role = isLink ? ' role="menuitem"' : ''
  return `<${tag}${typeAttr}${cls}${popup}${role}${attrs}><span class="menu-grow">${icon}${esc(spec.label ?? '')}</span>${trailing}${kind === 'submenu' ? '<span class="menu-chevron" aria-hidden="true">›</span>' : ''}</${tag}>`
}

/**
 * One flyout menu panel.
 * @param {{ id: string, label: string, items: string[], modifier?: string, hidden?: boolean, side?: boolean }} spec
 * @returns {string}
 */
export const menuPanelHtml = (spec) => {
  const mod = typeof spec.modifier === 'string' && spec.modifier !== '' ? ` ${spec.modifier}` : ''
  const side = spec.side === true ? ' data-side="1"' : ''
  const hidden = spec.hidden === false ? '' : ' hidden'
  return `<div class="menu-panel${mod}" id="${esc(spec.id)}" role="menu" aria-label="${esc(spec.label)}"${side}${hidden}>${spec.items.join('')}</div>`
}

/**
 * Flyout horizontal/vertical coordinates: first try right-aligning to the trigger's right edge, then clamp
 * inside the viewport. The return value is CSS, written straight into style by the caller.
 * @param {{ rect: { top: number, right: number, bottom: number, left: number }, width: number, height: number, viewport: { w: number, h: number }, gap?: number }} p
 * @returns {{ left: number, top: number, side: 'left' | 'right' }}
 */
export const placePanel = ({ rect, width, height, viewport, gap = 8 }) => {
  // Prefer right alignment (the three-dot button sits at the right end of its owner); overflow flips it to left alignment, and still overflowing means pinning it to the edge.
  let left = rect.right - width
  let side = 'left'
  if (left < gap) {
    left = rect.left
    side = 'right'
  }
  if (left + width > viewport.w - gap) left = Math.max(gap, viewport.w - width - gap)
  // Vertically: open below the trigger by default; when there is no room below and more room above, flip up.
  let top = rect.bottom + 6
  if (top + height > viewport.h - gap && rect.top - height - 6 >= gap) top = rect.top - height - 6
  if (top + height > viewport.h - gap) top = Math.max(gap, viewport.h - height - gap)
  return { left: Math.round(left), top: Math.round(top), side }
}

/**
 * Submenu anchor: the right edge of the parent item -> the left edge of the submenu; flip left when it does not fit.
 * @param {{ rect: { top: number, right: number, left: number, bottom: number }, width: number, height: number, viewport: { w: number, h: number }, gap?: number }} p
 * @returns {{ left: number, top: number }}
 */
export const placeSubmenu = ({ rect, width, height, viewport, gap = 6 }) => {
  let left = rect.right + gap
  if (left + width > viewport.w - 8) left = Math.max(8, rect.left - width - gap)
  let top = rect.top
  if (top + height > viewport.h - 8) top = Math.max(8, viewport.h - height - 8)
  return { left: Math.round(left), top: Math.round(top) }
}

/**
 * The three-dot menu items of a node row (pure data -> HTML).
 *
 * Why all of this moved into a menu: the row used to show up to five buttons plus a version dropdown plus
 * a 330px native GUI card (containing an entire SSH command), squeezing the one thing that should be visible
 * at a glance -- which node is alive -- into a corner. With the low-frequency actions in a menu, the main
 * row keeps only status, ID, ownership and the current version.
 *
 * @param {{ id: string, state: string, managed: boolean, dshDrift?: boolean, pinnedVersion?: string | null, hasVersions?: boolean }} n
 * @returns {string[]}
 */
export const nodeMenuItems = (n) => {
  const id = esc(n.id)
  const disabled = n.state === 'starting' ? ' disabled' : ''
  const items = []
  if (!n.managed) {
    // For an externally managed node the manager does not own the lifecycle, so it only offers logs and native access.
    items.push(menuItemHtml({ kind: 'note', label: t('nodes.externalManual') }))
  } else if (n.state === 'cold' || n.state === 'offline') {
    items.push(menuItemHtml({ label: t('nodes.action.start'), attrs: `data-node-up="${id}"` }))
  } else {
    items.push(menuItemHtml({ label: t('nodes.action.stop'), attrs: `data-node-down="${id}"${disabled}` }))
    items.push(menuItemHtml({ label: t('nodes.action.restart'), attrs: `data-node-restart="${id}"${disabled}` }))
  }
  items.push(menuItemHtml({ kind: 'sep' }))
  // Version switching: used to be an always-visible dropdown, now a submenu (a rare action does not deserve permanent space).
  if (n.managed && n.hasVersions === true) {
    const pinned = typeof n.pinnedVersion === 'string' && n.pinnedVersion !== '' ? n.pinnedVersion : null
    items.push(
      menuItemHtml({
        kind: 'submenu',
        label: t('nodes.action.version'),
        trailing: pinned ?? t('nodes.version.default'),
        // Carry the id of the panel it controls, so opening the submenu can use it directly instead of deriving it from the node id.
        attrs: `data-node-version-menu="${id}" aria-controls="${esc(n.versionMenuId ?? '')}"`,
      }),
    )
  }
  // Alignment only appears when it really drifted (it used to be a conditional button living in the always-visible area).
  if (n.dshDrift === true) items.push(menuItemHtml({ label: t('nodes.action.align'), attrs: `data-node-align="${id}"` }))
  items.push(menuItemHtml({ label: t('nodes.action.logs'), attrs: `data-node-logs="${id}"` }))
  if (n.managed) {
    items.push(menuItemHtml({ kind: 'sep' }))
    items.push(menuItemHtml({ kind: 'danger', label: t('nodes.action.remove'), attrs: `data-node-rm="${id}"` }))
  }
  return items
}

/**
 * Options for the version submenu: the data source is exactly the old dropdown's (the supportedDsh matrix
 * from GET /api/nodes; the frontend never hardcodes a version list), only rendered as clickable items -- a
 * native <select> inside a flyout gets the styling and keyboard behaviour wrong, hence menu items instead.
 * @param {Array<{ dsh: string, status: string }>} list
 * @param {string | null | undefined} current currently pinned version (null/empty = follow the default)
 * @returns {string[]}
 */
export const versionMenuItems = (list, current) => {
  const cur = typeof current === 'string' && current !== '' ? current : ''
  const follow = menuItemHtml({
    label: t('nodes.form.versionFollowDefault'),
    attrs: 'data-node-version-set=""',
    trailing: cur === '' ? '✓' : null,
  })
  const opts = (Array.isArray(list) ? list : []).map((v) =>
    menuItemHtml({
      label: v.status === 'pending' ? t('nodes.version.pending', { version: v.dsh }) : v.dsh,
      attrs: `data-node-version-set="${esc(v.dsh)}"`,
      trailing: v.dsh === cur ? '✓' : null,
    }),
  )
  return [follow, ...opts]
}
