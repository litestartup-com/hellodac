import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { GATEWAY_PACKAGE, SUPPORTED_DSH } from '../dsh-matrix.js'
import { LEGACY_PEER_PINS } from '../host-node/profile.js'

/**
 * The dependency locks of the container node image (fact card §14 "container leftovers").
 *
 * `images/node/gen-node-profile.mjs` resolves the dependency tree at build time; without a lock
 * file the same image tag installs a different tree as the registry drifts -- an incident can be
 * neither reproduced nor rolled back to "that one tree". These two locks come from that script's own
 * `--lock-only` mode (same logic as the package.json it writes at build time) and ship with the repo; this test blocks "the pin changed but the lock was not refreshed".
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const lockDir = join(root, 'images', 'node', 'profile-lock')

interface Lock {
  lockfileVersion: number
  packages: Record<string, { name?: string; dependencies?: Record<string, string> }>
}

const readLock = (version: string): Lock => {
  const file = join(lockDir, `${version}.package-lock.json`)
  assert.ok(existsSync(file), `missing lock file ${version}.package-lock.json (run npm run lock:profile to refresh)`)
  return JSON.parse(readFileSync(file, 'utf8')) as Lock
}

test('DAC v1.0.0: every supported DSH version has a container profile lock, and its root dependencies match the shared source of truth', () => {
  for (const pair of SUPPORTED_DSH) {
    const lock = readLock(pair.dsh)
    assert.ok(lock.lockfileVersion >= 3, `${pair.dsh} lockfile version too low`)
    const rootPkg = lock.packages['']
    assert.ok(rootPkg !== undefined, `${pair.dsh} lock has no root package`)
    assert.equal(rootPkg.name, 'dsh-profile-dac-node', 'the root package name must match what gen-node-profile writes')
    // Same source as profileDependencies in src/host-node/profile.ts (the container profile lacks one
    // bare @deepseek-ai/dsh direct dependency, the entry package of the bare-metal path).
    const expected: Record<string, string> = {
      '@deepseek-ai/dsh-base': pair.dsh,
      '@deepseek-ai/dsh-web-app': pair.dsh,
      [GATEWAY_PACKAGE]: pair.gateway,
      ...(LEGACY_PEER_PINS[pair.dsh] ?? {}),
    }
    assert.deepEqual(rootPkg.dependencies, expected, `${pair.dsh} lock disagrees with the matrix/pin -- refresh the lock before committing`)
  }
})

test('DAC v1.0.0: each lock holds a complete resolved tree (not an empty shell) with no file: local path dependency', () => {
  for (const pair of SUPPORTED_DSH) {
    const lock = readLock(pair.dsh)
    const entries = Object.keys(lock.packages).length
    assert.ok(entries > 100, `${pair.dsh} lock has only ${entries} entries, as if nothing was really resolved`)
    for (const [path, pkg] of Object.entries(lock.packages)) {
      for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
        assert.ok(!spec.startsWith('file:'), `${pair.dsh} lock contains the local path dependency ${name}=${spec} (which does not exist in the image)`)
      }
      assert.ok(!path.includes('..'), `${pair.dsh} lock contains an out-of-tree path ${path}`)
    }
  }
})
