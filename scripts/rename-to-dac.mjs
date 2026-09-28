// scripts/rename-to-dac.mjs —— the mechanical rename sweep (B2).
//
// Why this step exists: the rename touched 372 places across 70 files and hand-editing is bound to miss some.
// This turns "what should change and what must never change" into a reviewable table, and it **dry-runs** by default (report only, nothing written); --apply only after confirming.
//
// Usage:
//   node scripts/rename-to-dac.mjs            # dry run: list the changes by file/category
//   node scripts/rename-to-dac.mjs --apply    # really write (run the full gate set afterwards)
//
// Red lines (allowlist, never replaced):
//   - `ohdsh-api-facade`: the package name in the gateway repo; the user decided gateway stays as it is
//   - `litestartup-com/dsh-api-gateway`: the gateway repo address (the pin chain does not move)
//   - the historical CHANGELOG entries (the public entries were written separately; history is a ledger, the past is not rewritten)
//   - runtime data such as host names (e.g. an intranet host name)
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const APPLY = process.argv.includes('--apply')

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-release', 'data', '.m1-pilot'])
const TEXT_EXT = /\.(ts|tsx|js|mjs|cjs|json|ya?ml|md|sh|ps1|cmd|html|css|conf|example|txt|Dockerfile)$/

/** Protect first, then replace, then restore: the order is the correctness. */
const PROTECT = [
  'ohdsh-api-facade',
  'litistartup-com/dsh-api-gateway',
  'litestartup-com/dsh-api-gateway',
  // The backup encryption **format markers** (src/crypt.ts): the `OHDSH-BAK2` magic and the HKDF info/salt strings.
  // They are not brand names but protocol constants already written into on-disk ciphertext -- renaming them
  // would make existing backups permanently undecryptable (an upgrade must never break the recovery chain is a hard constraint). Deliberately kept on the old name.
  'OHDSH-BAK2',
  'ohdsh-backup-v2',
  'ohdsh-backup:',
  // Same for the v1 magic inside backup files (a historical format; decrypting old backups still needs it).
  'OHDSH-BAK1',
]

/** Replacement table: longest first (so `ohdsh-dsh-node` and friends cannot eat each other). */
const RULES = [
  // —— brand ——
  [/Oh! dsh/g, 'DAC'],
  [/ohdsh\.com/g, 'hellodac.com'],
  // —— repository address ——
  [/litestartup-com\/dsh-agent-manager/g, 'litestartup-com/hellodac'],
  // An early hand-written `litestartup/hellodac` was missing the owner's `-com` suffix (the real repo address is
  // `litestartup-com/hellodac`): corrected along the way. This rule cannot hit the addresses already fixed above.
  [/litestartup\/hellodac/g, 'litestartup-com/hellodac'],
  // Escaped form (the `\/` of regex source): the URL rule above writes a literal slash and cannot catch the escaped
  // shape -- measured on 2026-09-24: two URL assertions in install-script.test.ts were missed and npm test went red.
  // The output keeps the same escaped shape (the tests assert on the regex source itself).
  [/litistartup-com\\\/dsh-agent-manager/g, 'litestartup-com\\/hellodac'],
  // —— service/task names (the Windows scheduled task + the systemd unit) ——
  [/OhdshManager/g, 'DacManager'],
  [/OhdshAgent/g, 'DacAgent'],
  [/ohdsh-agent\.service/g, 'dac-agent.service'],
  [/ohdsh-agent/g, 'dac-agent'],
  [/ohdsh-start\.cmd/g, 'dac-start.cmd'],
  // —— containers/images/networks/volumes ——
  [/ohdsh\/dsh-node/g, 'hellodac/dac-node'],
  [/ohdsh\/manager/g, 'hellodac/dac-manager'],
  [/ohdsh-node-brain/g, 'dac-node-brain'],
  [/ohdsh-nginx/g, 'dac-nginx'],
  [/ohdsh-manager/g, 'dac-manager'],
  [/ohdsh-hive/g, 'dac-hive'],
  // The default prefix derived from the compose project name (`ohdsh_hive`): `\b` is not a boundary before `_`,
  // so the fallback rule cannot catch it -- this was the first leftover the dry-run report caught.
  [/ohdsh_hive/g, 'dac_hive'],
  [/ohdsh-brain/g, 'dac-brain'],
  // —— disk paths and profile names ——
  [/\.dsh-ohdsh/g, '.dac'],
  [/dsh-profile-ohdsh-node/g, 'dsh-profile-dac-node'],
  [/profiles\/ohdsh-node/g, 'profiles/dac-node'],
  [/\/opt\/ohdsh/g, '/opt/dac'],
  // —— cookie ——
  [/ohdsh_csrf/g, 'dac_csrf'],
  // —— environment variables (DSH_* is upstream semantics, kept) ——
  [/OHDSH_/g, 'DAC_'],
  // —— release artifacts ——
  [/ohdsh-compose\.zip/g, 'dac-compose.zip'],
  // —— package name and the remaining identifiers (the fallback, placed last) ——
  [/package name `ohdsh`/g, 'package name `dac`'],
  [/`ohdsh`/g, '`dac`'],
  [/"name": "ohdsh"/g, '"name": "dac"'],
  [/\bohdsh\b/g, 'dac'],
]

