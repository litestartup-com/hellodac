/**
 * 0.1.2 main-path switch: one-shot wiring migration of manager.config.yaml (idempotent, safe to rerun).
 *
 * Rules (per endpoints section):
 * - `prefix: /api` → `/api-gw/v1/proxy` (skip when already migrated, keep any other value and warn);
 * - when `key_ref` is empty take the value of `sandbox_key_ref` in the same section (the same front-door key, same semantics);
 *   when sandbox_key_ref is empty too → that endpoint cannot be migrated: list it and exit with 2 (fail loud).
 *
 * Along with the .env image tag migration (gen-env is idempotent and never overwrites old values → an old deployment's tags must be raised explicitly):
 * - DSH_NODE_IMAGE=hellodac/dac-node:0.1.1-rc.2 -> 0.1.2-rc.1;
 * - MANAGER_VERSION=1.0.1 / 1.0.2 -> 1.0.3.
 * .env backup: copy to .env.pre-012.bak before the first change (never overwritten if it exists).
 *
 * Backup: copy the original file to <config>.pre-012.bak before the first run (never overwritten if it exists).
 * Usage: node scripts/upgrade-012.mjs [config path]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const dirnameOf = (p) => {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i === -1 ? '' : p.slice(0, i + 1)
}

const configPath = process.argv[2] ?? 'manager.config.yaml'
if (!existsSync(configPath)) {
  console.error(`upgrade-012: ${configPath} not found`)
  process.exit(1)
}
const original = readFileSync(configPath, 'utf8')
const lines = original.split(/\r?\n/)

// ---- .env image tag migration (gen-env is idempotent and never overwrites old values → an old deployment's tags must be raised explicitly) ----
const envPath = `${dirnameOf(configPath)}.env`
let envChanged = false
if (existsSync(envPath)) {
  const envOriginal = readFileSync(envPath, 'utf8')
  const envLines = envOriginal.split(/\r?\n/)
  for (let i = 0; i < envLines.length; i += 1) {
    if (envLines[i] === 'DSH_NODE_IMAGE=hellodac/dac-node:0.1.1-rc.2') { envLines[i] = 'DSH_NODE_IMAGE=hellodac/dac-node:0.1.2-rc.1'; envChanged = true }
    if (envLines[i] === 'MANAGER_VERSION=1.0.1') { envLines[i] = 'MANAGER_VERSION=1.0.3'; envChanged = true }
    if (envLines[i] === 'MANAGER_VERSION=1.0.2') { envLines[i] = 'MANAGER_VERSION=1.0.3'; envChanged = true }
  }
  if (envChanged) {
    const envBak = `${envPath}.pre-012.bak`
    if (!existsSync(envBak)) writeFileSync(envBak, envOriginal, 'utf8')
    writeFileSync(envPath, envLines.join('\n'), 'utf8')
    console.log(`upgrade-012: migrated the .env image tags (DSH_NODE_IMAGE→0.1.2-rc.1, MANAGER_VERSION→1.0.3), backup ${envBak}`)
  }
}

// Scan only inside the endpoints section (section boundaries: 'endpoints:' to the next top-level key, usually 'agents:')
const sectionStart = lines.findIndex((l) => /^endpoints:\s*$/.test(l))
if (sectionStart === -1) {
  console.error('upgrade-012: no endpoints: section found — nothing to do')
  process.exit(1)
}
let sectionEnd = lines.length
for (let i = sectionStart + 1; i < lines.length; i += 1) {
  if (/^[a-zA-Z]/.test(lines[i])) { sectionEnd = i; break }
}

const endpointLine = (l) => /^  [\w-]+:\s*$/.test(l)
const field = (l) => {
  const m = /^    ([\w-]+):\s*(.*)$/.exec(l)
  return m === null ? null : { name: m[1], value: m[2] }
}

let changed = false
const report = []
let current = null
for (let i = sectionStart + 1; i < sectionEnd; i += 1) {
  const line = lines[i]
  if (endpointLine(line)) {
    current = { name: line.trim().replace(/:$/, ''), sandboxKey: '', hadPrefixChange: false, prefix: '' }
    report.push(current)
    continue
  }
  if (current === null) continue
  const f = field(line)
  if (f === null) continue
  if (f.name === 'sandbox_key_ref') current.sandboxKey = f.value.replace(/^"(.*)"$/, '$1')
  if (f.name === 'prefix') {
    current.prefix = f.value
    if (f.value === '/api') {
      lines[i] = '    prefix: /api-gw/v1/proxy'
      current.hadPrefixChange = true
      changed = true
    }
  }
  if (f.name === 'key_ref' && f.value === '""') {
    // Empty marker: sandbox_key_ref was already seen in the same section (when key_ref comes first it is emptied and then filled back in)
    current.keyLine = i
  }
}

const missing = []
for (const ep of report) {
  if (ep.keyLine !== undefined) {
    if (ep.sandboxKey === '') {
      missing.push(ep.name)
    } else {
      lines[ep.keyLine] = `    key_ref: ${ep.sandboxKey}`
      changed = true
    }
  }
}

if (missing.length > 0) {
  console.error(`upgrade-012: these endpoints have no sandbox_key_ref, the key cannot be wired automatically (set key_ref by hand): ${missing.join(', ')}`)
  process.exit(2)
}

for (const ep of report) {
  console.log(`  ${ep.name}: prefix=${ep.hadPrefixChange ? '/api-gw/v1/proxy (migrated)' : ep.prefix === '/api-gw/v1/proxy' ? 'already migrated' : ep.prefix}${ep.keyLine !== undefined ? ` key_ref=${ep.sandboxKey}` : ''}`)
}

if (!changed) {
  console.log('upgrade-012: the config is already on the 0.1.2 wiring, nothing to change')
} else {
  const bak = `${configPath}.pre-012.bak`
  if (!existsSync(bak)) writeFileSync(bak, original, 'utf8')
  writeFileSync(configPath, lines.join('\n'), 'utf8')
  console.log(`upgrade-012: wrote ${configPath} (original backed up at ${bak})`)
}
