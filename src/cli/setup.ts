import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import net from 'node:net'
import { pathToFileURL } from 'node:url'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { withConfigLock, writeFileAtomic } from '../config-store.js'
import type { ManagerConfigFile } from '../config.js'
import { initWorkspace } from '../workspace/init.js'
import { COMPAT_DSH_VERSION, DSH_INSTALL_COMMAND, GATEWAY_REF, dshCompatible } from '../dsh-version.js'
// Capability one (2026-09-20): profile create/install/key/dependency commands moved into the
// shared host-node module (used by both setup and provision); this file imports the ones it
// needs and re-exports them to keep the existing import surface.
import { dshBinInProfile, ensureNodeCredentials, ensureNodeProfiles, profileInstallCommand, resolveGatewayKey, type ProfileSpec } from '../host-node/profile.js'
export {
  ensureNodeProfiles, ensureNodeCredentials, profileFiles, profileInstallCommand,
  resolveGatewayKey, dshBinInProfile, PROFILE_BUNDLES, profileDependencies,
  type ProfileSpec,
} from '../host-node/profile.js'

/**
 * `npm run setup -- [options]` — Hive P4: the default install.
 *
 * One command brings up "one host, many nodes":
 *   1. Initialize the personal and brain workspaces (idempotent templates, never overwrite existing files)
 *   2. Create two node profiles under $DSH_HOME/profiles (web's bundle + a port patch)
 *   3. Resolve the gateway key (provisionedKey in settings.yaml, or generate one and append to apiKeys)
 *   4. Write .env (SESSION_SECRET / GW_KEY_A / BRAIN_TOKEN, idempotent, keeps old values)
 *   5. Write manager.config.yaml (two managed nodes + two agents + sandbox/pre-set fully wired)
 *
 * Prerequisites: DSH installed on this machine ($DSH_HOME exists with credentials),
 * node / git on PATH (node dependencies pull pnpm@9 through npx, no global pnpm required).
 */

interface SetupOptions {
  personalWorkspace: string
  brainWorkspace: string
  personalPort: number
  brainPort: number
  /** The main DSH_HOME (for the GUI and daily use); read only to copy the model credentials. */
  dshHome: string
  /** Node directory root: every node gets its own DSH_HOME, so chats/settings/attachments are fully isolated. */
  nodesHome: string
  dshBin: string | null
  installProfiles: boolean
  /** Local gateway package path (a file: dependency, for offline installs); null = use the pinned reference. */
  gatewayLocal: string | null
  force: boolean
  /** Hive plan 2 P1: let a mismatched DSH version through (an explicit opt-in, at your own risk). */
  skipVersionCheck: boolean
}

