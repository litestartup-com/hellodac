import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BRAND } from './brand.js'
import { DEFAULT_LOCALE, t as translate, type Locale } from './i18n/index.js'

/**
 * Splices each page's body into one shared frame at boot.
 *
 * Every page used to carry its own copy of the `<head>`, the icon sprite and a
 * back button, and only the dashboard had the sidebar -- so navigating anywhere
 * threw the frame away and handed back a bare document. The frame is the
 * application; the page is the part that differs.
 *
 * Done on the server rather than by injecting the sidebar from JavaScript: the
 * frame is then present in the first byte of HTML, so it cannot flash in after
 * paint, and it stays ordinary markup in an ordinary file instead of a string
 * inside a script.
 *
 * Deliberately *not* a single-page app swapping `<main>` over fetch. The board
 * holds an EventSource and the dashboard two intervals; client-side routing
 * would make tearing those down on every navigation a correctness requirement,
 * and leaking one is invisible until the tab has been open an hour. A full
 * document load costs milliseconds here and has no such failure mode.
 */

export interface PageDef {
  /** Fragment filename under `public/pages`. */
  file: string
  title: string
  /** Page-specific stylesheets, in addition to the shared `style.css`. */
  css: string[]
  /** Page-specific module, if the page needs one beyond the shell. */
  script: string | null
  /**
   * Extra class on `<main class="content">`.
   *
   * The board sets `content-flush` because it supplies its own full-bleed
   * padding and a sticky header, which the standard content padding would
   * inset and break.
   */
  contentClass: string
}

export const PAGES: Record<string, PageDef> = {
  // The product name in the page title comes from src/brand.ts (change the brand/domain in one place).
  // `wide` buys these a roomier column than the old home page's reading width:
  // a month of daily bars needs it.
  spend: { file: 'spend.html', title: `{{t:spend.title}} · ${BRAND.name}`, css: ['spend.css'], script: 'spend.js', contentClass: 'wide' },
  // Public-edition trim (DAC v1.0.0): the cron page is retired -- the engine and /api/crons stay
  // (the internal API and a future scheduling UI can return), but it is no longer a public page.
  // The other half of archiving: without a place to see what was archived, a
  // soft delete is indistinguishable from a real one.
  archive: {
    file: 'archive.html',
    title: `{{t:archive.title}} · ${BRAND.name}`,
    css: [],
    script: 'archive.js',
    contentClass: 'wide',
  },
  // Public-edition trim (DAC v1.0.0): the dashboard page is retired (the UI is gone, while the backend
  // src/board/* and /api/board/*, /api/internal/agents/:id/board stay -- the brain produces dashboard files).
  // `content-flush`: the composer is pinned to the bottom of the column, so the
  // page owns its full height and cannot be inset by the standard content padding.
  chat: {
    file: 'chat.html',
    title: `{{t:topbar.chat}} · ${BRAND.name}`,
    // dsw-theme.css comes before chat.css: DSH web's full set of theme tokens (the alignment baseline).
    css: ['dsw-theme.css', 'chat.css'],
    script: 'chat.js',
    contentClass: 'content-flush',
  },
  // Hive Q4: the node (fleet) overview -- the sidebar keeps only the summary and anomalies, the full list is here.
  nodes: {
    file: 'nodes.html',
    title: `{{t:nodes.title}} · ${BRAND.name}`,
    css: [],
    script: 'nodes.js',
    contentClass: 'wide',
  },
  // UI wrap-up A: the global task stream became its own page (moved out of /nodes' "recent tasks" and
  // upgraded to filtering + paging); the brain's dispatches leave their trace here.
  runs: {
    file: 'runs.html',
    title: `{{t:runs.title}} · ${BRAND.name}`,
    css: [],
    script: 'runs.js',
    contentClass: 'wide',
  },
  // Hive P5.2: the skill list (v1 read-only -- the files are the truth + a version comparison).
  skills: {
    file: 'skills.html',
    title: `{{t:skills.title}} · ${BRAND.name}`,
    css: [],
    script: 'skills.js',
    contentClass: 'wide',
  },
  // Outward API: key management (the admin surface; the customer surface is /v1 on 8081, and the two doors do not recognise each other)
  keys: {
    file: 'keys.html',
    title: `{{t:keys.title}} · ${BRAND.name}`,
    css: [],
    script: 'keys.js',
    contentClass: 'wide',
  },
  // Hive plan 2 P3: forced password change on first login + the audit trail
  password: {
    file: 'password.html',
    title: `{{t:password.title}} · ${BRAND.name}`,
    css: [],
    script: 'password.js',
    contentClass: '',
  },
  audit: {
    file: 'audit.html',
    title: `{{t:audit.title}} · ${BRAND.name}`,
    css: [],
    script: 'audit.js',
    contentClass: 'wide',
  },
}

