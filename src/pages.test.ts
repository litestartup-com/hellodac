import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import fastifyStatic from '@fastify/static'
import Fastify from 'fastify'
import { assetCacheHeaders, buildPages, buildStandalonePage, PAGES, PLACEHOLDERS } from './pages.js'
import { BRAND } from './brand.js'
import { LOCALES } from './i18n/index.js'

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')

test('every page composes against the real layout', () => {
  const pages = buildPages(publicDir)
  assert.deepEqual([...pages.keys()].sort(), Object.keys(PAGES).sort())

  for (const [name, html] of pages) {
    // The whole point of the layout: the frame is present in the first byte of
    // HTML, on every page, rather than appearing after a script runs.
    assert.match(html, /<aside id="sidebar" class="sidebar">/, `${name} has the sidebar`)
    assert.match(html, /assets\/shell\.js/, `${name} loads the shell`)
    assert.match(html, /<a class="brand" href="\/">/, `${name} can get home`)
    // Narrow-screen navigation is part of the frame, not of any one page: below
    // 1024px the sidebar is an off-canvas drawer and this bar is the only way to
    // open it. A page missing it would be a page a phone cannot navigate from.
    assert.match(html, /<header class="topbar">/, `${name} has the app bar`)
    assert.match(html, /id="nav-open"/, `${name} has the drawer trigger`)
    assert.match(html, /id="nav-backdrop"/, `${name} has the drawer backdrop`)
    // A stray placeholder would otherwise render as literal braces on the page.
    assert.doesNotMatch(html, /\{\{/, `${name} has no unreplaced placeholder`)
  }
})

test('each page gets its own title, stylesheets and script', () => {
  const pages = buildPages(publicDir)
  const runs = pages.get('runs') ?? ''
  assert.match(runs, new RegExp(`<title>Runs · ${BRAND.name}</title>`))
  assert.match(runs, /assets\/runs\.js/)

  // The chat opts out of the standard content padding (composer pinned to the
  // bottom); the wide pages keep the roomier column.
  assert.match(pages.get('chat') ?? '', /<main class="content content-flush">/)
  assert.match(pages.get('nodes') ?? '', /<main class="content wide">/)
})

test('DAC v1.0.0: every locale builds its pages (a missing key or translation fails at boot, instead of mixing languages inside a page)', () => {
  for (const locale of LOCALES) {
    const pages = buildPages(publicDir, locale)
    assert.ok(pages.size > 0)
    for (const [name, html] of pages) {
      assert.doesNotMatch(html, /\{\{t:/, `${name} (${locale}) still has an unreplaced translation placeholder`)
      assert.doesNotMatch(html, /\{\{[A-Z_]+\}\}/, `${name} (${locale}) still has an unreplaced framework placeholder`)
      assert.match(html, new RegExp(`<html lang="${locale}">`), `${name} (${locale}) lang attribute`)
    }
  }
  // The standalone page (login) has to build in both locales too
  for (const locale of LOCALES) {
    const login = buildStandalonePage(publicDir, 'login.html', locale)
    assert.doesNotMatch(login, /\{\{/, `login.html (${locale}) still has an unreplaced placeholder`)
    assert.match(login, new RegExp(`<html lang="${locale}">`))
  }
})

test('every asset URL carries a content version', () => {
  // An edited stylesheet that the browser never asks for again is the worst kind
  // of bug: the symptom is "my CSS does not work", so the search happens in the
  // CSS. The stamp has to cover the layout's own hardcoded references too, not
  // just the per-page ones.
  const pages = buildPages(publicDir)
  const chat = pages.get('chat') ?? ''
  for (const href of ['style.css', 'shell.js', 'chat.css', 'chat.js']) {
    assert.match(chat, new RegExp(`/assets/${href.replace('.', '\\.')}\\?v=[0-9a-f]{8}`), `${href} is versioned`)
  }
  // Hashes are per file, not one stamp for the build: an unchanged asset must
  // keep its URL across restarts or versioning would just disable caching.
  const style = /\/assets\/style\.css\?v=([0-9a-f]{8})/.exec(chat)?.[1]
  const shell = /\/assets\/shell\.js\?v=([0-9a-f]{8})/.exec(chat)?.[1]
  assert.notEqual(style, shell)
  // Same file, same version, on every page.
  assert.match(pages.get('nodes') ?? '', new RegExp(`/assets/style\\.css\\?v=${style}`))
})

test('assets are served must-revalidate', async () => {
  // Registered exactly as the app does. The first version of this called
  // `res.setHeader`, on the strength of @fastify/static's own type saying the
  // argument is a FastifyReply and mine saying it could not be -- and the server
  // died on the first stylesheet request. A test that had ever fetched one asset
  // would have caught it, so here is that test.
  const app = Fastify()
  await app.register(fastifyStatic, {
    root: join(publicDir, 'assets'),
    prefix: '/assets/',
    cacheControl: false,
    setHeaders: assetCacheHeaders,
  })

  const res = await app.inject({ method: 'GET', url: '/assets/style.css' })
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['cache-control'], 'no-cache')
  assert.match(res.body, /:root \{/)
  await app.close()
})

test('the icon sprite is defined once, in the layout', () => {
  const pages = buildPages(publicDir)
  for (const [name, html] of pages) {
    // It used to be copy-pasted per page, so i-alert existed in four versions
    // and editing one changed a quarter of the app.
    assert.equal((html.match(/id="i-alert"/g) ?? []).length, 1, `${name} defines i-alert once`)
  }
})

test('a page body containing $& survives splicing intact', () => {
  // String.replace treats $& in the *replacement* as "the matched text", so a
  // fragment containing it would silently gain a stray "{{CONTENT}}".
  const dir = mkdtempSync(join(tmpdir(), 'pages-'))
  mkdirSync(join(dir, 'pages'))
  writeFileSync(
    join(dir, 'layout.html'),
    '<html><head><title>{{TITLE}}</title>{{HEAD}}</head>' +
      '<body><aside id="sidebar" class="sidebar"></aside><a class="brand" href="/app"></a>' +
      '<main class="content {{CONTENT_CLASS}}">{{CONTENT}}</main>{{SCRIPT}}' +
      // The remaining placeholders (branding injection and friends) have to appear in the layout too, or
      // buildPages reports "missing placeholder" at boot; they are joined in from the exported list, so a
      // new placeholder needs no edit here. {{CONTENT}} already appeared above and cannot repeat (replaced once).
      PLACEHOLDERS.filter((token) => token !== '{{CONTENT}}').join('') +
      '</body></html>',
    'utf8',
  )
  for (const def of Object.values(PAGES)) {
    writeFileSync(join(dir, 'pages', def.file), '<p>cost is $& and $1</p>', 'utf8')
  }

  for (const html of buildPages(dir).values()) {
    assert.match(html, /<p>cost is \$& and \$1<\/p>/)
  }
})

test('a missing placeholder fails at boot rather than in a browser', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pages-bad-'))
  mkdirSync(join(dir, 'pages'))
  writeFileSync(join(dir, 'layout.html'), '<html><body>{{CONTENT}}</body></html>', 'utf8')
  for (const def of Object.values(PAGES)) writeFileSync(join(dir, 'pages', def.file), 'x', 'utf8')

  assert.throws(() => buildPages(dir), /missing the \{\{TITLE\}\} placeholder/)
})
