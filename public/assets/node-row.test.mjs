import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nodeRow, nodeMenuHtml, nodeMenuId, nodeVersionMenuId, nodeVersionText, nodeStateLabel } from './node-row.js'
import { placePanel, placeSubmenu, menuPanelHtml, menuItemHtml, triggerButtonHtml } from './menu.js'

import { useTestDictionary, testDictionary } from './test-i18n.mjs'

useTestDictionary('en')
const DICT = testDictionary('en')

/**
 * UI slimming (DAC v1.0.0) regression: a node row keeps only `which node is alive and what it runs`; the rest moves into the ⋮ menu.
 *
 * As measured before the change: one row had 4 horizontal blocks (title + 2 alert pills / meta / detail
 * + an always-visible version dropdown / up to 5 action buttons), plus a fixed 330px native GUI card
 * (including the whole SSH tunnel command). These assertions pin down `what must not be always visible` --
 * otherwise the next refactor quietly spreads it back into the row.
 */

const NODE = {
  id: 'ops33',
  state: 'live',
  managed: true,
  agents: ['personal', 'brain'],
  host: 'agent-abc123',
  dshVersion: '0.1.5-rc.2',
  dshCompatible: true,
  image: null,
  pid: 4242,
  lastError: null,
  configuredDshVersion: null,
}
const VERSIONS = [
  { dsh: '0.1.5-rc.2', status: 'verified' },
  { dsh: '0.1.2-rc.1', status: 'pending' },
]

const hostName = (h) => (h === 'agent-abc123' ? 'ubuntu-focal' : h)

test('UI slimming: a node row always shows only state/ID/ownership/version + one ⋮ trigger', () => {
  const html = nodeRow(NODE, hostName)
  assert.ok(html.includes('ops33'), 'the node ID is there')
  assert.ok(html.includes('live'), 'the state is there')
  assert.ok(html.includes('personal / brain'), 'the agent ownership is there')
  assert.ok(html.includes('ubuntu-focal'), 'the hostname is there (key information across machines)')
  assert.ok(html.includes('DSH 0.1.5-rc.2'), 'the current version is there')
  assert.ok(html.includes('menu-trigger'), 'there is a ⋮ trigger')
  assert.ok(html.includes(`aria-controls="${nodeMenuId('ops33')}"`), 'the trigger declares which flyout it controls')
})

test('UI slimming: the action buttons, the version dropdown and the GUI card are no longer always visible in the row', () => {
  const html = nodeRow(NODE, hostName)
  // These all used to be always-visible inline elements -- now they must live in the menu and never come back.
  assert.ok(!html.includes('data-node-down'), 'the stop button is not in the row')
  assert.ok(!html.includes('data-node-restart'), 'the restart button is not in the row')
  assert.ok(!html.includes('data-node-logs'), 'the logs button is not in the row')
  assert.ok(!html.includes('data-node-rm'), 'the remove button is not in the row')
  assert.ok(!html.includes('<select'), 'the version dropdown is not in the row')
  assert.ok(!html.includes('ssh -N'), 'the tunnel command is not in the row')
  assert.ok(!html.includes('node-gui'), 'the GUI card is not in the row')
  assert.ok(!html.includes('node-actions'), 'the action bar is not in the row')
})

test('UI slimming: alerts stay always visible (an anomaly must be seen at a glance, not hidden in a menu)', () => {
  const drift = nodeRow({ ...NODE, dshDrift: true }, hostName)
  assert.ok(drift.includes('pill-mini warn'), 'the drift alert stays always visible')
  const mismatch = nodeRow({ ...NODE, dshCompatible: false }, hostName)
  assert.ok(mismatch.includes('pill-mini warn'), 'the version-mismatch alert stays always visible')
})

test('UI slimming: an error is squeezed onto one line and can be hovered for the full text (visible without stretching the row)', () => {
  const long = 'E'.repeat(400)
  const html = nodeRow({ ...NODE, lastError: long }, hostName)
  assert.ok(html.includes('node-err'), 'the error has its own style')
  assert.ok(html.includes(`title="${long}"`), 'the full text goes into the tooltip')
  assert.ok(!html.includes('<select'), 'an error does not add another control')
})