/** Resolve the directory holding the DSH command: $DSH_BIN first, then the .ps1 wrapper from `where dsh`. */
export const detectDshBin = (dshHome: string, override: string | null): string => {
  const fromEnv = override ?? process.env.DSH_BIN ?? null
  if (fromEnv !== null && fromEnv !== '' && existsSync(fromEnv)) return resolve(fromEnv)

  if (process.platform === 'win32') {
    // Windows: `where dsh` finds npm's .ps1 shim; the real binary sits in node_modules next to it
    try {
      const found = execFileSync('where', ['dsh'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l !== '')[0]
      if (found !== undefined && /\.ps1$/i.test(found)) {
        const candidate = join(dirname(found), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
        if (existsSync(candidate)) return resolve(candidate)
      }
    } catch {
      // `where` did not find dsh: keep guessing from the usual locations
    }
  } else {
    // POSIX (Hive plan 2 P1 fix): `command` is a shell builtin, so it runs through sh;
    // a globally installed dsh is a symlink that node can run directly, no need to resolve it.
    try {
      const found = execFileSync('sh', ['-c', 'command -v dsh 2>/dev/null || true'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .trim()
        .split(/\r?\n/)[0]
      if (found !== undefined && found !== '' && existsSync(found)) return resolve(found)
    } catch {
      // keep guessing
    }
    try {
      const global = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      const candidate = join(global, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
      if (existsSync(candidate)) return resolve(candidate)
    } catch {
      // keep guessing
    }
  }

  const guesses = [
    join(dshHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    'C:/nvm4w/nodejs/node_modules/@deepseek-ai/dsh/lib/bin.js',
  ]
  for (const guess of guesses) if (existsSync(guess)) return resolve(guess)
  throw new Error(`DSH bin.js not found: install the pinned version first (${DSH_INSTALL_COMMAND}), or point --dsh-bin at it`)
}

/**
 * Hive plan 2 P6 regression: the key set setup writes into .env (including the first-boot password).
 * MANAGER_INITIAL_PASSWORD must land on disk before the manager's first boot: with no configured
 * password the manager generates one itself and only prints it to the log (index.ts), and the Windows
 * installer starts it in a hidden window -> the user never gets it. Not in forceKeys (never overwrite a user edit).
 */
export const setupEnvValues = (
  personalKey: string,
  brainKey: string,
): { SESSION_SECRET: string; GW_KEY_A: string; GW_KEY_B: string; BRAIN_TOKEN: string; MANAGER_INITIAL_PASSWORD: string } => ({
  SESSION_SECRET: randomBytes(32).toString('hex'),
  GW_KEY_A: personalKey,
  GW_KEY_B: brainKey,
  BRAIN_TOKEN: randomBytes(24).toString('hex'),
  MANAGER_INITIAL_PASSWORD: randomBytes(16).toString('base64url'),
})

/** Hive plan 2 P1: probe the versions of the key tools (node/pnpm/git/dsh); dshBin null = DSH not found. */
export const probeToolVersions = (dshBin: string | null): Record<'node' | 'pnpm' | 'git' | 'dsh', string | null> => {
  const run = (cmd: string, args: string[], shell = false): string | null => {
    try {
      const out = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell })
      return out.trim().split(/\r?\n/)[0] ?? null
    } catch {
      return null
    }
  }
  // On Windows pnpm is a .CMD shim: spawning it without a shell on node >=20 gives EINVAL (CVE-2024-27980
  // hardening, the same trap as L543 here); probing the extensionless name gives ENOENT first. shell: true
  // lets cmd resolve it; machines left with only the .ps1 shim (nvm4w layout) fall back to powershell.
  const probePnpm = (): string | null =>
    process.platform === 'win32'
      ? run('pnpm', ['--version'], true) ?? run('powershell', ['-NoProfile', '-Command', 'pnpm --version'])
      : run('pnpm', ['--version'])
  return {
    node: run('node', ['--version']),
    pnpm: probePnpm(),
    git: run('git', ['--version']),
    dsh: dshBin === null ? null : run('node', [dshBin, '--version']),
  }
}

/** Hive plan 2 P1: whether a port is free (try binding 127.0.0.1; in use -> false). */
export const checkPortFree = (port: number): Promise<boolean> =>
  new Promise((resolvePort) => {
    const server = net.createServer()
    server.once('error', () => resolvePort(false))
    server.once('listening', () => server.close(() => resolvePort(true)))
    server.listen(port, '127.0.0.1')
  })

/** .env merge: never overwrite an existing value (hand edits win); forceKeys is the exception -- setup
 * owns those keys (they must match the node settings it just wrote), so the new value always wins.
 * Debt A3: .env is a source of truth too -- keep comments and line order, write atomically (.tmp+rename), 0600. */
export const mergeEnv = (path: string, values: Record<string, string>, forceKeys: string[] = []): Record<string, string> => {
  const existing: Record<string, string> = {}
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/) : []
  for (const line of lines) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim())
    if (match !== null && match[1] !== undefined && match[2] !== undefined && match[2] !== '') {
      existing[match[1]] = match[2]
    }
  }
  const merged = { ...values, ...existing }
  for (const key of forceKeys) {
    if (values[key] !== undefined) merged[key] = values[key]
  }
  const handled = new Set<string>()
  const out: string[] = []
  for (const line of lines) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim())
    if (match === null || match[1] === undefined) {
      out.push(line) // keep comments/blank lines as they are
      continue
    }
    const value = merged[match[1]]
    if (value !== undefined && value !== '') {
      out.push(`${match[1]}=${value}`)
      handled.add(match[1])
    } else {
      out.push(line) // keep empty-value lines as they are
    }
  }
  for (const [key, value] of Object.entries(merged)) {
    if (handled.has(key) || value === '') continue
    out.push(`${key}=${value}`)
  }
  const content = out.join('\n')
  writeFileAtomic(path, content.endsWith('\n') ? content : `${content}\n`, 0o600)
  return merged
}

