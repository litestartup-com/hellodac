/**
 * Capability one (2026-09-20): the host node's profile generation / install / keys / dependency command --
 * a shared module pulled out of src/cli/setup.ts (used by both setup and provision; a move that changes no
 * behavior plus one capability change: the profile dependencies now include `@deepseek-ai/dsh` itself, so
 * after an isolated install spawn no longer depends on a global dsh).
 *
 * Layout: under `<nodesHome>/<name>/profiles/<name>/` sit package.json (bundles + gateway
 * + dsh itself, every one of them pinned) + cordis.patch.yml (webserver bound to loopback + the node port) +
 * pnpm-workspace.yaml (the build-script allowlist shim for npm installs).
 */
import { randomBytes } from 'node:crypto'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { COMPAT_DSH_VERSION, GATEWAY_PACKAGE, GATEWAY_REF, resolvePair } from '../dsh-version.js'
import { PROFILE_LOCKS } from './profile-locks.js'

export interface ProfileSpec {
  name: string
  port: number
}

// Hive plan 2 P1: the bundles are version-pinned (= COMPAT_DSH_VERSION), which kills bare-metal install drift;
// the gateway is both a bundle and a dependency, and its reference comes from gatewayDep (pinned to a commit by default).
export const PROFILE_BUNDLES: Record<string, string> = {
  '@deepseek-ai/dsh-base': COMPAT_DSH_VERSION,
  '@deepseek-ai/dsh-web-app': COMPAT_DSH_VERSION,
}

/** Capability one: the profile dependencies of an isolated install = dsh itself + bundles + gateway (all pinned).
 * Capability two correction (caught on 2026-09-22 by Fleet M1-6): the bundles must pin the **target**
 * dshVersion -- the old implementation expanded PROFILE_BUNDLES (always COMPAT_DSH_VERSION) and overrode
 * the version passed in, so a 0.1.5 node got 0.1.2 bundles (the twin form of the Windows crash, fact card §13). */
/**
 * Capability four (measured in the Fleet M1 pilot, 2026-09-23, fact card dsh-facts §14):
 * --legacy-peer-deps skips every peer, while the 0.1.5 family's dsh-app-boot statically imports
 * @deepseek-ai/cordis-plugin-group and 23 packages under old family names exist only in the peer range --
 * so they are added explicitly as direct dependencies (pinned to the measured version), or a freshly
 * installed node crashes on start. It pairs with the lock files (profile-locks.ts): the lock pins the whole
 * tree snapshot and this table adds the peers the lock is missing. Kept in sync with gen-node-profile.mjs's list (a standing check-docs.mjs assertion).
 */
