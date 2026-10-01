import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { profileFiles, profileDependencies, dshBinInProfile, ensureNodeProfiles, profileSeed, currentProfileSeed, profileDrift, profileInstallCommand, resolveGatewayKey, writeGatewayKeyToPatch } from './profile.js'
import { COMPAT_DSH_VERSION, GATEWAY_PACKAGE, GATEWAY_REF, GATEWAY_REF_020 } from '../dsh-version.js'

test('Capability one regression: the profile dependencies include @deepseek-ai/dsh itself (after an isolated install it does not rely on a global dsh)', () => {
  const deps = profileDependencies()
  assert.equal(deps['@deepseek-ai/dsh'], COMPAT_DSH_VERSION, 'the dsh package is pinned to the compatible version')
  assert.equal(deps['@deepseek-ai/dsh-base'], COMPAT_DSH_VERSION)
  assert.equal(deps['@deepseek-ai/dsh-web-app'], COMPAT_DSH_VERSION)
  assert.equal(deps[GATEWAY_PACKAGE], GATEWAY_REF)
})

test('Fleet M1-6 regression: bundles are pinned to the target version, not to the first row of the matrix -- a 0.1.5 node must not take 0.1.2 bundles', () => {
  const deps = profileDependencies('0.1.5-rc.2')
  assert.equal(deps['@deepseek-ai/dsh'], '0.1.5-rc.2')
  assert.equal(deps['@deepseek-ai/dsh-base'], '0.1.5-rc.2', 'dsh-base must follow the target version')
  assert.equal(deps['@deepseek-ai/dsh-web-app'], '0.1.5-rc.2', 'dsh-web-app must follow the target version')
})

test('Fleet M1-7 regression: the bind address in profileFiles is parameterizable -- 127.0.0.1 by default, 0.0.0.0 for a remote agent', () => {
  const dflt = profileFiles({ name: 'worker', port: 3083 }, GATEWAY_REF)
  assert.match(dflt['cordis.patch.yml'] ?? '', /host: 127\.0\.0\.1/, 'bare metal binds loopback only by default (a GUI red line)')
  const remote = profileFiles({ name: 'worker', port: 3083 }, GATEWAY_REF, COMPAT_DSH_VERSION, '0.0.0.0')
  assert.match(remote['cordis.patch.yml'] ?? '', /host: 0\.0\.0\.0/, 'a remote agent node binds 0.0.0.0 (the firewall allowlist is the backstop)')
})

test('Capability one regression: the package.json in profileFiles carries the dsh dependencies and the bundles list', () => {
  const files = profileFiles({ name: 'worker', port: 3083 }, GATEWAY_REF)
  const pkg = JSON.parse(files['package.json'] ?? '{}')
  assert.equal(pkg.dependencies['@deepseek-ai/dsh'], COMPAT_DSH_VERSION)
  assert.ok(Array.isArray(pkg.dsh?.profile?.bundles), 'the bundles list is kept')
  assert.ok(pkg.dsh.profile.bundles.includes(GATEWAY_PACKAGE))
  // the patch still binds loopback + the node port (stringifyYaml emits no quotes)
  assert.match(files['cordis.patch.yml'] ?? '', /host: 127\.0\.0\.1/)
  assert.match(files['cordis.patch.yml'] ?? '', /port: 3083/)
})

test('Capability one regression: dshBinInProfile -- after an isolated install it points at the bin inside the profile, null when not installed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-node-'))
  try {
    assert.equal(dshBinInProfile(join(dir, 'nope')), null, 'not installed = null')
    const binDir = join(dir, 'profiles', 'worker', 'node_modules', '@deepseek-ai', 'dsh', 'lib')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, 'bin.js'), '', 'utf8')
    assert.equal(dshBinInProfile(join(dir, 'profiles', 'worker')), join(binDir, 'bin.js'), 'points at bin.js inside the profile')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Capability two regression: profileInstallCommand appends --legacy-peer-deps for the matching matrix pair (dsh-facts §12)', () => {
  const legacy = profileInstallCommand('win32', '0.1.5-rc.2')
  assert.ok(legacy.args.includes('--legacy-peer-deps'), 'the 0.1.5 pair must carry the flag (the facade peer range does not cover it -> ERESOLVE)')
  const clean = profileInstallCommand('win32', '0.1.2-rc.1')
  assert.ok(!clean.args.includes('--legacy-peer-deps'), 'the 0.1.2 pair does not need it')
  const dflt = profileInstallCommand('linux')
  assert.ok(!dflt.args.includes('--legacy-peer-deps'), 'the default (first row of the matrix) does not carry it')
  assert.equal(clean.cmd, 'npm')
})