/**
 * On a --force reinstall, carry over the workspaces the user customized in the old config (pure, unit-testable).
 * Explicit arguments (--workspace/--brain-workspace) win over the carried-over values.
 */
export const adoptOldWorkspaces = (
  oldConfig: unknown,
  explicit: { personalWorkspace: boolean; brainWorkspace: boolean },
  options: { personalWorkspace: string; brainWorkspace: string },
): void => {
  const old = oldConfig as { agents?: { personal?: { workspace?: unknown }; brain?: { workspace?: unknown } } }
  const oldPersonal = old?.agents?.personal?.workspace
  const oldBrain = old?.agents?.brain?.workspace
  if (!explicit.personalWorkspace && typeof oldPersonal === 'string' && oldPersonal !== '') {
    options.personalWorkspace = oldPersonal
  }
  if (!explicit.brainWorkspace && typeof oldBrain === 'string' && oldBrain !== '') {
    options.brainWorkspace = oldBrain
  }
}

/** Build the config object for manager.config.yaml (pure, unit-testable; Debt E7: the return type is
 * ManagerConfigFile from config.ts, shared with loadConfig's consumption contract instead of a bare
 * Record<string, unknown>). */
export const buildManagerConfig = (options: {
  personalWorkspace: string
  brainWorkspace: string
  personalPort: number
  brainPort: number
  dshBin: string
  personalProfile: string
  brainProfile: string
  /** Each node's own DSH_HOME: chats/settings/attachments fully isolated (Hive v1.1). */
  personalHome: string
  brainHome: string
  /** Token the brain uses to call the internal API: it must be injected into the brain node's process env; the skill manual reads $BRAIN_TOKEN. */
  brainToken: string
}): ManagerConfigFile => {
  const endpoint = (
    port: number,
    profile: string,
    home: string,
    keyRef: string,
    extraEnv: Record<string, string> = {},
  ): ManagerConfigFile['endpoints'][string] => ({
    url: `http://127.0.0.1:${port}`,
    driver: 'apiproxy',
    prefix: '/api',
    key_ref: '',
    sandbox_base: `http://127.0.0.1:${port}/api-gw/v1`,
    sandbox_key_ref: keyRef,
    spawn: {
      managed: true,
      command: 'node',
      // --no-open: a node is a background service and must not pop a browser on every start (the web app's own flag).
      // 0.2.0 corridor (dsh-facts §19.9): boot from the profile-local bin once installed. A launcher
      // from a DIFFERENT tree than the profile bundles double-instances dsh-app-boot -- the root
      // Include registry of the booting instance is invisible to the profile-side config-editor
      // reconcile, so every live settings write from the native GUI (the welcome acknowledgement,
      // the settings pages) is rejected with "profile reload requires the root Include entry".
      // The global bin is only the fallback while the profile install has not landed yet.
      args: [dshBinInProfile(join(home, 'profiles', profile)) ?? options.dshBin, '--profile', profile, '--no-open'],
      ready_timeout_ms: 30_000,
      // Debt E7: explicitly aligned with spawnSchema's required defaults (drift the types surfaced)
      detached: false,
      runner: 'process',
      restart: { max_attempts: 3, base_delay_ms: 1_000, max_delay_ms: 30_000 },
      env: { DSH_HOME: home, ...extraEnv },
    },
  })
  return {
    listen: { host: '127.0.0.1', port: 8080 },
    endpoints: {
      personal: endpoint(options.personalPort, options.personalProfile, options.personalHome, 'GW_KEY_A'),
      brain: endpoint(options.brainPort, options.brainProfile, options.brainHome, 'GW_KEY_B', {
        BRAIN_TOKEN: options.brainToken,
      }),
    },
    agents: {
      personal: {
        name: 'Personal',
        endpoint: 'personal',
        workspace: options.personalWorkspace,
        public: false,
        preset: 'standard',
        sandbox_mode: 'workspace-write',
      },
      brain: {
        name: 'Brain',
        endpoint: 'brain',
        workspace: options.brainWorkspace,
        public: false,
        preset: 'standard',
        sandbox_mode: 'workspace-write',
      },
    },
    runner: {
      timeout_minutes: 15,
      silence_timeout_minutes: 5,
      outward_timeout_minutes: 5,
      max_consecutive_failures: 3,
      daily_budget_usd: 2.0,
    },
    // Hive P5.1: circuit breaker on the brain's daily dispatch budget (blocks trigger=brain only, manual runs pass).
    brain: {
      daily_budget_usd: 1.0,
    },
    database: { path: './data/manager.db' },
      // Debt E7: explicitly aligned with fileSchema's defaults (the generated file carries them; no reliance on downstream defaults)
    reconcile_interval_minutes: 10,
    backup: { docker_volumes: [], auto: false, interval_minutes: 15 },
    // Public API (design note manager/topics/public-api.md): the facade is on by default but binds localhost only;
    // an empty service list = a fresh install exposes nothing (to expose anything, issue a key first, then define services).
    public_api: { enabled: true, host: '127.0.0.1', port: 8081 },
    services: [],
    pricing: {
      // Debt E7: explicitly aligned with pricingSchema's defaults (the generated file carries them; no reliance on downstream defaults)
      weekends_off_peak: true,
      timezone: 'Asia/Shanghai',
      peak_windows_utc: [
        { start: '01:00', end: '04:00' },
        { start: '06:00', end: '10:00' },
      ],
      models: {
        'deepseek-v4-pro': {
          off_peak: { input: 0.66, output: 1.98, cache_read: 0.022 },
          peak: { input: 1.32, output: 3.96, cache_read: 0.044 },
        },
        'deepseek-v4-flash': {
          off_peak: { input: 0.22, output: 0.66, cache_read: 0.007 },
          peak: { input: 0.44, output: 1.32, cache_read: 0.014 },
        },
      },
    },
  }
}

