// scripts/check-i18n-keys.mjs —— i18n key guard.
//
// Two real accidents it stops:
// 1. a typo in a key name such as `t('nodes.acces.title')` -- no runtime error, the key name just shows up on the page;
// 2. a template writes `{{t:foo.bar}}` but the dictionary lacks it -- that throws at boot, and only on the next restart.
// Every key is validated against the reference locale (en), and any missing one exits non-zero (CI-ready).
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const localesDir = join(root, 'src', 'i18n', 'locales')
const dict = JSON.parse(readFileSync(join(localesDir, 'en.json'), 'utf8'))

const walk = (dir) => {
  const out = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'dist' || entry === 'dist-release' || entry === 'data') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    // Test files excluded: they use nonexistent keys on purpose (asserting the fallback).
    else if (/\.(js|mjs|ts|html)$/.test(entry) && !/\.test\.(js|mjs|ts)$/.test(entry)) out.push(full)
  }
  return out
}

// Example key names in docs/comments (`{{t:key}}`, `{{t:...}}`) are not real references.
const IGNORED = new Set(['key', '...'])

// Keys assembled in templates are invisible to static analysis (e.g. t(`runs.state.${state}`), t(`lang.${tag}`)),
// so they are listed as dynamic prefixes: in the "unused" list they would only mislead.
const DYNAMIC_PREFIXES = ['runs.state.', 'runs.trigger.', 'lang.', 'audit.kind.', 'chat.goal.', 'services.surface.']

const files = [...walk(join(root, 'public')), ...walk(join(root, 'src'))]
const used = new Map() // key -> where it appears
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  // The `:` matters: scope ids are keys too (`keys.scope.conversations:write`).
  for (const match of text.matchAll(/\bt\(\s*'([A-Za-z0-9_.:-]+)'/g)) {
    if (IGNORED.has(match[1])) continue
    if (!used.has(match[1])) used.set(match[1], file)
  }
  for (const match of text.matchAll(/\{\{t:([A-Za-z0-9_.:-]+)\}\}/g)) {
    if (IGNORED.has(match[1])) continue
    if (!used.has(match[1])) used.set(match[1], file)
  }
}

const missing = [...used.entries()].filter(([key]) => !(key in dict))
const zh = JSON.parse(readFileSync(join(localesDir, 'zh-CN.json'), 'utf8'))
const missingZh = [...used.keys()].filter((key) => !(key in zh))
const unused = Object.keys(dict).filter(
  (key) => !used.has(key) && !DYNAMIC_PREFIXES.some((prefix) => key.startsWith(prefix)),
)

console.log(`i18n keys: ${used.size} used · ${Object.keys(dict).length} in the dictionary`)
if (missing.length > 0) {
  console.log('missing (en):')
  for (const [key, file] of missing) console.log(`  ${key}  ← ${file.replace(root + '\\', '')}`)
}
if (missingZh.length > 0) console.log(`missing (zh-CN): ${missingZh.join(', ')}`)
if (unused.length > 0) console.log(`unreferenced (possibly left over from deleted code): ${unused.join(', ')}`)

process.exit(missing.length === 0 && missingZh.length === 0 ? 0 : 1)
