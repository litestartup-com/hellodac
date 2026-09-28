// scripts/inject-version.mjs — Debt D5: version number injected at build time.
// package.json is the single source of truth; this script writes version into src/version.ts (run from
// build / preversion), and gen-env.sh / make-release / /api/status all read from that chain.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const out = `// Generated file, do not edit by hand: injected at build time by scripts/inject-version.mjs from package.json.
// Debt D5: the runtime source of truth for the manager's own version (the DSH compatibility versions live in dsh-matrix.ts, do not confuse the two).
export const MANAGER_VERSION = '${pkg.version}'
`
const target = join(root, 'src', 'version.ts')
let before = null
try {
  before = readFileSync(target, 'utf8')
} catch {
  // First generation
}
if (before !== out) writeFileSync(target, out, 'utf8')
console.log(`[inject-version] MANAGER_VERSION = ${pkg.version}`)