test('UI slimming: the lifecycle entries follow the state -- cold/offline offers start, running offers stop + restart', () => {
  const cold = nodeMenuHtml({ ...NODE, state: 'cold' }, VERSIONS)
  assert.ok(cold.includes('data-node-up="ops33"'), 'cold offers start')
  assert.ok(!cold.includes('data-node-down'), 'cold does not offer stop')

  const live = nodeMenuHtml(NODE, VERSIONS)
  assert.ok(live.includes('data-node-down="ops33"'), 'running offers stop')
  assert.ok(live.includes('data-node-restart="ops33"'), 'running offers restart')
  assert.ok(!live.includes('data-node-up'), 'running does not offer start')
})

test('UI slimming: realign appears only on a real drift; remove always carries the danger style', () => {
  const noDrift = nodeMenuHtml(NODE, VERSIONS)
  assert.ok(!noDrift.includes('data-node-align'), 'no drift means no align entry')
  const drift = nodeMenuHtml({ ...NODE, dshDrift: true }, VERSIONS)
  assert.ok(drift.includes('data-node-align="ops33"'), 'a drift offers realign')
  assert.ok(drift.includes('menu-item danger'), 'remove is a danger entry (red text)')
})

test('UI slimming: the version submenu shares its source with the old dropdown, marks the current entry and includes `follow the default`', () => {
  const html = nodeMenuHtml({ ...NODE, configuredDshVersion: '0.1.2-rc.1' }, VERSIONS)
  assert.ok(html.includes(`id="${nodeVersionMenuId('ops33')}"`), 'the version submenu panel is there')
  assert.ok(html.includes('data-node-version-set=""'), 'there is a `follow the default` entry')
  assert.ok(html.includes('data-node-version-set="0.1.5-rc.2"'), 'every version in the matrix is there')
  assert.ok(html.includes('(unverified)'), 'a pending version carries the unverified marker (the same wording as the dropdown)')
  // The current pin is 0.1.2-rc.1 -> that entry carries ✓
  const checked = html.split('data-node-version-set="0.1.2-rc.1"')[1] ?? ''
  assert.ok(checked.includes('✓'), 'the current version carries a check mark')
})

test('UI slimming: an unwired manager (no agentCommand and such) still gets a ⋮ menu, without an error', () => {
  const html = nodeMenuHtml({ ...NODE, state: 'starting' }, [])
  assert.ok(html.includes('menu-panel'), 'the panel still renders')
  assert.ok(html.includes('disabled'), 'the lifecycle entries are disabled while starting')
})

test('UI slimming: an unmanaged node gets no lifecycle operations, only logs and native access', () => {
  const html = nodeMenuHtml({ ...NODE, managed: false }, VERSIONS)
  assert.ok(!html.includes('data-node-down'), 'unmanaged does not offer stop')
  assert.ok(!html.includes('data-node-version-menu'), 'unmanaged does not offer a version switch')
  assert.ok(!html.includes('data-node-rm'), 'unmanaged does not offer remove')
  assert.ok(html.includes('data-node-logs="ops33"'), 'unmanaged still has logs')
  assert.ok(html.includes('data-node-access="ops33"'), 'unmanaged still has native access')
})

test('UI slimming: the row always offers a `native access` entry (the landing point of the GUI command)', () => {
  const html = nodeMenuHtml(NODE, VERSIONS)
  assert.ok(html.includes('data-node-access="ops33"'), 'the menu has a native access entry')
})

test('UI slimming: the version wording -- a container prefers the image tag, then the DSH version, and null when there is neither', () => {
  assert.equal(nodeVersionText({ image: 'hellodac/dac-node:0.1.5-rc.2', dshVersion: '0.1.5-rc.2' }), 'hellodac/dac-node:0.1.5-rc.2')
  assert.equal(nodeVersionText({ image: null, dshVersion: '0.1.5-rc.2' }), 'DSH 0.1.5-rc.2')
  assert.equal(nodeVersionText({ image: '', dshVersion: '' }), null)
})

test('UI slimming: the state wording -- live/offline are raw protocol words and are not translated, the rest goes through the dictionary', () => {
  assert.equal(nodeStateLabel('live'), 'live')
  assert.equal(nodeStateLabel('offline'), 'offline')
  assert.equal(nodeStateLabel('cold'), DICT['nodes.state.cold'])
})

// ---- Flyout placement (pure functions): out-of-bounds clamping ----

