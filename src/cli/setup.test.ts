import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { buildManagerConfig, adoptOldWorkspaces, checkPortFree, ensureNodeCredentials, ensureNodeProfiles, mergeEnv, parseArgs, probeToolVersions, profileInstallCommand, resolveGatewayKey, setupEnvValues } from './setup.js'
import { COMPAT_DSH_VERSION, GATEWAY_REF, dshCompatible } from '../dsh-version.js'

test('buildManagerConfig wires two managed nodes, agents, sandbox and presets', () => {
  const config = buildManagerConfig({
    personalWorkspace: 'C:/ws/personal',
    brainWorkspace: 'C:/ws/brain',
    personalPort: 3081,
    brainPort: 3082,
    dshBin: 'C:/nvm4w/nodejs/node_modules/@deepseek-ai/dsh/lib/bin.js',
    personalProfile: 'dac-personal',
    brainProfile: 'dac-brain',
    personalHome: 'C:/Users/me/.dac/dac-personal',
    brainHome: 'C:/Users/me/.dac/dac-brain',
    brainToken: 'brain-token-1',
  })
  const ep = config.endpoints as Record<string, Record<string, unknown>>
  const spawn = (id: string) => (ep[id]?.spawn ?? {}) as Record<string, unknown>
  assert.equal(ep['personal']?.url, 'http://127.0.0.1:3081')
  assert.equal(ep['brain']?.url, 'http://127.0.0.1:3082')
  assert.deepEqual(spawn('brain').args, ['C:/nvm4w/nodejs/node_modules/@deepseek-ai/dsh/lib/bin.js', '--profile', 'dac-brain', '--no-open'])
  assert.deepEqual(spawn('personal').env, { DSH_HOME: 'C:/Users/me/.dac/dac-personal' })
  // The brain node process has to get BRAIN_TOKEN, or the curl in the skills handbook cannot pass the internal API gate
  assert.deepEqual(spawn('brain').env, {
    DSH_HOME: 'C:/Users/me/.dac/dac-brain',
    BRAIN_TOKEN: 'brain-token-1',
  })
  // An independent gateway key per node (referenced by ref)
  assert.equal(ep['personal']?.sandbox_key_ref, 'GW_KEY_A')
  assert.equal(ep['brain']?.sandbox_key_ref, 'GW_KEY_B')
  const agents = config.agents as Record<string, Record<string, unknown>>
  assert.equal(agents['personal']?.preset, 'standard')
  assert.equal(agents['personal']?.sandbox_mode, 'workspace-write')
  assert.equal(agents['brain']?.endpoint, 'brain')
  // Hive P5.1: the brain's daily dispatch budget circuit breaker is on by default with setup
  const brain = config.brain as Record<string, unknown>
  assert.equal(brain['daily_budget_usd'], 1.0)
})