test('Capability two regression: the .seed-version marker and drift detection -- generation leaves the marker, a version/ref change means drift', () => {
  const nodesHome = mkdtempSync(join(tmpdir(), 'host-node-seed-'))
  try {
    ensureNodeProfiles(nodesHome, [{ name: 'worker', port: 3083 }], GATEWAY_REF)
    const profileDir = join(nodesHome, 'worker', 'profiles', 'worker')
    const marker = join(profileDir, '.seed-version')
    assert.ok(readFileSync(marker, 'utf8').trim().length === 40, 'generation leaves the sha1 marker')
    assert.equal(currentProfileSeed(profileDir), profileSeed(COMPAT_DSH_VERSION, GATEWAY_REF))
    assert.equal(profileDrift(profileDir, COMPAT_DSH_VERSION, GATEWAY_REF), false, 'same version and ref = no drift')
    assert.equal(profileDrift(profileDir, '0.1.5-rc.2', GATEWAY_REF), true, 'a version change = drift')
    assert.equal(profileDrift(profileDir, COMPAT_DSH_VERSION, 'github:litestartup-com/dsh-api-gateway#deadbeef'), true, 'a ref change = drift')
    // never generated (the directory exists but has no marker) = treated as drift (the alignment entry point for old profiles already on disk)
    const legacy = join(nodesHome, 'legacy', 'profiles', 'legacy')
    mkdirSync(legacy, { recursive: true })
    assert.equal(profileDrift(legacy, COMPAT_DSH_VERSION, GATEWAY_REF), true, 'an existing profile without a marker = drift')
  } finally {
    rmSync(nodesHome, { recursive: true, force: true })
  }
})

test('Fleet M1 pilot regression: the 0.1.5-rc.2 profile must add the peers legacy skips + carry a lock file + patchReload startup (proven on Windows: a fresh install drifts the whole tree to rc.3 with peers missing -> it crashes on boot)', () => {
  const files = profileFiles({ name: 'pilot01', port: 3197 }, GATEWAY_REF, '0.1.5-rc.2')
  const pkg = JSON.parse(files['package.json'] ?? '{}')
  assert.equal(pkg.dependencies['@deepseek-ai/cordis-plugin-group'], '1.0.2', 'the peer dsh-app-boot imports statically (legacy skips it) must be added explicitly')
  assert.equal(pkg.dependencies['@deepseek-ai/dsh-sandbox'], '0.1.5-rc.3', 'the old family-name peer must be added explicitly (an rc.3 family version)')
  assert.equal(pkg.dependencies['@deepseek-ai/cordis-plugin-hmr'], '1.0.17', 'the HMR peer must be added explicitly')
  assert.equal(pkg.dsh?.profile?.patchReload, 'startup', 'a node profile does not enable the live patch watcher (that avoids the hard HMR dependency; proven that the live default crashes)')
  assert.ok(files['package-lock.json'] !== undefined, 'profileFiles must ship the lock file -- the ^ range of 0.1.5-rc.2 drifts to rc.3 (registry next)')
  const lock = JSON.parse(files['package-lock.json'] ?? '{}')
  assert.equal(lock.packages['node_modules/@deepseek-ai/dsh']?.version, '0.1.5-rc.2', 'the lock file pins dsh itself')
  assert.equal(lock.packages['node_modules/@deepseek-ai/dsh-app-boot']?.version, '0.1.5-rc.3', 'the lock file pins the family snapshot (the rc.3 family is proven to boot)')
  assert.equal(lock.packages['node_modules/@deepseek-ai/cordis-plugin-group']?.version, '1.0.2', 'the lock contains the explicit peer')
  // the 0.1.2 line needs neither the lock nor the patch (^0.1.2-rc.1 has no newer version in the same tuple to drift to; without legacy npm installs the peers itself)
  const clean = profileFiles({ name: 'worker', port: 3083 }, GATEWAY_REF, '0.1.2-rc.1')
  const cleanPkg = JSON.parse(clean['package.json'] ?? '{}')
  assert.ok(clean['package-lock.json'] === undefined, '0.1.2 carries no lock')
  assert.ok(cleanPkg.dependencies['@deepseek-ai/cordis-plugin-group'] === undefined, '0.1.2 does not add the peer')
})