test('flyout placement: right alignment first, left alignment when there is no room on the left, and against the edge when the right overflows', () => {
  const viewport = { w: 1000, h: 800 }
  const wide = { top: 100, right: 900, bottom: 120, left: 876 }
  assert.deepEqual(placePanel({ rect: wide, width: 200, height: 300, viewport }), { left: 700, top: 126, side: 'left' })

  // Near the left edge: right alignment would compute a negative number -> switch to left alignment
  const leftish = { top: 100, right: 120, bottom: 120, left: 96 }
  const placed = placePanel({ rect: leftish, width: 200, height: 300, viewport })
  assert.equal(placed.side, 'right')
  assert.equal(placed.left, 96)
})

test('flyout placement: flips above the trigger when there is no room below and more room above', () => {
  const viewport = { w: 1000, h: 400 }
  const nearBottom = { top: 300, right: 500, bottom: 320, left: 476 }
  const placed = placePanel({ rect: nearBottom, width: 200, height: 200, viewport })
  assert.ok(placed.top + 200 <= viewport.h, 'it does not overflow the bottom of the viewport')
  assert.ok(placed.top < nearBottom.top, 'it flipped above')
})

test('flyout placement: a submenu hugs the right side of the main menu and flips to the left when there is no room', () => {
  const viewport = { w: 1000, h: 800 }
  const item = { top: 200, right: 400, bottom: 226, left: 100 }
  assert.equal(placeSubmenu({ rect: item, width: 200, height: 120, viewport }).left, 406)

  const nearRight = { top: 200, right: 980, bottom: 226, left: 700 }
  const flipped = placeSubmenu({ rect: nearRight, width: 200, height: 120, viewport })
  assert.ok(flipped.left + 200 <= viewport.w, 'after flipping left it stays in bounds')
  assert.ok(flipped.left < nearRight.left, 'it really is on the left')
})

test('flyout placement: a submenu near the bottom of the viewport moves up instead of overflowing', () => {
  const viewport = { w: 1000, h: 300 }
  const item = { top: 280, right: 400, bottom: 300, left: 100 }
  const placed = placeSubmenu({ rect: item, width: 200, height: 200, viewport })
  assert.ok(placed.top + 200 <= viewport.h, 'no overflow')
})

// ---- Menu primitives ----

test('menu primitives: separators, group headings and note rows each do their own job', () => {
  assert.ok(menuItemHtml({ kind: 'sep' }).includes('menu-sep'))
  assert.ok(menuItemHtml({ kind: 'group', label: 'G' }).includes('menu-group'))
  assert.ok(menuItemHtml({ kind: 'note', label: 'N' }).includes('menu-note'))
})

test('menu primitives: a submenu entry carries aria-haspopup and a chevron, an ordinary entry does not', () => {
  const sub = menuItemHtml({ kind: 'submenu', label: 'Version' })
  assert.ok(sub.includes('aria-haspopup="true"'), 'it is marked expandable')
  assert.ok(sub.includes('menu-chevron'), 'it has a pointing arrow')
  const plain = menuItemHtml({ label: 'Logs' })
  assert.ok(!plain.includes('aria-haspopup'), 'an ordinary entry is not marked expandable')
})

test('menu primitives: a danger entry carries the danger class; labels are always escaped', () => {
  assert.ok(menuItemHtml({ kind: 'danger', label: 'Delete' }).includes('menu-item danger'))
  assert.ok(menuItemHtml({ label: '<img src=x>' }).includes('&lt;img'), 'the label is escaped')
})

test('menu primitives: the trigger is hidden by default, so it never flashes before it is positioned', () => {
  assert.ok(menuPanelHtml({ id: 'p', label: 'L', items: [] }).includes('hidden'))
  assert.ok(!menuPanelHtml({ id: 'p', label: 'L', items: [], hidden: false }).includes('hidden'))
  assert.ok(triggerButtonHtml({ id: 't', label: 'More', controls: 'p' }).includes('aria-expanded="false"'))
})

// ---- Icons (user feedback: a flyout item should have an svg icon, it looks worse without one) ----

test('menu primitives: an icon is rendered only when one is given -- navigation entries have icons, node action entries stay plain text', () => {
  const withIcon = menuItemHtml({ label: 'Skills', icon: 'spark' })
  assert.ok(withIcon.includes('<use href="#i-spark" />'), 'a navigation entry renders its icon')
  assert.ok(withIcon.includes('Skills'), 'the text is unchanged')

  // A node action entry has no matching semantic icon (the icon set has no stop/restart/tag), and without
  // an icon it must not gain a stray svg -- that would use the wrong icon to say the wrong thing.
  const plain = menuItemHtml({ label: 'Stop' })
  assert.ok(!plain.includes('<svg'), 'no icon given means no svg is rendered')
})

