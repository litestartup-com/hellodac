// scripts/copy-locales.mjs —— copy the locale files into dist.
//
// Why this step exists: `tsc` only compiles TS, it does not move JSON; and the manager container
// image copies only `dist` (see images/manager/Dockerfile), so at runtime `dist/i18n/index.js`
// would not find `dist/i18n/locales/*.json` and boot would fail -- measured on 2026-09-24 (the first
// build with i18n blew up with ENOENT locally, which is exactly why this step cannot rely on
// "remember to copy by hand").
//
// The single source of truth is still src/i18n/locales/*.json; this script only derives.
import { cpSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const from = join(root, 'src', 'i18n', 'locales')
const to = join(root, 'dist', 'i18n', 'locales')

mkdirSync(to, { recursive: true })
cpSync(from, to, { recursive: true })
console.log(`[copy-locales] ${from} → ${to}`)