export const parseArgs = (argv: string[]): { options: SetupOptions; help: boolean; explicit: { personalWorkspace: boolean; brainWorkspace: boolean } } => {
  const user = process.env.USERPROFILE ?? process.env.HOME ?? '.'
  const nodesHome = `${user}/.dac`
  const defaults: SetupOptions = {
    // 2026-09-05: default workspaces live outside the repo (under ~/.dac) -- inside the repo an outer
    // git adopts them and agent runs leave no independent audit trail (hit for real on the brain workspace).
    personalWorkspace: `${nodesHome}/workspaces/personal`,
    brainWorkspace: `${nodesHome}/brain-workspace`,
    personalPort: 3081,
    brainPort: 3082,
    dshHome: process.env.DSH_HOME ?? `${user}/.dsh`,
    nodesHome,
    dshBin: null,
    installProfiles: true,
    gatewayLocal: null,
    // With `npm run setup --force` npm swallows --force as its own flag (and prints a warning),
    // never passing it to the script -- catch it through the npm_config_force npm injects.
    force: process.env.npm_config_force === 'true',
    skipVersionCheck: false,
  }
  const explicit = { personalWorkspace: false, brainWorkspace: false }
  let help = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = (): string => {
      i += 1
      return argv[i] ?? ''
    }
    if (arg === '--help' || arg === '-h') help = true
    else if (arg === '--workspace') {
      defaults.personalWorkspace = next()
      explicit.personalWorkspace = true
    } else if (arg === '--brain-workspace') {
      defaults.brainWorkspace = next()
      explicit.brainWorkspace = true
    } else if (arg === '--ports') {
      const parts = next().split(',').map((n) => Number(n))
      const a = parts[0]
      const b = parts[1]
      if (a !== undefined && Number.isInteger(a) && a > 0) defaults.personalPort = a
      if (b !== undefined && Number.isInteger(b) && b > 0) defaults.brainPort = b
    } else if (arg === '--dsh-home') defaults.dshHome = next()
    else if (arg === '--nodes-home') defaults.nodesHome = next()
    else if (arg === '--dsh-bin') defaults.dshBin = next()
    else if (arg === '--gateway-local') defaults.gatewayLocal = next()
    else if (arg === '--no-install') defaults.installProfiles = false
    else if (arg === '--force') defaults.force = true
    else if (arg === '--skip-version-check') defaults.skipVersionCheck = true
  }
  return { options: defaults, help, explicit }
}