/** Typed view of a cordis.patch.yml row list (the tests parse what profileFiles/writeGatewayKeyToPatch emit). */
interface PatchRow { id: string; config?: Record<string, unknown> }
const readPatch = (file: string): PatchRow[] => parseYaml(readFileSync(file, 'utf8')) as PatchRow[]
const facadeRow = (rows: PatchRow[]): Record<string, unknown> | undefined =>
  rows.find((r) => r.id === GATEWAY_PACKAGE)?.config

test('0.2.0 corridor: the 0.2.0-rc.2 profile pins the app-boot peers legacy mode skips (dsh-facts §18.9) and installs with --legacy-peer-deps', () => {
  const files = profileFiles({ name: 'worker', port: 3083 }, GATEWAY_REF_020, '0.2.0-rc.2')
  const pkg = JSON.parse(files['package.json'] ?? '{}')
  // The 7-package seed table = dsh-app-boot@0.2.0-rc.2 peerDependencies (the gateway docker/gen-profile.mjs
  // derivation, boot-proven with zero ERR_MODULE_NOT_FOUND); most 0.1.5-era pins became real dsh-base deps.
  assert.equal(pkg.dependencies['@deepseek-ai/cordis'], '4.0.4')
  assert.equal(pkg.dependencies['@deepseek-ai/cordis-plugin-group'], '1.0.4')
  assert.equal(pkg.dependencies['@deepseek-ai/cordis-plugin-loader'], '1.0.5')
  assert.equal(pkg.dependencies['@deepseek-ai/cordis-plugin-include'], '1.0.9')
  assert.equal(pkg.dependencies['@deepseek-ai/dsh-home-paths'], '0.2.0-rc.2')
  assert.equal(pkg.dependencies['@deepseek-ai/dsh-system-prompt'], '0.2.0-rc.2')
  assert.equal(pkg.dependencies['@deepseek-ai/dsh-launch-environment'], '0.2.0-rc.2')
  assert.equal(pkg.dependencies['@deepseek-ai/dsh'], '0.2.0-rc.2')
  assert.equal(pkg.dependencies['@deepseek-ai/dsh-base'], '0.2.0-rc.2')
  assert.equal(pkg.dependencies[GATEWAY_PACKAGE], GATEWAY_REF_020, 'the 0.2.0 pair installs the corridor facade (v0.2.5)')
  assert.ok(pkg.dependencies['@deepseek-ai/cordis-plugin-hmr'] === undefined, 'the 0.1.5-era HMR pin must not leak into the 0.2.0 table')
  // The bare-metal peer closure (boot probe 2026-10-01): these exist only as peers of dsh-base's
  // plugin deps (dsh-jobs-local -> dsh-jobs ...) -- a profile-local-bin boot without them dies with
  // 33 "failed to import" plugins (ERR_MODULE_NOT_FOUND, the §14 double-kill shape on the 0.2.0 tree).
  for (const name of ['dsh-jobs', 'dsh-session-title-llm', 'dsh-attachment', 'dsh-deepseek-account', 'dsh-invariants', 'dsh-scope', 'dsh-http-proxy', 'dsh-fs', 'dsh-sandbox', 'dsh-workflow']) {
    assert.equal(pkg.dependencies[`@deepseek-ai/${name}`], '0.2.0-rc.2', `the peer closure must pin @deepseek-ai/${name}`)
  }
  assert.ok(
    profileInstallCommand('linux', '0.2.0-rc.2').args.includes('--legacy-peer-deps'),
    'npm strict prerelease peer resolution rejects the 0.2.0 line too (the gateway README pairs it with 0.1.5)',
  )
  // The inline lock ships with the profile and pins the closure snapshot (the ^ range drift guard)
  assert.ok(files['package-lock.json'] !== undefined, 'the 0.2.0 profile must ship its frozen lock')
  const lock = JSON.parse(files['package-lock.json'] ?? '{}')
  assert.equal(lock.packages['node_modules/@deepseek-ai/dsh']?.version, '0.2.0-rc.2', 'the lock pins dsh itself')
  assert.equal(lock.packages['node_modules/@deepseek-ai/dsh-jobs']?.version, '0.2.0-rc.2', 'the lock contains the closure peer')
  assert.equal(lock.packages['node_modules/ohdsh-api-facade']?.version, '0.2.5', 'the lock resolves the facade to v0.2.5 (commit 398ea94)')
})