export const LEGACY_PEER_PINS: Record<string, Record<string, string>> = {
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

export const profileDependencies = (
  dshVersion: string = COMPAT_DSH_VERSION,
  gatewayDep: string = GATEWAY_REF,
): Record<string, string> => ({
  '@deepseek-ai/dsh': dshVersion,
  '@deepseek-ai/dsh-base': dshVersion,
  '@deepseek-ai/dsh-web-app': dshVersion,
  [GATEWAY_PACKAGE]: gatewayDep,
  ...(LEGACY_PEER_PINS[dshVersion] ?? {}),
})

export const profileFiles = (
  spec: ProfileSpec,
  gatewayDep: string,
  dshVersion: string = COMPAT_DSH_VERSION,
  /** The webserver bind address: 127.0.0.1 by default on bare metal (a GUI red line); a remote agent
   * node uses 0.0.0.0 (the manager probes it remotely; safety comes from the Q5 firewall allowlist + the 0.1.5 token). */
  bindHost: string = '127.0.0.1',
): Record<string, string> => {
  const pkg = {
    name: `dsh-profile-${spec.name}`,
    private: true,
    dsh: {
      profile: {
        bundles: [...Object.keys(PROFILE_BUNDLES), GATEWAY_PACKAGE],
        // Measured in the M1 pilot: the default live patch watcher hard-depends on the HMR service (under the
        // legacy install cordis-plugin-hmr is a peer, and without adding it explicitly the node crashes) -- a
        // manager-managed node has no need for hot watching, so pin startup (applying the patch at boot is enough).
        patchReload: 'startup',
      },
    },
    dependencies: profileDependencies(dshVersion, gatewayDep),
  }
  const patch = [
    {
      id: 'webserver',
      config: {
        // A whole-line config replacement (no deep merge, in the README's own words): a node only ever binds loopback.
        host: bindHost,
        port: spec.port,
      },
    },
  ]
  return {
    'package.json': JSON.stringify(pkg, null, 2) + '\n',
    // Measured in the M1 pilot: ship the lock file to pin the whole tree snapshot (a ^ range drifts to rc.3, which is already published on registry next)
    ...(PROFILE_LOCKS[dshVersion] === undefined ? {} : { 'package-lock.json': PROFILE_LOCKS[dshVersion] }),
    // pnpm >=10 refuses to run dependency build scripts by default (ERR_PNPM_IGNORED_BUILDS, hit during a real
    // container build) -- so explicitly approve the native/postinstall packages the DSH dependency chain must
    // build. 10 reads the top-level key, 11 reads the nested pnpm key, so both forms are given (9 and below ignore them and run as before).
    'pnpm-workspace.yaml': [
      'packages:',
      '  - .',
      '',
      'nodeLinker: hoisted',
      'autoInstallPeers: false',
      'onlyBuiltDependencies:',
      "  - '@deepseek-ai/dsh-subprocess-local'",
      "  - '@google/genai'",
      '  - koffi',
      '  - node-pty',
      '  - protobufjs',
      'pnpm:',
      '  onlyBuiltDependencies:',
      "    - '@deepseek-ai/dsh-subprocess-local'",
      "    - '@google/genai'",
      '    - koffi',
      '    - node-pty',
      '    - protobufjs',
      '',
    ].join('\n'),
    'cordis.yml': '# dsh profile root — empty entry list; edit cordis.patch.yml\n[]\n',
    'cordis.patch.yml': stringifyYaml(patch),
  }
}

/**
 * Creates an independent DSH_HOME under nodesHome for every node (<nodesHome>/<name>/profiles/<name>).
 * An existing node directory is left untouched.
 */
export const ensureNodeProfiles = (nodesHome: string, specs: ProfileSpec[], gatewayDep: string, dshVersion: string = COMPAT_DSH_VERSION): string[] => {
  mkdirSync(nodesHome, { recursive: true })
  const created: string[] = []
  for (const spec of specs) {
    const nodeHome = join(nodesHome, spec.name)
    const dir = join(nodeHome, 'profiles', spec.name)
    if (existsSync(dir)) continue
    mkdirSync(dir, { recursive: true })
    for (const [name, content] of Object.entries(profileFiles(spec, gatewayDep, dshVersion))) {
      writeFileSync(join(dir, name), content, 'utf8')
    }
    // Capability two: seed the version marker (the same as the container entrypoint) -- boot reconciliation and
    // align read it to decide version/ref drift; an older profile with no marker counts as drifted, and the one-click align entry catches it.
    writeFileSync(join(dir, '.seed-version'), profileSeed(dshVersion, gatewayDep) + '\n', 'utf8')
    created.push(nodeHome)
  }
  return created
}

/** Capability two: the profile's version seed = sha1(dshVersion|gatewayRef), the same as the container entrypoint. */
export const profileSeed = (dshVersion: string, gatewayRef: string): string =>
  createHash('sha1').update(`${dshVersion}|${gatewayRef}`).digest('hex')

/** Reads the .seed-version marker in a profile directory; absent = null (an older profile). */
export const currentProfileSeed = (profileDir: string): string | null => {
  try {
    return readFileSync(join(profileDir, '.seed-version'), 'utf8').trim()
  } catch {
    return null
  }
}

/** Drift decision: a missing marker or one that disagrees with the expected seed = reseed to align. */
export const profileDrift = (profileDir: string, dshVersion: string, gatewayRef: string): boolean =>
  currentProfileSeed(profileDir) !== profileSeed(dshVersion, gatewayRef)

/** Capability two: reseed the profile unconditionally (for the align route -- version switches and drift converge, idempotent). */
export const reseedProfile = (profileDir: string, spec: ProfileSpec, gatewayDep: string, dshVersion: string = COMPAT_DSH_VERSION): void => {
  mkdirSync(profileDir, { recursive: true })
  for (const [name, content] of Object.entries(profileFiles(spec, gatewayDep, dshVersion))) {
    writeFileSync(join(profileDir, name), content, 'utf8')
  }
  writeFileSync(join(profileDir, '.seed-version'), profileSeed(dshVersion, gatewayDep) + '\n', 'utf8')
}

/** Copies the model credentials from the main DSH_HOME into the node directory (one user, one key; never overwrites by default). */
export const ensureNodeCredentials = (mainDshHome: string, nodeHome: string): boolean => {
  const source = join(mainDshHome, '.credentials.yaml')
  const target = join(nodeHome, '.credentials.yaml')
  if (!existsSync(source) || existsSync(target)) return false
  mkdirSync(nodeHome, { recursive: true })
  writeFileSync(target, readFileSync(source, 'utf8'), 'utf8')
  return true
}

/**
 * The node profile dependency install command. Measured when 0.1.2 became the main path (the container path
 * reached the same conclusion): pnpm@9 fails to resolve the nested prerelease range of harness 0.1.2-rc.1, and
 * pnpm@11's onlyBuiltDependencies allowlist does not take effect -- so npm it is (measured to resolve the same
 * version set, and it runs native build scripts the old way). Windows: npm is a .cmd shim, so callers must use shell: true.
 *
 * Capability two: a pair whose target version is marked needsLegacyPeerDeps in the matrix gets
 * `--legacy-peer-deps` appended (0.1.5 measured ERESOLVE -- the facade peer range ^0.1.2-rc.1 does
 * not cover the 0.1.5 host tree, fact card dsh-facts §12).
 */
export const profileInstallCommand = (_platform: NodeJS.Platform, dshVersion: string = COMPAT_DSH_VERSION): { cmd: string; args: string[] } => {
  const args = ['install', '--no-audit', '--no-fund']
  if (resolvePair(dshVersion)?.needsLegacyPeerDeps === true) args.push('--legacy-peer-deps')
  return { cmd: 'npm', args }
}

/**
 * Capability one: the dsh bin of the isolated install inside a node profile (the bin entry of
 * @deepseek-ai/dsh = lib/bin.js, measured in the 0.1.2 package). Returns null when not installed -- the
 * caller falls back to a global dsh (the compatibility path for existing nodes).
 */
export const dshBinInProfile = (profileDir: string): string | null => {
  const candidate = join(profileDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  return existsSync(candidate) ? candidate : null
}

/**
 * Resolves the gateway key: the facade namespace's provisionedKey in settings.yaml comes first; when it
 * is absent we generate one and append it to apiKeys (the gateway's static key array, live through settings).
 * The namespace = GATEWAY_PACKAGE (ohdsh-api-facade since 0.1.2 became the main path; a key under the old
 * dsh-api-gw section is not read by the new facade -- the same trap as the container path, do not step in it again).
 */
export const resolveGatewayKey = (dshHome: string, settingsPath: string | null): string => {
  const ns = GATEWAY_PACKAGE
  const path = settingsPath ?? join(dshHome, 'settings.yaml')
  if (existsSync(path)) {
    const parsed = parseYaml(readFileSync(path, 'utf8')) as Record<string, { provisionedKey?: string; apiKeys?: string[] } | undefined>
    const section = parsed[ns]
    if (typeof section?.provisionedKey === 'string' && section.provisionedKey !== '') return section.provisionedKey
    const keys = Array.isArray(section?.apiKeys) ? section.apiKeys.filter((k) => k !== '') : []
    const first = keys[0]
    if (first !== undefined) return first
  }
  const minted = 'apigw-' + randomBytes(24).toString('hex')
  const parsed = existsSync(path) ? (parseYaml(readFileSync(path, 'utf8')) as Record<string, unknown>) : {}
  const section = (parsed[ns] ?? {}) as Record<string, unknown>
  const apiKeys = Array.isArray(section.apiKeys) ? [...section.apiKeys, minted] : [minted]
  parsed[ns] = { ...section, apiKeys }
  writeFileSync(path, stringifyYaml(parsed), 'utf8')
  return minted
}