/**
 * The placeholders the layout **must** contain (buildPages checks them at boot; tests build fixture layouts from this).
 * Merely "substitutable" placeholders ({{TAGLINE}}/{{BRAND_FULL}}) are not on the list: page fragments or
 * standalone pages use them as needed, and a layout that does not reference one should not be forced to keep the slot.
 *
 * {{REPO_URL}}/{{HOMEPAGE}} left this list on 2026-09-25: the GitHub icon at the bottom of the sidebar was
 * deleted and the repo entry moved into ⋮ -> About, so the layout no longer has a user for them -- insisting
 * the layout keep an unused placeholder only forces the next person to put a dead marker back.
 *
 * {{BRAND_SUB}} left the list the same way (2026-09-26): the brand sub-line now follows the language (the
 * layout uses `{{t:brand.sub}}` and goes through the translation), so a single English-value placeholder is no longer needed.
 */
export const PLACEHOLDERS = [
  '{{TITLE}}',
  '{{HEAD}}',
  '{{CONTENT_CLASS}}',
  '{{CONTENT}}',
  '{{SCRIPT}}',
  '{{BRAND}}',
  '{{BRAND_MARK}}',
  '{{LOCALE}}',
] as const

/**
 * Content hash for every `/assets/...` URL in a page.
 *
 * Without it a stylesheet change is invisible until the browser decides to ask
 * again, and "I changed the CSS but the page did not" is indistinguishable from
 * "my CSS is wrong" -- which cost a real debugging session. Hashing the contents
 * rather than stamping the boot time means the URL only moves when the file
 * actually did, so an unchanged asset stays cached across restarts.
 *
 * This rewrites the whole rendered page, so the layout's own hardcoded
 * `style.css` and `shell.js` are covered by the same pass as the per-page ones.
 * What it cannot reach is one module importing another (`shell.js` importing
 * `./ui.js`), which is why /assets is also served must-revalidate.
 */
const ASSET_URL = /\/assets\/([A-Za-z0-9._-]+\.(?:css|js))/g

const stampAssets = (html: string, publicDir: string): string => {
  const versions = new Map<string, string>()
  return html.replace(ASSET_URL, (whole, file: string) => {
    let version = versions.get(file)
    if (version === undefined) {
      try {
        version = createHash('sha1').update(readFileSync(join(publicDir, 'assets', file))).digest('hex').slice(0, 8)
      } catch {
        // A reference to a file that is not there is a broken page either way;
        // leaving it unversioned keeps the error about the 404, not about this.
        version = ''
      }
      versions.set(file, version)
    }
    return version === '' ? whole : `${whole}?v=${version}`
  })
}

/**
 * Sent with every /assets response.
 *
 * Lives here rather than inline at the registration because that inline version
 * called `res.setHeader` -- @fastify/static hands `setHeaders` a FastifyReply,
 * not a raw ServerResponse, so the server crashed on the first stylesheet
 * request. Nothing caught it: no test had ever fetched an asset. Now this is a
 * named function a test can call.
 *
 * `no-cache` is "keep it, but ask before using it", not "do not keep it": the
 * answer is a 304, not a re-download.
 */
export const assetCacheHeaders = (reply: { header: (name: string, value: string) => unknown }): void => {
  reply.header('cache-control', 'no-cache')
}

/** The translation placeholder in a template: `{{t:nav.nodes}}`. */
const TRANSLATION_TOKEN = /\{\{t:([A-Za-z0-9_.-]+)\}\}/g

/**
 * Replaces `{{t:key}}` with the translation. A missing key throws -- blowing up at boot beats showing the key
 * name on the page, and beats "one Chinese sentence mixed into an English page": the layout is shared by every page, so one missed translation hits the whole site.
 */
const translateTokens = (text: string, locale: Locale): string =>
  text.replace(TRANSLATION_TOKEN, (_whole, key: string) => {
    const value = translate(key, locale)
    if (value === key) throw new Error(`missing i18n key "${key}" (locale ${locale})`)
    return value
  })