test('menu primitives: the icon name and the text are both escaped, injection is not accepted', () => {
  const evil = menuItemHtml({ label: 'x', icon: '"><script>' })
  assert.ok(!evil.includes('<script>'), 'the icon name cannot escape the attribute')
  assert.ok(evil.includes('&quot;'), 'the quotes are escaped')
})

// ---- A link entry must be a real link (the true cause of the 2026-09-25 report that `clicking the language does nothing`) ----

test('Incident regression: a menu entry with an href must render as <a>, not <button>', () => {
  const link = menuItemHtml({ label: '中文', attrs: 'href="?lang=zh-CN"' })
  assert.ok(link.startsWith('<a '), `an entry with an href must be a link, actual start: ${link.slice(0, 40)}`)
  assert.ok(link.includes('href="?lang=zh-CN"'), 'the href is kept')
  assert.ok(!link.includes('<button'), 'it must not be a button -- an href on a button is an invalid attribute and a click does nothing')
})

test('Incident regression: an entry without an href is still a <button> (an action, not navigation)', () => {
  const action = menuItemHtml({ label: 'Stop', attrs: 'data-node-down="x"' })
  assert.ok(action.startsWith('<button '), 'an action entry keeps button semantics')
  assert.ok(!action.includes('<a '), 'it must not become a link')
})

test('menu primitives: a link entry also supports an icon and a trailing note, and carries no type=button', () => {
  const link = menuItemHtml({ label: 'Skills', icon: 'spark', trailing: '›', attrs: 'href="/skills"' })
  assert.ok(link.includes('<use href="#i-spark" />'), 'the icon is there')
  assert.ok(link.includes('menu-trailing'), 'the trailing note is there')
  assert.ok(!link.includes('type="button"'), 'an a element must not carry type=button')
})

test('event delegation premise: a link entry with data attributes can still be generated as-is', () => {
  const link = menuItemHtml({ label: 'GitHub', icon: 'github', attrs: 'href="https://x" target="_blank" rel="noopener noreferrer"' })
  assert.ok(link.startsWith('<a '), 'an external link is an a too')
  assert.ok(link.includes('target="_blank"') && link.includes('rel="noopener noreferrer"'), 'the external-link attributes are kept')
})

// ---- Inline SVG icons (glyphs the sprite lacks, such as the envelope; adding one to the sprite means a layout change and a restart) ----

test('menu primitives: an object passed as the icon renders as inline SVG instead of going through the sprite', () => {
  const raw = '<svg viewBox="0 0 16 16"><rect x="1" y="3" width="14" height="10"/></svg>'
  const item = menuItemHtml({ label: 'support@x.com', icon: { raw } })
  assert.ok(item.includes(raw), 'the inline SVG is embedded as-is')
  assert.ok(!item.includes('<use href="#i-'), 'no sprite reference is generated')
})

test('Incident regression: the email entry renders as <button> (click to copy) and carries an inline envelope icon', () => {
  const raw = '<svg width="14" height="14" viewBox="0 0 16 16"><rect x="1.75" y="3.5" width="12.5" height="9"/></svg>'
  const item = menuItemHtml({ label: 'support@hellodac.com', icon: { raw }, attrs: 'data-about-email="support@hellodac.com"' })
  assert.ok(item.startsWith('<button '), 'the email is a button (a copy action), not a link')
  assert.ok(item.includes(raw), 'the envelope icon is there')
  assert.ok(!item.includes('<use'), 'the envelope does not go through the sprite (the sprite has no such glyph)')
})

// ---- A note must pass attrs through (the true cause of the 2026-09-26 report that `the version number is not shown`) ----

test('Incident regression: a note entry must render attrs -- the version row backfill marker depends on it', () => {
  const note = menuItemHtml({ kind: 'note', label: 'DAC', attrs: 'data-about-version' })
  assert.ok(
    note.includes('data-about-version'),
    'the note data attribute must reach the DOM, otherwise querySelector([data-about-version]) never matches -> the version number is never shown',
  )
})

test('menu primitives: a group entry passes attrs through as well (the same render path as a note, by convention)', () => {
  const group = menuItemHtml({ kind: 'group', label: 'Section', attrs: 'data-g="1"' })
  assert.ok(group.includes('data-g="1"'), 'a group attribute must not be dropped either')
})
