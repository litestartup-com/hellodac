// Hive plan 2 P2: generate the in-container node profile at build time (isomorphic to profileFiles in
// src/cli/setup.ts, except webserver binds 0.0.0.0 -- under container network isolation the port is not published,
// and the manager reaches it over the hive network).
// The pinned version comes in through the Dockerfile's ARG; the default matches the first line of SUPPORTED_DSH in src/dsh-matrix.ts.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DSH_VERSION = process.env.DSH_VERSION ?? '0.1.2-rc.1'
const GATEWAY_REF = process.env.GATEWAY_REF ?? 'github:litestartup-com/dsh-api-gateway#b592b4f'
const NPM_REGISTRY = process.env.NPM_REGISTRY ?? 'https://registry.npmjs.org'
const out = process.env.PROFILE_DIR ?? '/opt/dac-profile'
/** Lock directory: copied into the build context by the Dockerfile (LOCK_DIR); a repo-side refresh points it at profile-lock/. */
const LOCK_DIR = process.env.LOCK_DIR ?? join(import.meta.dirname, 'profile-lock')
// Kept in sync with needsLegacyPeerDeps in src/dsh-matrix.ts (a standing check-docs.mjs assertion):
// the facade peer range ^0.1.2-rc.1 does not reach the 0.1.5 line -> without --legacy-peer-deps it is a guaranteed ERESOLVE
// (measured on server smoke15, fact card dsh-facts §12; the bare-metal path profileInstallCommand carries the same fix).
const LEGACY_PEER_DEPS_VERSIONS = ['0.1.5-rc.2']
// M1 pilot evidence (fact card dsh-facts §14): legacy skips every peer, and in the 0.1.5 family
// dsh-app-boot statically imports cordis-plugin-group, while 23 old-family-name packages exist only in the peer
// range -- pin them explicitly as direct dependencies, otherwise a freshly installed node crashes on startup.
// Kept in sync with LEGACY_PEER_PINS in src/host-node/profile.ts (a standing check-docs.mjs assertion).
const LEGACY_PEER_PINS = {
  '0.1.5-rc.2': {
    '@deepseek-ai/cordis-plugin-group': '1.0.2',
    '@deepseek-ai/cordis-plugin-hmr': '1.0.17',
    '@deepseek-ai/cordis-plugin-include': '1.0.7',
    '@deepseek-ai/dsh-anonymous-user-id': '0.1.5-rc.3',
    '@deepseek-ai/dsh-attachment': '0.1.5-rc.3',
    '@deepseek-ai/dsh-authorization': '0.1.5-rc.3',
    '@deepseek-ai/dsh-bash-local': '0.1.5-rc.3',
    '@deepseek-ai/dsh-code-runtime': '0.1.5-rc.3',
    '@deepseek-ai/dsh-compaction': '0.1.5-rc.3',
    '@deepseek-ai/dsh-fs': '0.1.5-rc.3',
    '@deepseek-ai/dsh-hook-protocol': '0.1.5-rc.3',
    '@deepseek-ai/dsh-jobs': '0.1.5-rc.3',
    '@deepseek-ai/dsh-output-retention': '0.1.5-rc.3',
    '@deepseek-ai/dsh-sandbox': '0.1.5-rc.3',
    '@deepseek-ai/dsh-sdk-protocol': '0.1.5-rc.3',
    '@deepseek-ai/dsh-session-persistence': '0.1.5-rc.3',
    '@deepseek-ai/dsh-session-query': '0.1.5-rc.3',
    '@deepseek-ai/dsh-session-telemetry': '0.1.5-rc.3',
    '@deepseek-ai/dsh-session-title-llm': '0.1.5-rc.3',
    '@deepseek-ai/dsh-settings': '0.1.5-rc.3',
    '@deepseek-ai/dsh-shell': '0.1.5-rc.3',
    '@deepseek-ai/dsh-spill': '0.1.5-rc.3',
    '@deepseek-ai/dsh-subagent-in-process-driver': '0.1.5-rc.3',
    '@deepseek-ai/dsh-util-time': '0.1.5-rc.3',
    '@deepseek-ai/dsh-util-workspace-path': '0.1.5-rc.3',
    '@deepseek-ai/dsh-workflow': '0.1.5-rc.3',
  },
}

mkdirSync(out, { recursive: true })

