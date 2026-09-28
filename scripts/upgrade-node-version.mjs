/**
 * Capability two (2026-09-20): node DSH version upgrade script (idempotent, --dry-run previews).
 * The parameterized generalization of upgrade-012-win.mjs -- the target version comes from the version matrix
 * src/dsh-matrix.ts; the script runs standalone without the ts sources/build output, and the pin is asserted
 * against the matrix by scripts/check-docs.mjs at all times (no hand-editing in several places).
 *
 * For every process-managed node in manager.config.yaml:
 * 1. pin the profile dependencies/bundles to the target version + GATEWAY_REF, wipe node_modules and
 *    npm install (for pairs the matrix marks needsLegacyPeerDeps append --legacy-peer-deps,
 *    fact card dsh-facts section 12);
 * 2. settings.yaml: mint/reuse apiKeys in the 'ohdsh-api-facade' namespace (the old dsh-api-gw
 *    section is left alone);
 * 3. global DSH: npm install @deepseek-ai/dsh@<target> in the prefix directory that holds bin.js
 *    (skip when the version already matches; a new node installed in isolation has no such entry);
 * 4. .env: DSH_NODE_IMAGE → hellodac/dac-node:<target> (container deployments swap the image tag),
 *    and GW_KEY_* written back with the new keys (process nodes).
 *
 * Does not touch the wiring shape of manager.config.yaml (that is upgrade-012.mjs); pinning a node's spawn
 * version edits manager.config.yaml and is done by the user on the nodes page/in the wizard -- this script
 * only changes the derived side.
 * Usage: node scripts/upgrade-node-version.mjs <target-version> [config path] [--dry-run] [--force]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { createServer } from 'node:net'

const require = createRequire(import.meta.url)
const { parse: parseYaml, stringify: stringifyYaml } = require('yaml')
// Kept in sync with src/dsh-matrix.ts (asserted by check-docs.mjs at all times; missing this table after a matrix change = CI red).
const COMPAT_DSH_PACKAGE = '@deepseek-ai/dsh'
const GATEWAY_PACKAGE = 'ohdsh-api-facade'
const GATEWAY_REF = 'github:litestartup-com/dsh-api-gateway#b592b4f'
const SUPPORTED = [
  { dsh: '0.1.2-rc.1', legacyPeerDeps: false },
  { dsh: '0.1.5-rc.2', legacyPeerDeps: true },
]

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const force = args.includes('--force')
const positional = args.filter((a) => !a.startsWith('--'))
const target = positional[0]
const configPath = positional[1] ?? 'manager.config.yaml'

if (target === undefined) {
  console.error(`upgrade-node-version: no target version given. Supported: ${SUPPORTED.map((p) => p.dsh).join(' / ')}`)
  process.exit(1)
}
const pair = SUPPORTED.find((p) => p.dsh === target.replace(/^v/, ''))
if (pair === undefined) {
  console.error(`upgrade-node-version: the target version ${target} is not in the version matrix (supported: ${SUPPORTED.map((p) => p.dsh).join(' / ')}) -- upgrade the matrix and re-verify before upgrading nodes`)
  process.exit(1)
}
const TARGET = pair.dsh
const bakSuffix = `.pre-${TARGET}.bak`

// Pre-check: a busy production port = the stack is still running, and npm wiping old files will hit EPERM
// (measured on 2026-09-10: it blew up halfway and left a half-destroyed tree). The stack must be stopped
// first; --force skips this.
const BUSY_PORTS = [8080, 3081, 3082, 3090]
const portBusy = (p) => new Promise((resolveBusy) => {
  const probe = createServer()
  probe.once('error', () => resolveBusy(true))
  probe.once('listening', () => { probe.close(); resolveBusy(false) })
  probe.listen(p, '127.0.0.1')
})
if (!force && !dryRun) {
  const busy = []
  for (const p of BUSY_PORTS) if (await portBusy(p)) busy.push(p)
  if (busy.length > 0) {
    console.error(`upgrade-node-version: port(s) ${busy.join(', ')} are busy -- the production stack is still running and the upgrade would die halfway with EPERM.`)
    console.error('Stop the stack first: schtasks /end /tn DacManager (or systemctl stop the matching service), wait for the node processes to exit, then rerun this script.')
    process.exit(1)
  }
}
const log = (line) => console.log(`[upgrade-node-version] ${line}`)

if (!existsSync(configPath)) {
  console.error(`upgrade-node-version: ${configPath} not found`)
  process.exit(1)
}
const cfg = parseYaml(readFileSync(configPath, 'utf8'))
const actions = []

const backup = (path) => {
  const bak = `${path}${bakSuffix}`
  if (!existsSync(bak)) {
    if (!dryRun) writeFileSync(bak, readFileSync(path, 'utf8'), 'utf8')
    log(`backup ${path} → ${bak}`)
  }
}

const npm = (cwd, installArgs) => {
  const full = ['install', ...installArgs, '--no-audit', '--no-fund']
  if (pair.legacyPeerDeps) full.push('--legacy-peer-deps')
  log(`npm ${full.join(' ')} (cwd ${cwd})`)
  if (dryRun) return
  execFileSync('npm', full, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
}

// ---- 1/2/3: node profile + settings + global DSH ----
const dshPrefixes = new Set()
const keyByVar = new Map()
for (const [id, ep] of Object.entries(cfg.endpoints ?? {})) {
  // The schema defaults runner='process': a raw yaml usually omits the field
  const runner = ep?.spawn?.runner ?? 'process'
  if (runner !== 'process') continue
  const home = ep.spawn.env?.DSH_HOME
  const binPath = ep.spawn.args?.[0]
  if (typeof home !== 'string' || typeof binPath !== 'string') continue
  const profileIdx = (ep.spawn.args ?? []).indexOf('--profile')
  const profileName = profileIdx >= 0 ? ep.spawn.args[profileIdx + 1] : null
  if (profileName === null || typeof profileName !== 'string') continue

  const profileDir = join(home, 'profiles', profileName)
  if (!existsSync(join(profileDir, 'package.json'))) {
    log(`⚠ node ${id}: ${profileDir}/package.json does not exist, skipping (an externally managed node?)`)
    continue
  }
  // 1) pin the profile to the target version + facade
  const pkgPath = join(profileDir, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const deps = { '@deepseek-ai/dsh': TARGET, '@deepseek-ai/dsh-base': TARGET, '@deepseek-ai/dsh-web-app': TARGET, [GATEWAY_PACKAGE]: GATEWAY_REF }
  const next = { ...pkg, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', GATEWAY_PACKAGE] } }, dependencies: deps }
  if (JSON.stringify(pkg) !== JSON.stringify(next)) {
    actions.push(`node ${id}: profile dependencies/bundles pinned to ${TARGET}`)
    backup(pkgPath)
    if (!dryRun) writeFileSync(pkgPath, JSON.stringify(next, null, 2) + '\n', 'utf8')
    if (!dryRun) rmSync(join(profileDir, 'node_modules'), { recursive: true, force: true })
    npm(profileDir, [])
  } else {
    log(`node ${id}: the profile is already ${TARGET}, skipping`)
  }

  // 2) mint/reuse the facade key in settings.yaml
  const settingsPath = join(home, 'settings.yaml')
  const settings = existsSync(settingsPath) ? parseYaml(readFileSync(settingsPath, 'utf8')) ?? {} : {}
  const ns = settings[GATEWAY_PACKAGE] ?? {}
  let key = typeof ns.provisionedKey === 'string' && ns.provisionedKey !== '' ? ns.provisionedKey
    : (Array.isArray(ns.apiKeys) ? ns.apiKeys.find((k) => k !== '') : undefined)
  if (key === undefined) {
    key = 'apigw-' + randomBytes(24).toString('hex')
    settings[GATEWAY_PACKAGE] = { ...ns, apiKeys: [...(Array.isArray(ns.apiKeys) ? ns.apiKeys : []), key] }
    backup(settingsPath)
    if (!dryRun) writeFileSync(settingsPath, stringifyYaml(settings), 'utf8')
    actions.push(`node ${id}: new key minted into the ${GATEWAY_PACKAGE} section`)
  } else {
    log(`node ${id}: reusing the existing key (${GATEWAY_PACKAGE})`)
  }
  if (typeof ep.sandbox_key_ref === 'string' && ep.sandbox_key_ref !== '') keyByVar.set(ep.sandbox_key_ref, key)

  // 3) global DSH prefix (the install directory holding bin.js; a node installed in isolation is not in this list)
  const marker = '/node_modules/@deepseek-ai/dsh/lib/bin.js'
  const normalizedBin = binPath.replace(/\\/g, '/')
  if (normalizedBin.endsWith(marker)) dshPrefixes.add(normalizedBin.slice(0, -marker.length))
}

// ---- 4) .env: DSH_NODE_IMAGE tag + GW_KEY_* key sync ----
{
  const envPath = join(dirname(resolve(configPath)), '.env')
  if (existsSync(envPath)) {
    const envOriginal = readFileSync(envPath, 'utf8')
    const envLines = envOriginal.split(/\r?\n/)
    let touched = false
    for (let i = 0; i < envLines.length; i += 1) {
      const m = /^(DSH_NODE_IMAGE=hellodac\/dac-node:)([^\s]+)$/.exec(envLines[i])
      if (m !== null && m[2] !== TARGET) {
        envLines[i] = `${m[1]}${TARGET}`
        actions.push(`.env: DSH_NODE_IMAGE → hellodac/dac-node:${TARGET}`)
        touched = true
      }
    }
    const seen = new Set()
    for (let i = 0; i < envLines.length; i += 1) {
      const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(envLines[i])
      if (m !== null && keyByVar.has(m[1])) {
        envLines[i] = `${m[1]}=${keyByVar.get(m[1])}`
        seen.add(m[1])
        touched = true
      }
    }
    for (const [name, value] of keyByVar) {
      if (!seen.has(name)) { envLines.push(`${name}=${value}`); touched = true }
    }
    if (touched) {
      backup(envPath)
      if (!dryRun) writeFileSync(envPath, envLines.join('\n') + '\n', 'utf8')
    }
  } else {
    log('⚠ .env does not exist, skipping the image tag and key sync')
  }
}

// ---- global DSH upgrade ----
for (const prefix of dshPrefixes) {
  const manifestPath = join(prefix, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const current = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')).version : 'missing'
  if (current === TARGET) {
    log(`the global DSH is already ${TARGET}, skipping`)
  } else {
    actions.push(`global DSH: ${current} → ${TARGET}`)
    npm(prefix, [`${COMPAT_DSH_PACKAGE}@${TARGET}`])
  }
}

console.log('')
console.log(dryRun ? '[dry-run] preview done, the following actions would run:' : `done (target ${TARGET}):`)
if (actions.length === 0) console.log(`  (no change -- already on the ${TARGET} wiring)`)
for (const a of actions) console.log('  - ' + a)
if (!dryRun && actions.length > 0) {
  console.log('')
  console.log('Next: restart the manager stack (schtasks /run /tn DacManager or systemctl start) and wait for the nodes to probe in;')
  console.log('"Align version" on the nodes page re-aligns a single node (reseed + reinstall + restart).')
}
