import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Password-change button styling contract (user feedback 2026-09-26: "the password button is still blue").
 *
 * What is asserted is the **selector and the colour value**, not the rendered result -- a wrong button
 * colour should go red here, rather than wait for a user to report it by eye. It also pins two rules:
 *   1. The dark-ink override must hang off `#password-form` (the password page only) -- hanging it off
 *      `.narrow` would also repaint the blue Sign in on the login page (the login page shares .narrow).
 *   2. The override must come after the base rule (in CSS, order is weight; reversed it does nothing).
 */
const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, '..', '..', 'public', 'assets', 'style.css'), 'utf8')

/** Read a property value inside a selector block (var() is returned as written). */
const declOf = (selector, prop) => {
  const block = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css)
  if (block === null) return null
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'm').exec(block[1])
  return m === null ? null : m[1].trim()
}

test('the password page submit button is dark ink, not accent blue', () => {
  const bg = declOf('#password-form button[type=\'submit\']', 'background')
  assert.ok(bg !== null, 'a #password-form-only override rule must exist')
  assert.ok(/var\(--text\)/.test(bg), `the background should be --text (actually ${bg})`)
  assert.ok(!/--accent/.test(bg), 'accent blue must not be used any more')
})

test('the .narrow submit button on the login page stays accent blue (a shared selector must not catch it in the crossfire)', () => {
  const bg = declOf('.narrow button[type=\'submit\']', 'background')
  assert.ok(/var\(--accent\)/.test(bg), `.narrow base rule is still blue (actually ${bg})`)
})

test('the dark-ink override must be written after the base rule (order is weight)', () => {
  const base = css.indexOf('.narrow button[type=\'submit\']')
  const override = css.indexOf('#password-form button[type=\'submit\']')
  assert.ok(base > 0 && override > base, `the override rule must come after the base rule (base=${base}, override=${override})`)
})