/** File-level allowlist: skip the whole file (historical ledger / local notes / this script itself). */
const SKIP_FILES = new Set([
  'CHANGELOG.md', // the historical ledger, the past is not rewritten
  'CONTEXT.md', // local session notes (not committed)
  'RULE.md', // local development rules (not committed)
  'scripts/rename-to-dac.mjs', // this script: the rules themselves spell ohdsh, replacing them would self-destruct
  // release-check's "old brand name is fully cleared" must scan **for the old name** (the scan regex + the allowlist);
  // replacing it would dismantle the guard itself: measured on 2026-09-24 -- `/ohdsh/i` was changed to `/dac/i`
  // and the guard briefly reported every file in the repo containing dac as a violation.
  'scripts/release-check.mjs',
])

const files = []
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) walk(full)
    else if (TEXT_EXT.test(entry) || entry === 'Dockerfile' || entry.startsWith('Dockerfile.')) files.push(full)
  }
}
walk(root)

// Only touch git-tracked files. **This guard rail was bought with an incident**: measured on 2026-09-24 -- the sweep
// walked the filesystem and edited the gitignored production source of truth `manager.config.yaml` along with
// everything else (paths rewritten to a `~/.dac\...` that does not exist on this machine, profiles changed to
// `dac-*`). The running manager held its config in memory so nothing showed at the time, but **the next restart
// would have pulled nodes from nonexistent paths → production would not come up**. Untracked files (local config,
// secrets, data) are never in scope for a "rename": skip them and name them.
const tracked = new Set(
  execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\u0000')
    .filter((s) => s !== '')
    .map((s) => s.replace(/\\/g, '/')),
)

let totalHits = 0
let changedFiles = 0
const byRule = new Map()
const report = []
const leftovers = []
const untrackedSkipped = []
// "Escaped form" suspicion: the targeted rules spell literals (e.g. `ohdsh/dsh-node`) while code often writes
// `ohdsh\/dsh-node` to build a regex -- the slash is escaped, the targeted rule cannot catch it and only the
// fallback `\bohdsh\b` applies, so `hellodac/dac-node` was wrongly changed to `dac/dsh-node` (measured on
// 2026-09-24: 3 places). Report both ways: before the change look for escaped spellings of the old names, after it look for the `dac\/`/`dac\.` shapes in the output.
const suspects = []
let suspectsScanned = 0