const usage = (): void => {
  console.log('usage: npm run setup -- [--workspace PATH] [--brain-workspace PATH] [--ports 3081,3082] [--dsh-bin PATH] [--gateway-local PATH] [--nodes-home PATH] [--no-install] [--force] [--skip-version-check]')
  console.log('  --gateway-local  use a local dsh-api-gateway checkout as a file: dependency (offline install; defaults to GitHub)')
  console.log('  --nodes-home     root for node directories (one DSH_HOME per node; default ~/.dac)')
}

// ---------------------------------------------------------------------------
// Debt E4: main() split into phase functions -- six phases each with one job, main only orchestrates.
// Each phase keeps its failure semantics (process.exit(2) in red): setup has no half-success state.
// ---------------------------------------------------------------------------

/** 0-1 prerequisite checks: an existing config / --force keeping customized workspaces / model credentials present. */
const checkPreconditions = (
  options: SetupOptions,
  explicit: { personalWorkspace: boolean; brainWorkspace: boolean },
): void => {
  const configPath = 'manager.config.yaml'
  if (existsSync(configPath) && !options.force) {
    console.error(`${configPath} already exists. Edit it directly, or re-run with --force (workspaces are kept, the config is rewritten).`)
    process.exit(2)
  }
  // Before --force rewrites the config, carry over the workspaces the user customized -- setup's defaults
  // are the template directories, so a bare --force pushes personal from note-kaka back to
  // workspaces/personal (hit for real on 2026-09-04). Explicit arguments win over the carried-over values.
  if (options.force && existsSync(configPath)) {
    try {
      const old = parseYaml(readFileSync(resolve(configPath), 'utf8')) as unknown
      adoptOldWorkspaces(old, explicit, options)
      console.log(`   --force: keeping the old workspaces personal=${options.personalWorkspace} brain=${options.brainWorkspace}`)
    } catch {
      // An unreadable old config counts as none -- writing a new config beats stopping here.
    }
  }
  if (!existsSync(join(options.dshHome, '.credentials.yaml'))) {
    console.error(`${options.dshHome}/.credentials.yaml not found — run DSH once and configure model credentials before setup.`)
    process.exit(2)
  }
}

/** 0-2 preflight table: DSH bin / tool versions / ports in use (any missing item exits in red). Returns dshBin. */
const selfCheck = async (options: SetupOptions): Promise<string> => {
  console.log('[0/4] preflight…')
  let dshBin: string
  try {
    dshBin = detectDshBin(options.dshHome, options.dshBin)
  } catch (error) {
    console.error(`   ✗ DSH not found: ${(error as Error).message}`)
    process.exit(2)
  }
  const tools = probeToolVersions(dshBin)
  for (const [name, version] of Object.entries(tools)) {
    // The pnpm row only reports, it is not a gate: node dependencies always pull pnpm@9 through npx (the global pnpm version is irrelevant).
    const ok = name === 'pnpm' ? true : name === 'dsh' ? dshCompatible(version) : version !== null
    const detail =
      version === null
        ? name === 'dsh'
          ? `not found — ${DSH_INSTALL_COMMAND}`
          : name === 'pnpm'
            ? 'not installed (dependency install pulls pnpm@9 through npx)'
            : 'not installed'
        : `${version}${name === 'dsh' && !dshCompatible(version) ? ` (verified version: ${COMPAT_DSH_VERSION})` : ''}`
    console.log(`   ${ok ? '✓' : '✗'} ${name.padEnd(6)} ${detail}`)
  }
  if (tools.git === null) {
    console.error('   ✗ git is missing: install git and try again.')
    process.exit(2)
  }
  if (!dshCompatible(tools.dsh)) {
    if (options.skipVersionCheck) {
      console.warn(`   ! DSH version differs from the verified ${COMPAT_DSH_VERSION}; continuing because of --skip-version-check (at your own risk).`)
    } else {
      console.error(`   ✗ the DSH version must match the verified pin (${DSH_INSTALL_COMMAND}); add --skip-version-check to force it.`)
      process.exit(2)
    }
  }
  const MANAGER_PORT = 8080
  const portRows: Array<[string, number]> = [
    ['manager', MANAGER_PORT],
    ['personal node', options.personalPort],
    ['brain node', options.brainPort],
  ]
  const busyPorts: string[] = []
  for (const [label, port] of portRows) {
    const free = await checkPortFree(port)
    console.log(`   ${free ? '✓' : '✗'} port ${port} (${label}) ${free ? 'free' : 'in use'}`)
    if (!free) busyPorts.push(`${port} (${label})`)
  }
  if (busyPorts.length > 0) {
    console.error(`   ✗ ports in use: ${busyPorts.join(', ')}. Change them with --ports 3081,3082; the manager port lives in listen.port of manager.config.yaml.`)
    process.exit(2)
  }
  return dshBin
}

