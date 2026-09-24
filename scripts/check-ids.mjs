// Cross-check that every $('id') referenced by a page script exists in the
// HTML that page is served from (layout + its fragment). A missing id makes
// addEventListener throw on null, which is exactly the class of bug where one
// stale or mistyped id kills a whole page's wiring.
//
//   node scripts/check-ids.mjs
//
// Reports, per page script: ids referenced but not found in the rendered page.

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

// layout + every fragment, then splice, so the check runs against what
// buildPages() actually serves.
//
// 公开版精简（DAC v1.0.0）：页面清单已同步（board/crons 页下线，runs 页新增）；
// 本脚本仍不在 CI 里（`npm run lint` = eslint），是开发者手动跑的守卫。
const layout = read('public/layout.html')
const fragments = {
  chat: read('public/pages/chat.html'),
  nodes: read('public/pages/nodes.html'),
  runs: read('public/pages/runs.html'),
  skills: read('public/pages/skills.html'),
  spend: read('public/pages/spend.html'),
  archive: read('public/pages/archive.html'),
  audit: read('public/pages/audit.html'),
  password: read('public/pages/password.html'),
}
const pages = Object.fromEntries(
  Object.entries(fragments).map(([name, frag]) => [name, layout.replace('{{CONTENT}}', () => frag)]),
)

// shell.js runs on every page; the page scripts run on their own page.
const targets = [
  { script: 'shell.js', pages: Object.keys(pages) },
  { script: 'chat.js', pages: ['chat'] },
  { script: 'nodes.js', pages: ['nodes'] },
  { script: 'runs.js', pages: ['runs'] },
  { script: 'skills.js', pages: ['skills'] },
  { script: 'spend.js', pages: ['spend'] },
  { script: 'archive.js', pages: ['archive'] },
  { script: 'audit.js', pages: ['audit'] },
  { script: 'password.js', pages: ['password'] },
]

const refsOf = (script) => {
  const text = read(`public/assets/${script}`)
  const ids = new Set()
  for (const match of text.matchAll(/\$\(\s*'([^']+)'\s*\)/g)) ids.add(match[1])
  for (const match of text.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)) ids.add(match[1])
  // Ids the script builds itself at runtime (the ⋮ menu markup, the injected
  // revoked fold) never appear in the static fragment, so they are listed here
  // rather than left as permanent false positives that train people to ignore
  // this check.
  for (const id of DYNAMIC[script] ?? []) ids.delete(id)
  return ids
}

/** ids created by the script's own runtime markup, per script. */
const DYNAMIC = {
  'shell.js': ['nodes-link', 'nodes-hint', 'spend-hint', 'archive-hint', 'logout', 'side-version'],
  'nodes.js': ['machines-revoked', 'machines-revoked-toggle'],
}

const idsOf = (html) => {
  const ids = new Set()
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) ids.add(match[1])
  return ids
}

let problems = 0
for (const { script, pages: pageList } of targets) {
  const refs = refsOf(script)
  for (const page of pageList) {
    const ids = idsOf(pages[page])
    const missing = [...refs].filter((id) => !ids.has(id))
    if (missing.length > 0) {
      problems += 1
      console.log(`MISSING  ${script} on /${page}: ${missing.join(', ')}`)
    }
  }
  // duplicate ids inside one page would make getElementById ambiguous
  for (const page of pageList) {
    const found = [...pages[page].matchAll(/\bid="([^"]+)"/g)].map((m) => m[1])
    const dupes = found.filter((id, i) => found.indexOf(id) !== i)
    if (dupes.length > 0) {
      problems += 1
      console.log(`DUPLICATE ids on /${page}: ${[...new Set(dupes)].join(', ')}`)
    }
  }
}

if (problems === 0) console.log('all id references resolve on every page')
process.exit(problems === 0 ? 0 : 1)