test('0.2.0 corridor: the manifest/patch shape is version-gated (J1-15 patchReload dropped; J1-22 privacy row baked)', () => {
  const next = profileFiles({ name: 'worker', port: 3083 }, GATEWAY_REF_020, '0.2.0-rc.2')
  const nextPkg = JSON.parse(next['package.json'] ?? '{}')
  assert.ok(nextPkg.dsh.profile.patchReload === undefined, 'patchReload was dropped from the manifest contract in the 0.1.7 corridor (J1-15) -- the new lines must not carry it')
  assert.ok(Array.isArray(nextPkg.dsh.profile.bundles) && nextPkg.dsh.profile.bundles.includes(GATEWAY_PACKAGE), 'the bundles list survives the gate')
  const nextPatch = next['cordis.patch.yml'] ?? ''
  assert.match(nextPatch, /session-log-deepseek/, 'the DeepSeek session-log upload defaults ON from the 0.1.7 corridor (J1-22, §18.6) -- a managed node opts out explicitly')
  assert.match(nextPatch, /enabled: false/)
  assert.match(nextPatch, /port: 3083/, 'the webserver row survives')
  // The legacy lines keep their verified shape untouched (the §18.10 crash-loop: losing patchReload kills 0.1.5 at boot)
  const legacy = profileFiles({ name: 'pilot01', port: 3197 }, GATEWAY_REF, '0.1.5-rc.2')
  const legacyPkg = JSON.parse(legacy['package.json'] ?? '{}')
  assert.equal(legacyPkg.dsh.profile.patchReload, 'startup', 'legacy keeps patchReload startup')
  assert.ok(!(legacy['cordis.patch.yml'] ?? '').includes('session-log-deepseek'), 'legacy lines keep their verified opt-in default untouched')
})