/** 1. Initialize workspaces (idempotent templates, never overwrite existing files; note-kaka-style libraries are read-only authorities). */
const initWorkspaces = (options: SetupOptions): void => {
  console.log('[1/4] initialising workspaces…')
  // A note library like note-kaka that already has RULE.md/CONTEXT.md is a "read-only authority" (TASKS phase two):
  // write no template files, only confirm the directory exists -- otherwise AGENTS.md fights with RULE.md and
  // the template docs pollute the user's note system.
  const personalRoot = resolve(options.personalWorkspace)
  if (existsSync(join(personalRoot, 'RULE.md')) || existsSync(join(personalRoot, 'CONTEXT.md'))) {
    mkdirSync(personalRoot, { recursive: true })
    console.log(`   adopting the existing notes workspace ${personalRoot} (RULE.md/CONTEXT.md found; template files are not written)`)
  } else {
    initWorkspace({ workspacePath: options.personalWorkspace, preset: 'personal' })
  }
  initWorkspace({ workspacePath: options.brainWorkspace, preset: 'brain' })
}

/** 2. Node profiles + credentials + dependency install (failure = red exit, no half-success state). Returns the node home map. */
const installNodeProfiles = (options: SetupOptions, dshBin: string): Map<string, string> => {
  console.log('[2/4] creating node directories and profiles…')
  const specs: ProfileSpec[] = [
    { name: 'dac-personal', port: options.personalPort },
    { name: 'dac-brain', port: options.brainPort },
  ]
  const gatewayDep =
    options.gatewayLocal === null
      ? GATEWAY_REF
      : `file:${resolve(options.gatewayLocal).replace(/\\/g, '/')}`
  console.log(`   gateway dependency: ${gatewayDep}`)
  const nodeHomes = new Map<string, string>()
  for (const spec of specs) {
    nodeHomes.set(spec.name, join(options.nodesHome, spec.name))
  }
  for (const home of ensureNodeProfiles(options.nodesHome, specs, gatewayDep)) {
    console.log(`   node directory created: ${home}`)
  }
  // Model credentials: one user, one key, copied from the main DSH_HOME (never overwrite an existing one).
  for (const home of nodeHomes.values()) {
    if (ensureNodeCredentials(options.dshHome, home)) {
      console.log(`   credentials copied to ${home}`)
    }
  }
  console.log(`   DSH bin: ${dshBin}`)
  if (options.installProfiles) {
    let failures = 0
    for (const [name, home] of nodeHomes) {
      const dir = join(home, 'profiles', name)
      try {
        // When the pnpm major version changes (say 11->9) pnpm asks to confirm "node_modules will be rebuilt",
        // which hangs an unattended run -- delete it first, a fresh install asks nothing.
        rmSync(join(dir, 'node_modules'), { recursive: true, force: true })
        const { cmd, args } = profileInstallCommand(process.platform)
        execFileSync(cmd, args, { cwd: dir, shell: true, stdio: ['ignore', 'inherit', 'inherit'] })
      } catch (error) {
        failures += 1
        const message = ((error as Error).message ?? String(error)).split('\n')[0] ?? ''
        console.error(`   npm install failed in ${dir}: ${message}`)
        console.error('   If GitHub is unreachable, re-run setup --force with --gateway-local pointing at a local dsh-api-gateway checkout.')
      }
    }
    // Hive plan 2 P6 regression: node dependencies not installed = a half-success state -- exit in red (the old code
    // failed softly and carried on, so the node started with native tools quietly missing). Re-run setup --force (idempotent).
    if (failures > 0) {
      console.error('   ✗ node dependency install failed — fix it and re-run setup --force (idempotent).')
      process.exit(2)
    }
  }
  return nodeHomes
}