const render = (layout: string, def: PageDef, fragment: string, locale: Locale): string => {
  const head = def.css.map((href) => `<link rel="stylesheet" href="/assets/${href}" />`).join('\n    ')
  const script = def.script === null ? '' : `<script src="/assets/${def.script}" type="module"></script>`
  // Translation comes first: every {{t:...}} in fragments and the layout is resolved here, leaving only framework placeholders.
  const localizedLayout = translateTokens(layout, locale)
  const localizedFragment = translateTokens(fragment, locale)
  // The client dictionary (the whole language, a few KB): /api/i18n/<locale> serves it to shell.js and
  // login.js (CSP forbids inline scripts, so it cannot be embedded in the page), which keeps server-rendered
  // and client-side dynamic text on the same translation.
  return localizedLayout
    // replaceAll: a brand placeholder can appear several times on one page (title, sidebar, injected script),
    // and replace would only swap the first -- hit for real on 2026-09-24 ({{BRAND}} left behind on the spend page).
    .replaceAll('{{TITLE}}', translateTokens(def.title, locale))
    .replaceAll('{{HEAD}}', head)
    .replaceAll('{{CONTENT_CLASS}}', def.contentClass)
    // Brand placeholders (DAC v1.0.0): the product name/repo/site come from src/brand.ts, and pages never
    // scatter URLs (change the domain in one place).
    .replaceAll('{{BRAND}}', BRAND.name)
    .replaceAll('{{BRAND_MARK}}', BRAND.mark)
    .replaceAll('{{BRAND_FULL}}', BRAND.fullName)
    .replaceAll('{{TAGLINE}}', BRAND.tagline)
    .replaceAll('{{LOCALE}}', locale)
    // Last, and via a function: a fragment containing `$&` or `$1` would
    // otherwise be interpreted as a replacement pattern and silently mangled.
    .replace('{{CONTENT}}', () => localizedFragment)
    .replaceAll('{{SCRIPT}}', script)
}

/**
 * Builds every page once, for one locale.
 *
 * Rendering at boot rather than per request means a missing fragment, a renamed
 * placeholder or a missing i18n key fails at startup with a clear message,
 * instead of serving a broken page to whoever happens to open it first.
 *
 * The language dimension expands here too (one set of HTML per language): pages are plain static strings, and
 * pre-rendering per language is cheaper than substituting at every request, nor can it let the "server render + client dictionary" pair drift apart.
 */
export const buildPages = (publicDir: string, locale: Locale = DEFAULT_LOCALE): Map<string, string> => {
  const layout = readFileSync(join(publicDir, 'layout.html'), 'utf8')
  for (const token of PLACEHOLDERS) {
    if (!layout.includes(token)) throw new Error(`layout.html is missing the ${token} placeholder`)
  }

  const out = new Map<string, string>()
  for (const [name, def] of Object.entries(PAGES)) {
    const fragment = readFileSync(join(publicDir, 'pages', def.file), 'utf8')
    const html = stampAssets(render(layout, def, fragment, locale), publicDir)
    // Catches a typo'd placeholder that would otherwise reach the browser as
    // literal braces on the page.
    const leftover = html.match(/\{\{[A-Z_]+\}\}/)
    if (leftover !== null) throw new Error(`page "${name}" still contains ${leftover[0]} after rendering`)
    out.set(name, html)
  }
  return out
}

/** One set of pages per language (memo: computed once at boot). */
export const buildAllPages = (publicDir: string, locales: readonly Locale[]): Map<Locale, Map<string, string>> => {
  const out = new Map<Locale, Map<string, string>>()
  for (const locale of locales) out.set(locale, buildPages(publicDir, locale))
  return out
}

/**
 * Standalone pages outside the layout (the login page) are pre-rendered per language too.
 *
 * The login page deliberately stays out of the layout shell: the sidebar draws agent data, and at login there is
 * no chat to look up yet. What it needs is the same translations and brand placeholders, not the whole frame.
 */
export const buildStandalonePage = (publicDir: string, file: string, locale: Locale): string => {
  const raw = readFileSync(join(publicDir, file), 'utf8')
  const html = translateTokens(raw, locale)
    .replaceAll('{{BRAND}}', BRAND.name)
    .replaceAll('{{BRAND_FULL}}', BRAND.fullName)
    .replaceAll('{{TAGLINE}}', BRAND.tagline)
    .replaceAll('{{LOCALE}}', locale)
  const leftover = html.match(/\{\{[A-Z_]+\}\}/)
  if (leftover !== null) throw new Error(`${file} still contains ${leftover[0]} after rendering (${locale})`)
  return stampAssets(html, publicDir)
}