for (const file of files) {
  const rel = relative(root, file).replace(/\\/g, '/')
  if (SKIP_FILES.has(rel)) continue
  const original = readFileSync(file, 'utf8')
  // Untracked files are never touched (see the guard-rail comment above); only naming the ones that "would have been changed" keeps the report informative.
  if (!tracked.has(rel)) {
    if (/ohdsh/i.test(original)) untrackedSkipped.push(rel)
    continue
  }
  let text = original
  // 0) suspicion before the change: an old brand/repo name followed by an escaped separator
  const escaped = original.match(/(?:ohdsh|litistartup-com)\\[[/._-]/gi)
  if (escaped !== null) suspects.push(`  ${rel}: escaped spelling of the old name ×${escaped.length} (a targeted rule may miss it, check the output by hand)`)
  // 1) the protection allowlist (swapped for placeholder tokens that cannot match)
  const guards = PROTECT.map((needle, index) => {
    const token = `\u0000GUARD${index}\u0000`
    text = text.split(needle).join(token)
    return { token, needle }
  })
  // 2) the rule replacement
  const fileHits = []
  for (const [pattern, replacement] of RULES) {
    const matches = text.match(pattern)
    if (matches === null) continue
    text = text.replace(pattern, replacement)
    fileHits.push(`${pattern.source} ×${matches.length}`)
    byRule.set(pattern.source, (byRule.get(pattern.source) ?? 0) + matches.length)
    totalHits += matches.length
  }
  // 3) restore the allowlist
  for (const { token, needle } of guards) text = text.split(token).join(needle)
  // Leftover check after the replacement: only look at the result (in a dry run the disk still holds the old content, so reading it back would lie).
  let masked = text
  for (const needle of PROTECT) masked = masked.split(needle).join('')
  const leftoverHits = masked.match(/ohdsh/gi)
  if (leftoverHits !== null) leftovers.push(`  ${rel}: ${leftoverHits.length}`)
  // Suspicion after the change: `dac\/`/`dac\.` shapes in the output = traces of the fallback rule (the correct form
  // is hellodac\/…). A negative lookbehind excludes `hellodac\/` (the correct output itself contains the `dac\/` substring, otherwise everything would be a false positive).
  const mangled = masked.match(/(?<!hello)dac\\[/.]/g)
  if (mangled !== null) {
    suspectsScanned += mangled.length
    suspects.push(`  ${rel}: output looks wrongly changed by the fallback rule ×${mangled.length} (${mangled.slice(0, 3).join(' ')})`)
  }
  if (text !== original) {
    changedFiles += 1
    report.push(`  ${rel}  (${fileHits.join(', ')})`)
    if (APPLY) writeFileSync(file, text, 'utf8')
  }
}

console.log(`${APPLY ? 'APPLIED' : 'DRY RUN'}: ${changedFiles} files, ${totalHits} replacements`)
console.log('\nBy rule:')
for (const [rule, count] of [...byRule.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(4)}  ${rule}`)
}
console.log('\nBy file:')
console.log(report.join('\n'))

// A dry run reports leftovers too: outside the allowlist (gateway package name/repo address/this script/history) no ohdsh should remain.
console.log(`\nFiles still containing ohdsh after the replacement (only allowlist-related ones should remain): ${leftovers.length}`)
console.log(leftovers.slice(0, 20).join('\n'))

// Escaped-form suspicion: when this report is non-empty every entry must be checked by hand, do not trust "0 leftovers".
console.log(`\nEscaped-form suspicions (need a human check): ${suspects.length} files, ${suspectsScanned} output shapes`)
console.log(suspects.slice(0, 20).join('\n'))

// Untracked files: always skipped (the guard rail); the ones that "would have been changed" are named here so a human can confirm whether they need separate handling.
console.log(`\nSkipped untracked files (gitignored local config/data, never changed automatically): ${untrackedSkipped.length}`)
console.log(untrackedSkipped.slice(0, 20).join('\n'))
if (!APPLY) console.log('\n(this is a dry run; add --apply once confirmed)')