/** 3. Keys and .env (Debt R6: writes go through the lock entry). Returns the .env values and both homes (non-null after narrowing). */
const writeSecrets = async (
  nodeHomes: Map<string, string>,
): Promise<{ envValues: Record<string, string>; personalHome: string; brainHome: string }> => {
  console.log('[3/4] generating secrets…')
  // Each node's own settings.yaml holds a separate gateway key; the manager references them by ref.
  // Debt E10: ensureNodeProfiles guarantees both homes are in the map, so narrow explicitly instead of `!`
  const personalHome = nodeHomes.get('dac-personal')
  const brainHome = nodeHomes.get('dac-brain')
  if (personalHome === undefined || brainHome === undefined) {
    console.error('internal error: node homes were not registered — ensureNodeProfiles did not run as expected.')
    process.exit(2)
  }
  // 0.2.0 corridor: the placement is version-gated (patch row on the new lines, settings.yaml on
  // legacy) -- setup builds the nodes at the matrix default, so the default version decides.
  const personalKey = resolveGatewayKey(personalHome, null, { dshVersion: COMPAT_DSH_VERSION, profileName: 'dac-personal' })
  const brainKey = resolveGatewayKey(brainHome, null, { dshVersion: COMPAT_DSH_VERSION, profileName: 'dac-brain' })
  const envValues = await withConfigLock(() => mergeEnv('.env', setupEnvValues(personalKey, brainKey), ['GW_KEY_A', 'GW_KEY_B']))
  return { envValues, personalHome, brainHome }
}

/** 4. Write manager.config.yaml (Debt R6: writes go through the lock entry). */
const writeManagerConfig = async (
  options: SetupOptions,
  dshBin: string,
  personalHome: string,
  brainHome: string,
  envValues: Record<string, string>,
): Promise<void> => {
  console.log('[4/4] writing manager.config.yaml…')
  const managerConfig = buildManagerConfig({
    personalWorkspace: resolve(options.personalWorkspace),
    brainWorkspace: resolve(options.brainWorkspace),
    personalPort: options.personalPort,
    brainPort: options.brainPort,
    dshBin,
    personalProfile: 'dac-personal',
    brainProfile: 'dac-brain',
    personalHome,
    brainHome,
    brainToken: envValues.BRAIN_TOKEN ?? '',
  })
  await withConfigLock(() => writeFileAtomic('manager.config.yaml', stringifyYaml(managerConfig)))
}

/** Final print: what to do next. */
const printDone = (nodeHomes: Map<string, string>): void => {
  console.log('')
  console.log('Done. Next steps:')
  console.log('  npm run build && npm start     # the manager starts both nodes on boot')
  console.log('  (node status: npm run nodes -- list; the brain lives at the top of the sidebar)')
  console.log('  Each node has its own DSH_HOME (sessions/settings/attachments are isolated):')
  for (const [name, home] of nodeHomes) console.log(`    ${name}: ${home}`)
  console.log(`   open http://127.0.0.1:8080 (user ${process.env.MANAGER_USERNAME ?? 'admin'})`)
}

const main = async (): Promise<void> => {
  const { options, help, explicit } = parseArgs(process.argv.slice(2))
  if (help) {
    usage()
    return
  }
  checkPreconditions(options, explicit)
  const dshBin = await selfCheck(options)
  initWorkspaces(options)
  const nodeHomes = installNodeProfiles(options, dshBin)
  const { envValues, personalHome, brainHome } = await writeSecrets(nodeHomes)
  await writeManagerConfig(options, dshBin, personalHome, brainHome, envValues)
  printDone(nodeHomes)
}

// Only run when executed directly (importing this module from a test must not trigger the install flow).
const isDirect = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirect) void main()