test('0.2.0 corridor: writeGatewayKeyToPatch materializes the facade composition row -- idempotent, rotating, other rows preserved', () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-node-patch-'))
  try {
    const files = profileFiles({ name: 'worker', port: 3083 }, GATEWAY_REF_020, '0.2.0-rc.2')
    const patchPath = join(dir, 'cordis.patch.yml')
    writeFileSync(patchPath, files['cordis.patch.yml'] ?? '', 'utf8')
    writeGatewayKeyToPatch(dir, 'apigw-test-1')
    writeGatewayKeyToPatch(dir, 'apigw-test-1', {})
    let rows = readPatch(patchPath)
    assert.equal(rows.filter((r) => r.id === GATEWAY_PACKAGE).length, 1, 'repeated writes never duplicate the row')
    assert.deepEqual(facadeRow(rows)?.apiKeys, ['apigw-test-1'])
    assert.ok(rows.some((r) => r.id === 'webserver'), 'the webserver row survives')
    assert.ok(rows.some((r) => r.id === 'session-log-deepseek'), 'the privacy row survives')
    // A rotation replaces the key in place
    writeGatewayKeyToPatch(dir, 'apigw-test-2')
    rows = readPatch(patchPath)
    assert.deepEqual(facadeRow(rows)?.apiKeys, ['apigw-test-2'])
    assert.equal(rows.filter((r) => r.id === GATEWAY_PACKAGE).length, 1)
    // The ops-tier unlock flag rides along (Fleet M3 parity with the agent/container paths)
    writeGatewayKeyToPatch(dir, 'apigw-test-2', { allowFullAccess: true })
    rows = readPatch(patchPath)
    assert.equal(facadeRow(rows)?.allowFullAccess, true)
    writeGatewayKeyToPatch(dir, 'apigw-test-2')
    rows = readPatch(patchPath)
    assert.ok(facadeRow(rows)?.allowFullAccess === undefined, 'the flag is dropped again when not requested (env is the truth)')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0.2.0 corridor: resolveGatewayKey places the key by version -- patch row on 0.2.x, settings.yaml on legacy (J1-04/§18.5)', () => {
  const home = mkdtempSync(join(tmpdir(), 'host-node-key-'))
  try {
    // A fresh 0.2.x node: the key is minted into the PATCH (settings.yaml is a dead path -- one-shot import)
    const profileDir = join(home, 'profiles', 'worker')
    mkdirSync(profileDir, { recursive: true })
    const files = profileFiles({ name: 'worker', port: 3083 }, GATEWAY_REF_020, '0.2.0-rc.2')
    writeFileSync(join(profileDir, 'cordis.patch.yml'), files['cordis.patch.yml'] ?? '', 'utf8')
    const key = resolveGatewayKey(home, null, { dshVersion: '0.2.0-rc.2', profileName: 'worker' })
    assert.match(key, /^apigw-/, 'a fresh node mints a key')
    assert.ok(!existsSync(join(home, 'settings.yaml')), 'no dead settings.yaml is written on the new line')
    assert.deepEqual(facadeRow(readPatch(join(profileDir, 'cordis.patch.yml')))?.apiKeys, [key])
    // Idempotent: a second resolve reuses the patch row
    assert.equal(resolveGatewayKey(home, null, { dshVersion: '0.2.0-rc.2', profileName: 'worker' }), key)

    // The upgrade case: an existing settings.yaml key (from the legacy era) is REUSED, so the .env
    // GW_KEY_* / endpoint wiring stays valid across a version switch, and moved into the patch
    const legacyHome = mkdtempSync(join(tmpdir(), 'host-node-key-legacy-'))
    try {
      const legacyProfile = join(legacyHome, 'profiles', 'worker')
      mkdirSync(legacyProfile, { recursive: true })
      writeFileSync(join(legacyProfile, 'cordis.patch.yml'), files['cordis.patch.yml'] ?? '', 'utf8')
      writeFileSync(join(legacyHome, 'settings.yaml'), 'ohdsh-api-facade:\n  apiKeys: [apigw-old]\n', 'utf8')
      const reused = resolveGatewayKey(legacyHome, null, { dshVersion: '0.2.0-rc.2', profileName: 'worker' })
      assert.equal(reused, 'apigw-old', 'the legacy key survives the switch (the .env truth must not drift)')
      assert.deepEqual(facadeRow(readPatch(join(legacyProfile, 'cordis.patch.yml')))?.apiKeys, ['apigw-old'])
    } finally {
      rmSync(legacyHome, { recursive: true, force: true })
    }

    // The legacy default path is untouched: no opts = the settings.yaml namespace mechanism
    const legacyDefault = mkdtempSync(join(tmpdir(), 'host-node-key-default-'))
    try {
      const minted = resolveGatewayKey(legacyDefault, null)
      assert.match(minted, /^apigw-/)
      assert.ok(existsSync(join(legacyDefault, 'settings.yaml')), 'the legacy line keeps writing settings.yaml')
      assert.equal(resolveGatewayKey(legacyDefault, null), minted, 'reuse from settings.yaml still works')
    } finally {
      rmSync(legacyDefault, { recursive: true, force: true })
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
