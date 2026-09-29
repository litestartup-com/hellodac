import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPages, buildStandalonePage, PAGES } from './pages.js'
import { LOCALES } from './i18n/index.js'

/**
 * The wiring guard: every id a page script references through $(...) / getElementById(...) has to exist
 * in the page that is **actually handed to the browser**.
 *
 * Why this must validate the build output rather than scan the template text of pages/*.html (learned the hard way on 2026-09-25):
 *   `buildPages()` splices the fragments into the page cache **at startup**, while `/assets/*` is read from disk per request.
 *   So "changed a fragment but did not restart the manager" hands the browser **new JS + old markup** -- the new script tries to bind
 *   an element that does not exist in the old page:
 *       Uncaught TypeError: Cannot read properties of null (reading 'addEventListener')
 *   A guard that only scans the template text is green for that case (the template clearly has it), which is the same as letting it through.
 *   Here the buildPages output is pulled out and validated directly, so that whole class of problem is caught at the unit-test stage.
 *
 * In addition: this assertion checks that the **output is self-consistent**. How fresh the output is still depends on a restart --
 * for the deployment discipline see docs/RELEASE.md (editing pages/*.html requires a restart; editing assets/* does not).
 */
const here = dirname(fileURLToPath(import.meta.url))
const publicDir = join(here, '..', 'public')

/**
 * Ids that JS assembles itself: they are not in the page, so they are registered explicitly.
 * Listed by hand rather than waved through broadly -- when a new dynamic id appears, someone has to think about which class it belongs to.
 */
const DYNAMIC = [
  /^node-menu-/, // node-row.js: one main menu popover per node
  /^node-version-menu-/, // node-row.js: the version submenu popover
  /^node-more-/, // node-row.js: the vertical-ellipsis trigger
  /^machines-revoked/, // nodes.js: the revoked-machines fold
  /^dac-/, // the general prefix
  /^nodes-link$/, // the shell.js sidebar nav item (from PRIMARY_NAV)
  /^nodes-hint$/,
  /^spend-hint$/,
  /^archive-hint$/,
  /^logout$/, // shell.js: the logout button inside the overflow menu
  // v2 keys/services pages (2026-09-29): row menus and the editor form are assembled by JS into
  // slots, exactly like the node menus above.
  /^key-menu-/, // keys.js: one menu popover per key row
  /^key-more-/, // keys.js: the three-dot trigger
  /^service-menu-/, // services.js: one menu popover per service row
  /^service-more-/, // services.js: the three-dot trigger
  /^svc-/, // services.js: the shared editor form (rendered into the drawer / edit slot)
  /^kf-/, // keys.js: the shared key form (rendered into the drawer / edit slot)
  /^kx-/, // keys.js: the call-examples drawer body (secret input, setup line, copy feedback)
]

/** The shell script: every page loads it, so its references must be findable on every page. */
const SHELL_SCRIPTS = ['shell.js']

const idsReferencedBy = (file: string): Set<string> => {
  const text = readFileSync(join(publicDir, 'assets', file), 'utf8')
  const ids = new Set<string>()
  for (const m of text.matchAll(/\$\(\s*'([A-Za-z0-9_-]+)'\s*\)/g)) ids.add(m[1] as string)
  for (const m of text.matchAll(/getElementById\(\s*'([A-Za-z0-9_-]+)'\s*\)/g)) ids.add(m[1] as string)
  return ids
}

test('wiring guard: every DOM id a page script references appears in that page build output', () => {
  const pages = buildPages(publicDir, LOCALES[0])
  const isDynamic = (id: string): boolean => DYNAMIC.some((re) => re.test(id))
  const missing: string[] = []

  for (const [name, def] of Object.entries(PAGES)) {
    const html = pages.get(name)
    assert.ok(html !== undefined, `page ${name} was not built`)
    const declared = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]))
    assert.ok(declared.size > 40, `parsing the ids of page ${name} went wrong (only ${declared.size} found)`)

    // The scripts this page loads itself, plus the shell script every page has.
    const scripts = [...SHELL_SCRIPTS, ...(def.script === null ? [] : [def.script])]
    for (const file of scripts) {
      for (const id of idsReferencedBy(file)) {
        if (!declared.has(id) && !isDynamic(id)) missing.push(`${name} ← ${file}: #${id}`)
      }
    }
  }

  const unique = [...new Set(missing)]
  assert.deepEqual(unique, [], `these ids do not exist in the page (they only blow up when clicked in the browser):\n  ${unique.join('\n  ')}`)
})

test('wiring guard: the DOM ids the login page (a standalone page) references exist too', () => {
  const html = buildStandalonePage(publicDir, 'login.html', LOCALES[0])
  const declared = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]))
  const missing = [...idsReferencedBy('login.js')].filter((id) => !declared.has(id) && !DYNAMIC.some((re) => re.test(id)))
  assert.deepEqual(missing, [], `login.js references ids that do not exist in the login page: ${missing.join(', ')}`)
})

/**
 * The icon guard: every icon name used by menuItemHtml({ icon }) / `<use href="#i-x">` must be defined in the icon sprite.
 *
 * Why it earns an assertion: a wrong icon name **raises no error**, `<use href="#i-typo">` simply renders nothing,
 * leaving a blank icon slot on the page -- the classic cause of "the menu looks unfinished", and only the eye can catch it.
 * The last time icons were deleted this list was checked first, which is how stop/restart/tag turned out not to exist at all
 * (four wrong icons nearly shipped), which is why the check is frozen in place.
 */
test('wiring guard: every icon name the code references exists in the icon sprite', () => {
  const sprite = new Set([...readFileSync(join(publicDir, 'layout.html'), 'utf8').matchAll(/id="i-([a-z0-9-]+)"/g)].map((m) => m[1]))
  assert.ok(sprite.size > 20, `parsing the icon sprite went wrong (only ${sprite.size} found)`)

  const offenders: string[] = []
  for (const file of ['shell.js', 'node-row.js', 'nodes.js']) {
    const text = readFileSync(join(publicDir, 'assets', file), 'utf8')
    for (const m of text.matchAll(/\bicon:\s*'([^']+)'/g)) {
      if (!sprite.has(m[1] as string)) offenders.push(`${file}: icon '${m[1]}'`)
    }
    for (const m of text.matchAll(/href="#i-([a-z0-9-]+)"/g)) {
      if (!sprite.has(m[1] as string)) offenders.push(`${file}: #i-${m[1]}`)
    }
  }
  assert.deepEqual(offenders, [], `these icon names do not exist (they render as a blank icon slot, with no error):\n  ${offenders.join('\n  ')}`)
})

/**
 * The brand subtitle renders per language (2026-09-26): once `brand.sub` moved into the i18n dictionary, the sidebar's
 * DISPATCHED AGENT CLUSTER has to follow the language switch -- if layout still carries the old
 * `{{BRAND_SUB}}` placeholder (or the dictionary is missing the key), it shows up on the Chinese page as the key name or in English.
 */
test('the brand subtitle renders per language (en and zh-CN each keep their own translation)', () => {
  const expected = { en: 'Dispatched Agent Cluster', 'zh-CN': '统一调度的智能体集群' } as const
  for (const locale of LOCALES) {
    const pages = buildPages(publicDir, locale)
    const m = /<span class="brand-sub">([^<]*)<\/span>/.exec(pages.get('nodes') ?? '')
    assert.equal(m?.[1], expected[locale], `${locale} sidebar subtitle`)
  }
})
