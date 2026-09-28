// scripts/release-check.mjs —— release self-check (for B6: one command shows red or green on release day).
//
// Freezes the machine-decidable part of the "release DoD" so the checklist does not rely on memory:
//   1. the full gate set (typecheck / lint / test / test:web / i18n:check / build / check-docs)
//   2. static items: required files present, LICENSE attribution, locale parity, image dependency locks, the landing page,
//      a v1.0.0 entry in CHANGELOG, no stale old brand name left in the repo (outside the allowlist)
// Usage:
//   npm run release:check            # full (both test suites included)
//   npm run release:check -- --quick # skip the test suites (a fast self-check when changing copy/docs)
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const quick = process.argv.includes('--quick')
const results = []

const run = (label, command, args = []) => {
  const started = Date.now()
  try {
    execFileSync(command, args, { cwd: root, stdio: 'pipe', shell: process.platform === 'win32' })
    results.push({ ok: true, label, ms: Date.now() - started })
  } catch (error) {
    const out = String(error.stdout ?? '') + String(error.stderr ?? '')
    results.push({ ok: false, label, ms: Date.now() - started, detail: out.trim().split('\n').slice(-6).join('\n      ') })
  }
}

const check = (label, fn) => {
  try {
    const detail = fn()
    results.push({ ok: detail === true || detail === undefined, label, detail: detail === true ? undefined : detail })
  } catch (error) {
    results.push({ ok: false, label, detail: error instanceof Error ? error.message : String(error) })
  }
}

// ---- 1. Gates ----
run('typecheck', 'npm', ['run', 'typecheck'])
run('lint (0 error)', 'npm', ['run', 'lint'])
if (!quick) {
  run('backend tests', 'npm', ['test'])
  run('web tests', 'npm', ['run', 'test:web'])
}
run('i18n key guard', 'npm', ['run', 'i18n:check'])
run('build', 'npm', ['run', 'build'])
run('check-docs', 'node', ['scripts/check-docs.mjs'])
// The outward contract is a checked artifact too: a broken spec must not ship (the full route-drift
// guard against src/public-api/routes.ts is a follow-up; this pins syntax + internal refs).
run('openapi spec', 'node', ['scripts/check-openapi.mjs'])

// ---- 2. Static items ----
check('required files present (LICENSE/SECURITY/CONTRIBUTING/CODE_OF_CONDUCT/README.zh)', () => {
  const missing = ['LICENSE', 'SECURITY.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'README.md', 'README.zh.md', '.github/PULL_REQUEST_TEMPLATE.md'].filter(
    (f) => !existsSync(join(root, f)),
  )
  return missing.length === 0 ? true : `missing: ${missing.join(', ')}`
})

check('LICENSE attribution = Litestartup', () => {
  const text = readFileSync(join(root, 'LICENSE'), 'utf8')
  return text.includes('Copyright (c) 2026 Litestartup') ? true : 'the LICENSE attribution was not updated'
})

check('locale parity (en/zh key sets identical, no empty values)', () => {
  const en = JSON.parse(readFileSync(join(root, 'src/i18n/locales/en.json'), 'utf8'))
  const zh = JSON.parse(readFileSync(join(root, 'src/i18n/locales/zh-CN.json'), 'utf8'))
  const ek = Object.keys(en)
  const zk = Object.keys(zh)
  if (ek.length !== zk.length) return `different key counts: en ${ek.length} / zh ${zk.length}`
  const diff = ek.filter((k) => !(k in zh))
  if (diff.length > 0) return `keys missing in zh: ${diff.slice(0, 5).join(', ')}`
  const empty = ek.filter((k) => String(en[k]).trim() === '' || String(zh[k]).trim() === '')
  return empty.length === 0 ? true : `empty values: ${empty.join(', ')}`
})