test('0.2.0 corridor: buildManagerConfig prefers the profile-local bin once installed -- a launcher from a DIFFERENT tree than the profile bundles double-instances dsh-app-boot, and every live settings write from the native GUI is rejected with "profile reload requires the root Include entry" (dsh-facts §19.9)', () => {
  const home = mkdtempSync(join(tmpdir(), 'setup-bin-'))
  try {
    const brainHome = join(home, 'dac-brain')
    const personalBin = join(home, 'dac-personal', 'profiles', 'dac-personal', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    mkdirSync(join(personalBin, '..'), { recursive: true })
    writeFileSync(personalBin, '', 'utf8')
    mkdirSync(brainHome, { recursive: true }) // brain: NOT installed -> the global bin fallback stays
    const config = buildManagerConfig({
      personalWorkspace: join(home, 'ws-personal'),
      brainWorkspace: join(home, 'ws-brain'),
      personalPort: 3081,
      brainPort: 3082,
      dshBin: 'C:/global/dsh/lib/bin.js',
      personalProfile: 'dac-personal',
      brainProfile: 'dac-brain',
      personalHome: join(home, 'dac-personal'),
      brainHome,
      brainToken: 'brain-token-1',
    })
    const ep = config.endpoints as Record<string, { spawn?: { args?: string[] } }>
    assert.equal(ep['personal']?.spawn?.args?.[0], personalBin, 'the installed profile boots from its OWN tree (single-tree launch)')
    assert.equal(ep['brain']?.spawn?.args?.[0], 'C:/global/dsh/lib/bin.js', 'an uninstalled profile keeps the global-bin fallback')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('ensureNodeProfiles writes one isolated DSH_HOME per node, idempotently', () => {
  const nodesHome = mkdtempSync(join(tmpdir(), 'setup-nodes-home-'))
  try {
    const specs = [
      { name: 'dac-personal', port: 3081 },
      { name: 'dac-brain', port: 3082 },
    ]
    const created = ensureNodeProfiles(nodesHome, specs, GATEWAY_REF)
    assert.deepEqual(created.sort(), [join(nodesHome, 'dac-personal'), join(nodesHome, 'dac-brain')].sort())
    for (const spec of specs) {
      const dir = join(nodesHome, spec.name, 'profiles', spec.name)
      const patch = parseYaml(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')) as Array<{ id: string; config: { port: number; host: string } }>
      assert.equal(patch[0]?.id, 'webserver')
      assert.equal(patch[0]?.config.port, spec.port)
      assert.equal(patch[0]?.config.host, '127.0.0.1')
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        dsh: { profile: { bundles: string[] } }
        dependencies: Record<string, string>
      }
      assert.ok(pkg.dsh.profile.bundles.includes('ohdsh-api-facade'))
      assert.equal(pkg.dependencies['ohdsh-api-facade'], GATEWAY_REF, 'the gateway reference is pinned to a commit, no longer chasing master')
      // Hive plan 2 P1: bundle versions pinned to COMPAT_DSH_VERSION, curing install drift at the root
      assert.equal(pkg.dependencies['@deepseek-ai/dsh-base'], COMPAT_DSH_VERSION)
      assert.equal(pkg.dependencies['@deepseek-ai/dsh-web-app'], COMPAT_DSH_VERSION)
      // The pnpm >= 10 build-script allowlist (a real image build hit ERR_PNPM_IGNORED_BUILDS)
      const workspace = readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')
      assert.ok(workspace.includes('onlyBuiltDependencies:'), 'the build-script allowlist must be declared')
      assert.ok(workspace.includes('node-pty') && workspace.includes('koffi'), 'the native dependencies must be inside the allowlist')
    }
    // Idempotent: a second run rebuilds nothing and reports no error
    assert.deepEqual(ensureNodeProfiles(nodesHome, specs, GATEWAY_REF), [])
  } finally {
    rmSync(nodesHome, { recursive: true, force: true })
  }
})

test('ensureNodeProfiles writes a file: dependency when given a local gateway path', () => {
  const nodesHome = mkdtempSync(join(tmpdir(), 'setup-nodes-home-local-'))
  try {
    ensureNodeProfiles(nodesHome, [{ name: 'dac-personal', port: 3081 }], 'file:C:/src/dsh-api-gateway')
    const pkg = JSON.parse(readFileSync(join(nodesHome, 'dac-personal', 'profiles', 'dac-personal', 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    assert.equal(pkg.dependencies['ohdsh-api-facade'], 'file:C:/src/dsh-api-gateway')
  } finally {
    rmSync(nodesHome, { recursive: true, force: true })
  }
})

test('ensureNodeCredentials copies the model key once, never overwriting', () => {
  const root = mkdtempSync(join(tmpdir(), 'setup-cred-'))
  const main = join(root, 'main')
  const node = join(root, 'node')
  try {
    mkdirSync(main, { recursive: true })
    writeFileSync(join(main, '.credentials.yaml'), 'provider: x\n', 'utf8')
    assert.equal(ensureNodeCredentials(main, node), true)
    assert.equal(readFileSync(join(node, '.credentials.yaml'), 'utf8'), 'provider: x\n')
    // Existing credentials are not overwritten
    writeFileSync(join(node, '.credentials.yaml'), 'provider: mine\n', 'utf8')
    assert.equal(ensureNodeCredentials(main, node), false)
    assert.equal(readFileSync(join(node, '.credentials.yaml'), 'utf8'), 'provider: mine\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolveGatewayKey reuses the provisioned key, else mints and appends apiKeys (the facade namespace)', () => {
  const home = mkdtempSync(join(tmpdir(), 'setup-key-'))
  const settings = join(home, 'settings.yaml')
  try {
    writeFileSync(settings, stringifyYaml({ 'ohdsh-api-facade': { enabled: true, provisionedKey: 'apigw-existing' } }), 'utf8')
    assert.equal(resolveGatewayKey(home, settings), 'apigw-existing')

    rmSync(settings)
    const minted = resolveGatewayKey(home, settings)
    assert.match(minted, /^apigw-[0-9a-f]{48}$/)
    const parsed = parseYaml(readFileSync(settings, 'utf8')) as { 'ohdsh-api-facade': { apiKeys: string[] } }
    assert.deepEqual(parsed['ohdsh-api-facade'].apiKeys, [minted])
    // A key from the old namespace is not read by the new facade (the same trap as the container path, as a regression)
    writeFileSync(settings, stringifyYaml({ 'dsh-api-gw': { provisionedKey: 'apigw-stale' } }), 'utf8')
    const fresh = resolveGatewayKey(home, settings)
    assert.notEqual(fresh, 'apigw-stale', 'the dsh-api-gw section means nothing to the 0.1.2 facade, so a key must be minted again')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('parseArgs: npm run setup --force is recognised via npm_config_force (npm swallows the flag)', () => {
  const saved = process.env.npm_config_force
  try {
    process.env.npm_config_force = 'true'
    assert.equal(parseArgs([]).options.force, true)
    delete process.env.npm_config_force
    assert.equal(parseArgs([]).options.force, false)
    assert.equal(parseArgs(['--force']).options.force, true)
  } finally {
    if (saved === undefined) delete process.env.npm_config_force
    else process.env.npm_config_force = saved
  }
})

test('Hive plan 2 P1: parseArgs recognises --skip-version-check', () => {
  assert.equal(parseArgs([]).options.skipVersionCheck, false)
  assert.equal(parseArgs(['--skip-version-check']).options.skipVersionCheck, true)
})

test('Hive plan 2 P1: dshCompatible compares against the pinned version', () => {
  assert.equal(dshCompatible(COMPAT_DSH_VERSION), true)
  assert.equal(dshCompatible(`v${COMPAT_DSH_VERSION}`), true)
  assert.equal(dshCompatible('0.1.1-rc.3'), false)
  assert.equal(dshCompatible(null), false)
})

test('Hive plan 2 P1: checkPortFree reports occupation truthfully', async () => {
  // Occupy a random port first
  const net = await import('node:net')
  const blocker = net.createServer()
  await new Promise<void>((resolveListen) => blocker.listen(0, '127.0.0.1', resolveListen))
  const address = blocker.address()
  assert.ok(address !== null && typeof address === 'object')
  const port = address.port
  try {
    assert.equal(await checkPortFree(port), false, 'a port some process is listening on must count as occupied')
  } finally {
    await new Promise<void>((resolveClose) => blocker.close(() => resolveClose()))
  }
  assert.equal(await checkPortFree(port), true, 'a released port must count as free')
})

test('Hive plan 2 P1: probeToolVersions reports node and marks a missing dsh as null', () => {
  const tools = probeToolVersions(null)
  assert.ok(tools.node !== null, 'node is the prerequisite for running tests, so it is certainly there')
  assert.match(tools.node, /^v?\d+\./)
  assert.equal(tools.dsh, null)
})

test('Hive plan 2 P6 regression: on Windows the pnpm probe has to go through the .CMD shim (node >= 20 without a shell gives EINVAL/ENOENT)', { skip: process.platform !== 'win32' }, () => {
  const tools = probeToolVersions(null)
  assert.ok(tools.pnpm !== null, 'pnpm is installed and the probe has to find it -- measured at release: the old probe reported EINVAL and made the setup self-check fail for nothing')
  assert.match(tools.pnpm, /^\d+\.\d+\.\d+$/)
})

test('0.1.2 main-path switch regression: node dependencies move to npm -- the pnpm9 prerelease range stopped matching and the pnpm11 allowlist stopped working (both walls proven in the container)', () => {
  const win = profileInstallCommand('win32')
  assert.equal(win.cmd, 'npm')
  // The default follows the matrix first row (0.2.0-rc.2), which is a needsLegacyPeerDeps pair
  assert.deepEqual(win.args, ['install', '--no-audit', '--no-fund', '--legacy-peer-deps'])
  const posix = profileInstallCommand('linux')
  assert.equal(posix.cmd, 'npm')
  assert.deepEqual(posix.args, ['install', '--no-audit', '--no-fund', '--legacy-peer-deps'])
  // The pin-free legacy line stays flag-free (npm resolves its peers itself)
  assert.deepEqual(profileInstallCommand('linux', '0.1.2-rc.1').args, ['install', '--no-audit', '--no-fund'])
})

test('Hive plan 2 P6 regression: setup has to pre-generate the first-boot password into .env (the manager starts in a hidden window, so a generated password would be lost)', () => {
  const values = setupEnvValues('apigw-a', 'apigw-b')
  assert.equal(values.GW_KEY_A, 'apigw-a')
  assert.equal(values.GW_KEY_B, 'apigw-b')
  assert.match(values.SESSION_SECRET, /^[0-9a-f]{64}$/)
  assert.match(values.BRAIN_TOKEN, /^[0-9a-f]{48}$/)
  assert.match(values.MANAGER_INITIAL_PASSWORD, /^[A-Za-z0-9_-]{22}$/, '16 bytes of base64url')
})

test('adoptOldWorkspaces keeps user-customised workspaces unless explicitly overridden', () => {  const options = { personalWorkspace: './workspaces/personal', brainWorkspace: './workspaces/brain' }
  const old = { agents: { personal: { workspace: 'C:/Workplace/gitee/note-kaka' }, brain: { workspace: 'D:/brain' } } }

  adoptOldWorkspaces(old, { personalWorkspace: false, brainWorkspace: false }, options)
  assert.equal(options.personalWorkspace, 'C:/Workplace/gitee/note-kaka')
  assert.equal(options.brainWorkspace, 'D:/brain')

  // An explicit argument wins: --workspace points at a new one, so the old value gives way
  const explicit = { personalWorkspace: './new-one', brainWorkspace: './workspaces/brain' }
  adoptOldWorkspaces(old, { personalWorkspace: true, brainWorkspace: false }, explicit)
  assert.equal(explicit.personalWorkspace, './new-one')
  assert.equal(explicit.brainWorkspace, 'D:/brain')

  // An old config with a missing or broken field: leave the current state alone
  const untouched = { personalWorkspace: 'a', brainWorkspace: 'b' }
  adoptOldWorkspaces({ agents: {} }, { personalWorkspace: false, brainWorkspace: false }, untouched)
  assert.deepEqual(untouched, { personalWorkspace: 'a', brainWorkspace: 'b' })
})

test('mergeEnv fills missing values and never overwrites existing ones', () => {
  const dir = mkdtempSync(join(tmpdir(), 'setup-env-'))
  const env = join(dir, '.env')
  try {
    const merged = mergeEnv(env, { SESSION_SECRET: 'new-secret', GW_KEY_A: 'new-key' })
    assert.equal(merged.SESSION_SECRET, 'new-secret')

    const again = mergeEnv(env, { SESSION_SECRET: 'other', BRAIN_TOKEN: 'token-1' })
    assert.equal(again.SESSION_SECRET, 'new-secret', 'existing value survives')
    assert.equal(again.BRAIN_TOKEN, 'token-1')
    assert.ok(existsSync(env))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('mergeEnv forceKeys overrides stale values (setup-owned secrets must match node settings)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'setup-env-force-'))
  const env = join(dir, '.env')
  try {
    mergeEnv(env, { GW_KEY_A: 'old-key', GW_KEY_B: 'old-b' })
    const again = mergeEnv(env, { GW_KEY_A: 'new-key', GW_KEY_B: 'new-b', SESSION_SECRET: 's' }, ['GW_KEY_A', 'GW_KEY_B'])
    assert.equal(again.GW_KEY_A, 'new-key')
    assert.equal(again.GW_KEY_B, 'new-b')
    assert.equal(again.SESSION_SECRET, 's')
    // A non-force key still prefers the old value
    const third = mergeEnv(env, { SESSION_SECRET: 'later' }, ['GW_KEY_A', 'GW_KEY_B'])
    assert.equal(third.SESSION_SECRET, 's')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
