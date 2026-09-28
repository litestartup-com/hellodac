import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { profileFiles, profileDependencies, dshBinInProfile, ensureNodeProfiles, profileSeed, currentProfileSeed, profileDrift, profileInstallCommand } from './profile.js'
import { COMPAT_DSH_VERSION, GATEWAY_PACKAGE, GATEWAY_REF } from '../dsh-version.js'

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