check('container node image dependency locks complete (every supported DSH version)', () => {
  const matrix = readFileSync(join(root, 'src/dsh-matrix.ts'), 'utf8')
  const versions = [...matrix.matchAll(/\{ dsh: '([^']+)'/g)].map((m) => m[1])
  const missing = versions.filter((v) => !existsSync(join(root, 'images/node/profile-lock', `${v}.package-lock.json`)))
  return missing.length === 0 ? true : `missing locks: ${missing.join(', ')} (npm run lock:profile)`
})

check('landing page present (used by hellodac.com)', () => {
  const file = join(root, 'landing', 'index.html')
  if (!existsSync(file)) return 'landing/index.html is missing'
  const html = readFileSync(file, 'utf8')
  return html.includes('One Manager. A Fleet of Agents.') ? true : 'the landing page is missing its tagline'
})

check('CHANGELOG has a public v1.0.0 entry', () => {
  const text = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
  return /## v1\.0\.0/.test(text) ? true : 'CHANGELOG has no v1.0.0 entry'
})

check('one single version number (pkg / version.ts / compose / install.sh / lock file / doc pin URLs)', () => {
  // Why this guard is worth having: before a release the version is scattered over 6 places, and missing one means
  // "it still installs the previous build" or "the install URL you copied 404s". As of 2026-09-24: pkg 1.1.1 /
  // compose fallback 1.0.3 / doc URL v1.1.1 all coexisted.
  const read = (rel) => readFileSync(join(root, rel), 'utf8')
  const version = JSON.parse(read('package.json')).version
  const bad = []
  const expect = (label, actual) => {
    if (actual !== version) bad.push(`${label}: ${String(actual)} (expected ${version})`)
  }
  expect('src/version.ts', /MANAGER_VERSION = '([^']+)'/.exec(read('src/version.ts'))?.[1])
  expect('docker-compose.yml image fallback', /dac-manager:\$\{MANAGER_VERSION:-([^}]+)\}/.exec(read('docker-compose.yml'))?.[1])
  expect('install.sh DAC_VERSION', /DAC_VERSION:-v([^}]+)\}/.exec(read('install.sh'))?.[1])
  const lock = JSON.parse(read('package-lock.json'))
  expect('package-lock.json', lock.version)
  expect('package-lock.json root package', lock.packages?.['']?.version)
  // Pin URLs in docs/scripts: they must have https:// immediately followed by the host name, otherwise
  // codeload.github.com's `zip/refs/heads/master` would count as a version reference too (branch references are legitimate, so they are skipped).
  const refRe = /https:\/\/(?:raw\.githubusercontent\.com\/litestartup-com\/hellodac|github\.com\/litestartup-com\/hellodac\/blob)\/([A-Za-z0-9._-]+)\//g
  for (const rel of ['README.md', 'README.zh.md', 'docs/USER-GUIDE.md', 'install.sh', 'install.ps1', 'landing/index.html']) {
    for (const m of read(rel).matchAll(refRe)) {
      if (m[1] === 'main' || m[1] === 'master') continue
      if (m[1] !== `v${version}`) bad.push(`${rel}: pin ${m[1]} (expected v${version})`)
    }
  }
  return bad.length === 0 ? true : bad.slice(0, 6).join('; ')
})

check('old brand name is fully cleared (green after the B2 rename)', () => {
  // The allowlist is kept in sync with scripts/rename-to-dac.mjs: the gateway package name/repo, the encryption
  // format constants, the historical changelog, the local notes, the script itself.
  //
  // `ohdsh-agent` (introduced by the 2026-09-25 incident fix): once join.sh upgrades to a systemd **system** unit, the
  // old user unit on an existing machine must be stopped and deleted -- without writing this name it cannot be cleaned up,
  // and the leftover user unit starts a second agent on every SSH login to fight over the same node ports (the EADDRINUSE
  // root cause on site). So it is a **historical identifier that must stay**, in the same class as the gateway package name.
  const whitelist = ['ohdsh-api-facade', 'dsh-api-gateway', 'OHDSH-BAK2', 'OHDSH-BAK1', 'ohdsh-backup-v2', 'ohdsh-backup:', 'ohdsh-agent']
  // The front-end CSRF dual-read transition allowlist from the B2 rename was removed with the production cutover
  // (2026-09-24 13:30): both sides are on the new code now, so the repo must not carry a second format.
  const skipFiles = new Set(['CHANGELOG.md', 'CONTEXT.md', 'RULE.md', 'scripts/rename-to-dac.mjs', 'scripts/release-check.mjs'])
  // Scope = the **git-tracked set**, not the filesystem: the gitignored `manager.config.yaml` is this machine's
  // current production source of truth (before the cutover its path really still was `~/.dsh-ohdsh`), so scanning it
  // would make the guard police "local deployment state" instead of "repository content". Measured on 2026-09-24: while
  // a sweep mistakenly edited that config this guard was **green** and turned red the moment it was restored.
  const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\u0000')
    .filter((s) => s !== '')
  const offenders = []
  for (const rel of tracked) {
    if (skipFiles.has(rel)) continue
    if (!/\.(ts|js|mjs|json|ya?ml|md|sh|ps1|cmd|html|css|conf|example|txt)$/.test(rel) && !/(^|\/)Dockerfile/.test(rel)) continue
    let text = readFileSync(join(root, rel), 'utf8')
    for (const needle of whitelist) text = text.split(needle).join('')
    if (/ohdsh/i.test(text)) offenders.push(rel)
  }
  return offenders.length === 0 ? true : `still containing ohdsh: ${offenders.slice(0, 8).join(', ')}`
})

// ---- report ----
const pad = (s, n) => String(s).padEnd(n)
console.log(`\nrelease self-check (${quick ? 'quick' : 'full'}) -- repo ${root}\n`)
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'}  ${pad(r.label, 34)} ${r.ms === undefined ? '' : `${(r.ms / 1000).toFixed(1)}s`}`)
  if (!r.ok && r.detail !== undefined) console.log(`      ${r.detail}`)
}
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length > 0 ? `, ${failed.length} failed` : ''}`)
process.exit(failed.length === 0 ? 0 : 1)