writeFileSync(`${out}/package.json`, JSON.stringify(
  {
    name: 'dsh-profile-dac-node',
    private: true,
    dsh: {
      profile: {
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'ohdsh-api-facade'],
        // M1 pilot evidence: a node profile does not enable the live patch watcher (avoids a hard HMR dependency)
        patchReload: 'startup',
      },
    },
    dependencies: {
      '@deepseek-ai/dsh-base': DSH_VERSION,
      '@deepseek-ai/dsh-web-app': DSH_VERSION,
      'ohdsh-api-facade': GATEWAY_REF,
      ...(LEGACY_PEER_PINS[DSH_VERSION] ?? {}),
    },
  },
  null,
  2,
) + '\n', 'utf8')
// Profile dependency installation moved to npm (see execFileSync below): pnpm@9 fails to resolve the inner
// prerelease range of 0.1.2-rc.1, and pnpm@11's onlyBuiltDependencies allowlist stops working -- both nailed down by
// two server builds; the same version set under npm demonstrably resolves and runs native build scripts with the old semantics.
// The port passes CLI --port through as a dynamic expression (a hard-coded 3080 would override --port, every node would
// listen on 3080 and the manager's probes of 3081/3082 would all fetch-fail -- a pit hit in the container).
const patchYaml = "- id: webserver\n  config:\n    host: '0.0.0.0'\n    port: !!js ctx.webStartup.port ?? 3080\n"
writeFileSync(`${out}/cordis.patch.yml`, patchYaml, 'utf8')
// Seed version marker: the entrypoint uses it to decide whether an old profile in the volume needs re-seeding (image upgrade self-heal)
writeFileSync(
  `${out}/.seed-version`,
  createHash('sha1').update(`${DSH_VERSION}|${GATEWAY_REF}|${patchYaml}`).digest('hex') + '\n',
  'utf8',
)

// Dependency installation: with a lock use `npm ci` (reproducible), without one fall back to `npm install` and warn loudly.
//
// Why a lock is needed (fact card §14 "container leftovers"): with a plain `npm install` the **transitive dependencies**
// of DSH and the gateway are resolved on the day of the build, so a registry change changes the image content -- the same
// tag installs a different tree, and a failure cannot be reproduced. The lock file is generated by this script's
// --lock-only mode (the same logic as the package.json written at build time, so there is no "lock and manifest drifting
// apart"), is committed with the repo, and is guarded by tests.
const lockFile = join(LOCK_DIR, `${DSH_VERSION}.package-lock.json`)
const hasLock = existsSync(lockFile)
if (hasLock) copyFileSync(lockFile, `${out}/package-lock.json`)

const npmArgs = hasLock ? ['ci'] : ['install']
const installArgs = [...npmArgs, '--no-audit', '--no-fund', `--registry=${NPM_REGISTRY}`]
if (LEGACY_PEER_DEPS_VERSIONS.includes(DSH_VERSION)) installArgs.push('--legacy-peer-deps')

if (process.argv.includes('--lock-only')) {
  // Generate only the lock (without downloading tarballs): used for refreshing the lock file repo-side (`npm run lock:profile`).
  // Without an explicit PROFILE_DIR it generates in a temp dir under profile-lock/, then files it under <DSH_VERSION>.
  const tmp = process.env.PROFILE_DIR === undefined
  const workDir = tmp ? join(LOCK_DIR, `.tmp-${DSH_VERSION}`) : out
  mkdirSync(workDir, { recursive: true })
  writeFileSync(join(workDir, 'package.json'), readFileSync(join(out, 'package.json')))
  execFileSync('npm', ['install', '--package-lock-only', '--no-audit', '--no-fund', `--registry=${NPM_REGISTRY}`, ...(LEGACY_PEER_DEPS_VERSIONS.includes(DSH_VERSION) ? ['--legacy-peer-deps'] : [])], { cwd: workDir, stdio: 'inherit', shell: process.platform === 'win32' })
  if (tmp) {
    mkdirSync(LOCK_DIR, { recursive: true })
    copyFileSync(join(workDir, 'package-lock.json'), join(LOCK_DIR, `${DSH_VERSION}.package-lock.json`))
    rmSync(workDir, { recursive: true, force: true })
    console.log(`[gen-node-profile] lock refreshed: ${join(LOCK_DIR, `${DSH_VERSION}.package-lock.json`)}`)
    console.log('[gen-node-profile] commit it and run npm test (profile-lock.test.ts checks the lock against the matrix)')
  } else {
    console.log(`[gen-node-profile] lock written to ${workDir}/package-lock.json (DSH ${DSH_VERSION})`)
  }
} else {
  if (!hasLock) {
    console.warn(`[gen-node-profile] WARNING: no lock at ${lockFile} — falling back to npm install; the dependency tree is NOT reproducible`)
  }
  execFileSync('npm', installArgs, { cwd: out, stdio: 'inherit', shell: process.platform === 'win32' })
  console.log(`[gen-node-profile] ${out} ready (DSH ${DSH_VERSION}, gateway ${GATEWAY_REF}, ${hasLock ? 'npm ci' : 'npm install'})`)
}
