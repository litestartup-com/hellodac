/**
 * Capability two (2026-09-20): node DSH version upgrade script (idempotent, --dry-run previews).
 * The parameterized generalization of upgrade-012-win.mjs -- the target version comes from the version matrix
 * src/dsh-matrix.ts; the script runs standalone without the ts sources/build output, and the pin is asserted
 * against the matrix by scripts/check-docs.mjs at all times (no hand-editing in several places).
 *
 * For every process-managed node in manager.config.yaml:
 * 1. pin the profile dependencies/bundles to the target version + the PER-TARGET facade ref
 *    (GATEWAY_REF_BY_VERSION; a pre-corridor facade dies silently on a 0.2.0 host, dsh-facts §18.2),
 *    wipe node_modules and npm install (for pairs the matrix marks needsLegacyPeerDeps append
 *    --legacy-peer-deps AND ship the extracted LEGACY_PEER_PINS + frozen lock, fact card §12/§14);
 * 2. the facade key, placement VERSION-GATED (§18.5/J1-04): legacy lines mint/reuse apiKeys in the
 *    settings.yaml 'ohdsh-api-facade' namespace (the old dsh-api-gw section is left alone); on
 *    0.1.7+/0.2.x the durable path is the profile's cordis.patch.yml composition row (settings.yaml
 *    is a one-shot import there) -- an existing settings-era key is REUSED, so .env never drifts,
 *    and the privacy row (session-log-deepseek enabled:false, J1-22) is guaranteed along the way;
 * 3. global DSH: npm install @deepseek-ai/dsh@<target> in the prefix directory that holds bin.js
 *    (skip when the version already matches; a new node installed in isolation has no such entry);
 *    3b. manager.config.yaml: spawn args[0] repointed at the PROFILE-LOCAL bin (comment-preserving
 *    Document edit + backup) -- a launcher from a different tree than the profile bundles
 *    double-instances dsh-app-boot and breaks every live settings write from the native GUI on the
 *    0.2.0 line ("profile reload requires the root Include entry", dsh-facts §19.9);
 * 4. .env: DSH_NODE_IMAGE → hellodac/dac-node:<target> (container deployments swap the image tag),
 *    and GW_KEY_* written back with the new keys (process nodes).
 *
 * Does not touch the rest of the wiring shape of manager.config.yaml (that is upgrade-012.mjs); pinning
 * a node's spawn version edits manager.config.yaml and is done by the user on the nodes page/in the
 * wizard -- this script only changes the derived side plus the 3b bin repoint.
 * Usage: node scripts/upgrade-node-version.mjs <target-version> [config path] [--dry-run] [--force]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'

const require = createRequire(import.meta.url)
const { parse: parseYaml, stringify: stringifyYaml, parseDocument: parseYamlDocument } = require('yaml')
// Kept in sync with src/dsh-matrix.ts (asserted by check-docs.mjs at all times; missing this table after a matrix change = CI red).
const COMPAT_DSH_PACKAGE = '@deepseek-ai/dsh'
const GATEWAY_PACKAGE = 'ohdsh-api-facade'
const GATEWAY_REF = 'github:litestartup-com/dsh-api-gateway#398ea94'
// 0.2.0 corridor: the facade pin is PER TARGET -- a pre-corridor facade on a 0.2.0 host dies
// silently (the 3-arg wireStream.open kills the answerer pump; question/approval cards hang
// forever, dsh-facts §18.2). Kept in sync with GATEWAY_REF / GATEWAY_REF_LEGACY and the matrix
// rows in src/dsh-matrix.ts (a standing check-docs.mjs assertion).
const GATEWAY_REF_BY_VERSION = {
  '0.2.0-rc.2': 'github:litestartup-com/dsh-api-gateway#398ea94',
  '0.1.5-rc.2': 'github:litestartup-com/dsh-api-gateway#b592b4f',
  '0.1.2-rc.1': 'github:litestartup-com/dsh-api-gateway#b592b4f',
}
const SUPPORTED = [
  { dsh: '0.1.2-rc.1', legacyPeerDeps: false },
  { dsh: '0.1.5-rc.2', legacyPeerDeps: true },
  { dsh: '0.2.0-rc.2', legacyPeerDeps: true },
]
// The version-line gate (dsh-facts §18.5/§18.10, upgrade card J1-04): legacy 0.1.2/0.1.5 take the
// facade key through settings.yaml; on 0.1.7+/0.2.x that file is a one-shot import and
// ctx.settings.register is gone -- the durable key path is the profile's cordis.patch.yml row.
// NOTE the prerelease dash ("0.1.5-rc.2" never matches `0.1.5.*`). Kept in sync with
// isLegacyDshLine in src/dsh-matrix.ts (a standing check-docs.mjs assertion).
const LEGACY_DSH_LINE_RE = /^0\.1\.(2|5)($|-|\.)/

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
const gatewayRef = GATEWAY_REF_BY_VERSION[TARGET] ?? GATEWAY_REF
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// The legacy peer pins + the bare-metal lock live in the TS sources (single source of truth); this
// script runs standalone, so it extracts them by regex -- the same anchors check-docs.mjs guards.
// A legacy-line install WITHOUT the pins skips every peer the host statically imports and the node
// crashes on boot (dsh-facts §14), and without the lock the ^ ranges drift to whatever rc is on the
// registry that day -- so a failed extraction ABORTS instead of degrading quietly.
const extractPins = (version) => {
  const src = readFileSync(join(repoRoot, 'src/host-node/profile.ts'), 'utf8')
  const table = /LEGACY_PEER_PINS[\s\S]*?= \{([\s\S]*?)\n\}/m.exec(src)?.[1] ?? ''
  const esc = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const block = new RegExp(`'${esc}': \\{([\\s\\S]*?)\\n  \\},?`).exec(table)
  if (block === null) return null
  return Object.fromEntries([...block[1].matchAll(/'([^']+)':\s*'([^']+)'/g)].map((m) => [m[1], m[2]]))
}
const extractLock = (version) => {
  const src = readFileSync(join(repoRoot, 'src/host-node/profile-locks.ts'), 'utf8')
  const esc = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp(`'${esc}':\\s*("(?:[^"\\\\]|\\\\.)*")`).exec(src)
  if (m === null) return null
  try {
    return JSON.parse(m[1])
  } catch {
    return null
  }
}
const log = (line) => console.log(`[upgrade-node-version] ${line}`)
let legacyPins = {}
let bareMetalLock = null
if (pair.legacyPeerDeps) {
  legacyPins = extractPins(TARGET) ?? {}
  bareMetalLock = extractLock(TARGET)
  if (Object.keys(legacyPins).length === 0) {
    console.error(`upgrade-node-version: cannot extract LEGACY_PEER_PINS['${TARGET}'] from src/host-node/profile.ts -- refusing to install a legacy-line profile without its explicit peers (it would crash on boot, dsh-facts §14). Run this script from a repo checkout.`)
    process.exit(1)
  }
  if (bareMetalLock === null) {
    console.error(`upgrade-node-version: cannot extract PROFILE_LOCKS['${TARGET}'] from src/host-node/profile-locks.ts -- refusing to install without the frozen tree (the ^ ranges drift, dsh-facts §14). Run this script from a repo checkout.`)
    process.exit(1)
  }
  log(`target ${TARGET}: ${Object.keys(legacyPins).length} explicit peer pins + the frozen lock extracted from the TS sources`)
}

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

if (!existsSync(configPath)) {
  console.error(`upgrade-node-version: ${configPath} not found`)
  process.exit(1)
}
const cfgText = readFileSync(configPath, 'utf8')
const cfg = parseYaml(cfgText)
// The truth file carries operator comments -- edits go through a YAML Document (comment-preserving),
// never a parse/stringify round trip.
const cfgDoc = parseYamlDocument(cfgText)
let cfgTouched = false
const actions = []

const backup = (path) => {
  const bak = `${path}${bakSuffix}`
  if (!existsSync(bak)) {
    if (!dryRun) writeFileSync(bak, readFileSync(path, 'utf8'), 'utf8')
    log(`backup ${path} → ${bak}`)
  }
}

const npm = (cwd, installArgs, opts = {}) => {
  const full = ['install', ...installArgs, '--no-audit', '--no-fund']
  // The legacy flag belongs to the PROFILE install only (the facade peer-range ERESOLVE, dsh-facts
  // §12). The global prefix carries @deepseek-ai/dsh ALONE -- no facade, no conflict -- and must
  // install in the NORMAL mode: --legacy-peer-deps skips every peer, and a prefix tree missing the
  // plugin peers boots with 33 dead plugin imports (measured on the 0.2.0 corridor; the gateway
  // node image installs its global dsh the same way, flag-free).
  if (opts.legacy === true) full.push('--legacy-peer-deps')
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
  // 1) pin the profile to the target version + the per-target facade ref (+ legacy pins/lock, §14)
  const pkgPath = join(profileDir, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const deps = { '@deepseek-ai/dsh': TARGET, '@deepseek-ai/dsh-base': TARGET, '@deepseek-ai/dsh-web-app': TARGET, [GATEWAY_PACKAGE]: gatewayRef, ...legacyPins }
  const next = { ...pkg, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', GATEWAY_PACKAGE] } }, dependencies: deps }
  if (JSON.stringify(pkg) !== JSON.stringify(next)) {
    actions.push(`node ${id}: profile dependencies/bundles pinned to ${TARGET} (facade ${gatewayRef})`)
    backup(pkgPath)
    if (!dryRun) writeFileSync(pkgPath, JSON.stringify(next, null, 2) + '\n', 'utf8')
    if (!dryRun) rmSync(join(profileDir, 'node_modules'), { recursive: true, force: true })
    // The frozen tree ships along: npm install then resolves from the lock, not from the day's registry
    if (bareMetalLock !== null && !dryRun) writeFileSync(join(profileDir, 'package-lock.json'), bareMetalLock, 'utf8')
    npm(profileDir, [], { legacy: pair.legacyPeerDeps })
  } else {
    log(`node ${id}: the profile is already ${TARGET}, skipping`)
  }
  // .seed-version marker (the same sha1(version|gatewayRef) algorithm as profileSeed in
  // src/host-node/profile.ts): without it the nodes page reports drift after this script runs,
  // and one click of "Align version" would reseed+reinstall -- harmless but noisy. Stamping it
  // keeps the derived side consistent with the pin (hit during the 0.2.0 production migration).
  if (!dryRun) {
    writeFileSync(join(profileDir, '.seedversion'), createHash('sha1').update(`${TARGET}|${gatewayRef}`).digest('hex') + '\n', 'utf8')
  }

  // 2) the facade key -- the placement is VERSION-GATED (0.2.0 corridor, dsh-facts §18.5 / J1-04)
  const settingsPath = join(home, 'settings.yaml')
  let key
  if (LEGACY_DSH_LINE_RE.test(TARGET)) {
    // Legacy lines: mint/reuse in the settings.yaml facade namespace (the old dsh-api-gw section is left alone)
    const settings = existsSync(settingsPath) ? parseYaml(readFileSync(settingsPath, 'utf8')) ?? {} : {}
    const ns = settings[GATEWAY_PACKAGE] ?? {}
    key = typeof ns.provisionedKey === 'string' && ns.provisionedKey !== '' ? ns.provisionedKey
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
  } else {
    // New lines: settings.yaml is a one-shot import (renamed at first boot) and the facade's
    // settings layer is gone host-side -- the durable key path is the profile's cordis.patch.yml
    // composition row. Discovery order: patch row -> settings.yaml (the upgrade case: REUSE the
    // legacy-era key so the .env GW_KEY_* truth never drifts) -> mint. The rewrite also guarantees
    // the privacy row (J1-22: the DeepSeek session-log upload defaults ON from the 0.1.7 corridor).
    const patchPath = join(profileDir, 'cordis.patch.yml')
    const parsedRows = existsSync(patchPath) ? parseYaml(readFileSync(patchPath, 'utf8')) : []
    const rows = Array.isArray(parsedRows) ? parsedRows.filter((r) => r !== null && typeof r === 'object') : []
    const facadeRow = rows.find((r) => r.id === GATEWAY_PACKAGE)
    const patchKeys = Array.isArray(facadeRow?.config?.apiKeys) ? facadeRow.config.apiKeys.filter((k) => typeof k === 'string' && k !== '') : []
    const settings = existsSync(settingsPath) ? parseYaml(readFileSync(settingsPath, 'utf8')) ?? {} : {}
    const ns = settings[GATEWAY_PACKAGE] ?? {}
    const settingsKey = typeof ns.provisionedKey === 'string' && ns.provisionedKey !== '' ? ns.provisionedKey
      : (Array.isArray(ns.apiKeys) ? ns.apiKeys.find((k) => k !== '') : undefined)
    key = patchKeys[0] ?? settingsKey ?? ('apigw-' + randomBytes(24).toString('hex'))
    const nextRows = [
      ...rows.filter((r) => r.id !== GATEWAY_PACKAGE && r.id !== 'session-log-deepseek'),
      { id: 'session-log-deepseek', config: { enabled: false } },
      { id: GATEWAY_PACKAGE, config: { apiKeys: [key] } },
    ]
    const nextPatch = stringifyYaml(nextRows)
    if (!existsSync(patchPath) || readFileSync(patchPath, 'utf8') !== nextPatch) {
      backup(patchPath)
      if (!dryRun) writeFileSync(patchPath, nextPatch, 'utf8')
      actions.push(`node ${id}: facade key + privacy row materialized into cordis.patch.yml (the settings.yaml path is dead on ${TARGET})`)
    }
    if (patchKeys[0] === undefined && settingsKey !== undefined) {
      log(`node ${id}: carried the settings-era key over into the patch (${GATEWAY_PACKAGE})`)
    }
  }
  if (typeof ep.sandbox_key_ref === 'string' && ep.sandbox_key_ref !== '') keyByVar.set(ep.sandbox_key_ref, key)

  // 3) global DSH prefix (the install directory holding bin.js; a node installed in isolation is not in this list)
  const marker = '/node_modules/@deepseek-ai/dsh/lib/bin.js'
  const normalizedBin = binPath.replace(/\\/g, '/')
  if (normalizedBin.endsWith(marker)) dshPrefixes.add(normalizedBin.slice(0, -marker.length))

  // 3b) repoint spawn args[0] at the PROFILE-LOCAL bin (dsh-facts §19.9): booting from a different
  // tree than the profile bundles double-instances dsh-app-boot -- the root Include registry of the
  // booting instance is invisible to the profile-side config-editor reconcile, so every live
  // settings write from the native GUI (the welcome acknowledgement, the settings pages) is
  // rejected with "profile reload requires the root Include entry". Only an args[0] that already
  // IS a dsh bin.js gets repointed; any other command shape is left alone.
  const isolatedBin = join(profileDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (normalizedBin.endsWith(marker) && resolve(binPath) !== resolve(isolatedBin)) {
    const styled = process.platform === 'win32' ? isolatedBin.replace(/\//g, '\\') : isolatedBin
    actions.push(`node ${id}: spawn args[0] repointed to the profile-local bin (single-tree launch; 0.2.0 GUI settings writes require it)`)
    if (!dryRun) cfgDoc.setIn(['endpoints', id, 'spawn', 'args', 0], styled)
    cfgTouched = true
  }
}

if (cfgTouched && !dryRun) {
  backup(configPath)
  writeFileSync(configPath, cfgDoc.toString(), 'utf8')
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
