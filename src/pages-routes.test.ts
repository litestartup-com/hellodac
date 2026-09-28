import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Page registration and route registration must match one to one.
 *
 * Incident (2026-09-27): the `keys` page was defined in pages.ts and its assets were built into dist, but
 * index.ts had no `app.get('/keys', …, page('keys'))` -- so `/keys` returned 404 outright (while `/api/keys` worked)
 * and only a user clicking through the UI noticed. Page registration is two hand-written lists, so it needs a guard.
 *
 * Statically check both sides: the PAGES keys in pages.ts <-> the `page('<key>')` calls in index.ts.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pagesSrc = readFileSync(join(root, 'src/pages.ts'), 'utf8')
const indexSrc = readFileSync(join(root, 'src/index.ts'), 'utf8')

/** Top-level keys in the PAGES object (shaped like `  skills: {`). */
const declaredPages = (): string[] => {
  const start = pagesSrc.indexOf('const PAGES')
  assert.ok(start >= 0, 'PAGES not found in pages.ts')
  const body = pagesSrc.slice(start, pagesSrc.indexOf('\n}', start))
  return [...body.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*): \{/gm)].map((m) => m[1] ?? '')
}

/** The names passed to `page('<name>')` in index.ts. */
const routedPages = (): string[] => [...indexSrc.matchAll(/page\('([a-zA-Z][a-zA-Z0-9]*)'\)/g)].map((m) => m[1] ?? '')

test('every page definition has a matching route (a missing registration = page 404 while the API works, the hardest to diagnose)', () => {
  const declared = declaredPages()
  const routed = routedPages()
  assert.ok(declared.length >= 8, `PAGES parsed into something odd (only ${declared.length} found)`)

  const missing = declared.filter((name) => !routed.includes(name))
  assert.deepEqual(missing, [], `these pages are defined but have no route: ${missing.join(', ')}`)
})

test('every page route points at a page that is defined (a typo = 404)', () => {
  const declared = declaredPages()
  const unknown = [...new Set(routedPages())].filter((name) => !declared.includes(name))
  assert.deepEqual(unknown, [], `these routes point at pages that do not exist: ${unknown.join(', ')}`)
})
