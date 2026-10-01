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
import { COMPAT_DSH_VERSION, GATEWAY_PACKAGE, GATEWAY_REF, isLegacyDshLine, resolvePair } from '../dsh-version.js'
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
  // 0.2.0 corridor (dsh-facts §18.9 + bare-metal boot probe 2026-10-01): two derivation sources --
  // (1) the gateway's 7-package app-boot seed table (dsh-app-boot@0.2.0-rc.2 peerDependencies,
  // boot-proven on the standalone stack), plus (2) the FULL peer closure of the profile tree under
  // --legacy-peer-deps, derived iteratively from the lock metadata until zero missing peers: 29
  // family packages that exist only as peers of dsh-base's plugin deps
  // (dsh-jobs-local -> dsh-jobs and friends) -- a bare-metal node boots from its PROFILE-LOCAL bin
  // (M1-6: the profile tree must be self-contained), and without these the host dies with 33
  // "failed to import" plugins (measured: ERR_MODULE_NOT_FOUND @deepseek-ai/dsh-jobs etc.). The
  // container image shares the table (its runtime host is the complete global tree, but one table
  // keeps the check-docs verbatim guard and both trees self-contained). All family pins are the
  // exact registry versions the peer ranges demand. Kept word-for-word in sync with
  // gen-node-profile.mjs and with the gateway's docker/gen-profile.mjs seed table (subset).
  '0.2.0-rc.2': {
    '@deepseek-ai/cordis': '4.0.4',
    '@deepseek-ai/cordis-plugin-group': '1.0.4',
    '@deepseek-ai/cordis-plugin-loader': '1.0.5',
    '@deepseek-ai/cordis-plugin-include': '1.0.9',
    '@deepseek-ai/dsh-home-paths': '0.2.0-rc.2',
    '@deepseek-ai/dsh-system-prompt': '0.2.0-rc.2',
    '@deepseek-ai/dsh-launch-environment': '0.2.0-rc.2',
    '@deepseek-ai/dsh-anonymous-user-id': '0.2.0-rc.2',
    '@deepseek-ai/dsh-attachment': '0.2.0-rc.2',
    '@deepseek-ai/dsh-bash-local': '0.2.0-rc.2',
    '@deepseek-ai/dsh-client-store': '0.2.0-rc.2',
    '@deepseek-ai/dsh-client-ui-primitives': '0.2.0-rc.2',
    '@deepseek-ai/dsh-client-ui-slots': '0.2.0-rc.2',
    '@deepseek-ai/dsh-compaction': '0.2.0-rc.2',
    '@deepseek-ai/dsh-deepseek-account': '0.2.0-rc.2',
    '@deepseek-ai/dsh-fs': '0.2.0-rc.2',
    '@deepseek-ai/dsh-hook-protocol': '0.2.0-rc.2',
    '@deepseek-ai/dsh-http-proxy': '0.2.0-rc.2',
    '@deepseek-ai/dsh-invariants': '0.2.0-rc.2',
    '@deepseek-ai/dsh-jobs': '0.2.0-rc.2',
    '@deepseek-ai/dsh-llm-deepseek': '0.2.0-rc.2',
    '@deepseek-ai/dsh-output-retention': '0.2.0-rc.2',
    '@deepseek-ai/dsh-ptc-runtime': '0.2.0-rc.2',
    '@deepseek-ai/dsh-sandbox': '0.2.0-rc.2',
    '@deepseek-ai/dsh-scope': '0.2.0-rc.2',
    '@deepseek-ai/dsh-sdk-protocol': '0.2.0-rc.2',
    '@deepseek-ai/dsh-session-persistence': '0.2.0-rc.2',
    '@deepseek-ai/dsh-session-query': '0.2.0-rc.2',
    '@deepseek-ai/dsh-session-telemetry': '0.2.0-rc.2',
    '@deepseek-ai/dsh-session-title-llm': '0.2.0-rc.2',
    '@deepseek-ai/dsh-shell': '0.2.0-rc.2',
    '@deepseek-ai/dsh-spill': '0.2.0-rc.2',
    '@deepseek-ai/dsh-subagent-in-process-driver': '0.2.0-rc.2',
    '@deepseek-ai/dsh-util-time': '0.2.0-rc.2',
    '@deepseek-ai/dsh-util-workspace-path': '0.2.0-rc.2',
    '@deepseek-ai/dsh-workflow': '0.2.0-rc.2',
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
  // 0.2.0 corridor (upgrade cards J1-15/J1-22, dsh-facts §18.6/§18.10): the manifest/patch shape is
  // version-gated. patchReload was dropped from the manifest contract in the 0.1.7 corridor -- only the
  // legacy 0.1.2/0.1.5 lines keep it (there it avoids a hard HMR dependency, M1-measured); and the
  // DeepSeek session-log upload defaults ON from the same corridor, so a managed node on the new lines
  // opts out explicitly through the composition patch (the row id matches the base bundle's row).
  const legacy = isLegacyDshLine(dshVersion)
  const pkg = {
    name: `dsh-profile-${spec.name}`,
    private: true,
    dsh: {
      profile: {
        bundles: [...Object.keys(PROFILE_BUNDLES), GATEWAY_PACKAGE],
        ...(legacy ? { patchReload: 'startup' } : {}),
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
    ...(legacy ? [] : [{ id: 'session-log-deepseek', config: { enabled: false } }]),
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
 * Reads the facade key back from a profile's cordis.patch.yml composition row (the durable key path
 * on the 0.1.7+/0.2.x lines). Null when the patch or the row is absent.
 */
const readGatewayKeyFromPatch = (profileDir: string): string | null => {
  try {
    const parsed = parseYaml(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')) as
      | Array<{ id?: string; config?: { apiKeys?: unknown } } | undefined> | null
    const row = (parsed ?? []).find((r) => r?.id === GATEWAY_PACKAGE)
    const keys = row?.config?.apiKeys
    if (!Array.isArray(keys)) return null
    const first = keys.find((k): k is string => typeof k === 'string' && k !== '')
    return first ?? null
  } catch {
    return null
  }
}

export interface GatewayKeyPatchOptions {
  /** Fleet M3 parity: the ops tier unlock (dangerous ops still card-gated; the facade logs a risk warning). */
  allowFullAccess?: boolean
}

/**
 * 0.2.0 corridor (dsh-facts §18.5, upgrade card J1-04): materializes the facade key as the profile's
 * cordis.patch.yml composition row -- the durable key path on the new lines, where $DSH_HOME/settings.yaml
 * is a one-shot import and ctx.settings.register is gone host-side. Idempotent: an existing facade row is
 * replaced, never duplicated; every other row (webserver, privacy) is preserved. The same shape the
 * container entrypoint and the node agent write (one derived delivery, three landing ends).
 */
export const writeGatewayKeyToPatch = (profileDir: string, key: string, opts: GatewayKeyPatchOptions = {}): void => {
  const path = join(profileDir, 'cordis.patch.yml')
  let rows: unknown[] = []
  if (existsSync(path)) {
    const parsed = parseYaml(readFileSync(path, 'utf8')) as unknown[] | null
    if (Array.isArray(parsed)) rows = parsed
  }
  const kept = rows.filter((r) => (r as { id?: unknown } | null)?.id !== GATEWAY_PACKAGE)
  kept.push({
    id: GATEWAY_PACKAGE,
    config: { apiKeys: [key], ...(opts.allowFullAccess === true ? { allowFullAccess: true } : {}) },
  })
  writeFileSync(path, stringifyYaml(kept), 'utf8')
}

/** Where a resolveGatewayKey call should materialize the key on the new (non-legacy) lines. */
export interface GatewayKeyPlacement {
  dshVersion: string
  profileName: string
}

/** Discovery of an already-provisioned key in the settings namespace: provisionedKey first, else apiKeys. */
const readKeyFromSettings = (path: string): string | undefined => {
  if (!existsSync(path)) return undefined
  const parsed = parseYaml(readFileSync(path, 'utf8')) as Record<string, { provisionedKey?: string; apiKeys?: string[] } | undefined> | null
  const section = parsed?.[GATEWAY_PACKAGE]
  if (typeof section?.provisionedKey === 'string' && section.provisionedKey !== '') return section.provisionedKey
  const keys = Array.isArray(section?.apiKeys) ? section.apiKeys.filter((k) => k !== '') : []
  return keys[0]
}

/**
 * Resolves the gateway key: reuse what is already provisioned, else mint one.
 *
 * The PLACEMENT is version-gated (0.2.0 corridor, dsh-facts §18.5 / upgrade card J1-04):
 * - legacy lines (0.1.2/0.1.5, or no placement given): the facade namespace in $DSH_HOME/settings.yaml
 *   (provisionedKey first, then the apiKeys array; the old dsh-api-gw section is NOT read -- the same
 *   trap as the container path, do not step in it again);
 * - new lines (0.1.7+/0.2.x, placement given): the profile's cordis.patch.yml composition row. The
 *   discovery order is patch row -> settings.yaml -> mint: an UPGRADED node keeps its settings-era key
 *   (so the .env GW_KEY_* truth and the endpoint wiring never drift) and gets it moved into the patch;
 *   settings.yaml itself is a dead path there (one-shot import at first boot), so nothing is written to it.
 */
export const resolveGatewayKey = (dshHome: string, settingsPath: string | null, placement?: GatewayKeyPlacement): string => {
  const path = settingsPath ?? join(dshHome, 'settings.yaml')
  const patchPlacement = placement !== undefined && !isLegacyDshLine(placement.dshVersion)
    ? { profileDir: join(dshHome, 'profiles', placement.profileName) }
    : null

  if (patchPlacement !== null) {
    const fromPatch = readGatewayKeyFromPatch(patchPlacement.profileDir)
    if (fromPatch !== null) return fromPatch
  }
  const fromSettings = readKeyFromSettings(path)
  if (fromSettings !== undefined) {
    // The upgrade case: carry the legacy-era key over into the patch (idempotent rewrite).
    if (patchPlacement !== null) writeGatewayKeyToPatch(patchPlacement.profileDir, fromSettings)
    return fromSettings
  }

  const minted = 'apigw-' + randomBytes(24).toString('hex')
  if (patchPlacement !== null) {
    writeGatewayKeyToPatch(patchPlacement.profileDir, minted)
    return minted
  }
  const parsed = existsSync(path) ? (parseYaml(readFileSync(path, 'utf8')) as Record<string, unknown>) : {}
  const section = (parsed?.[GATEWAY_PACKAGE] ?? {}) as Record<string, unknown>
  const apiKeys = Array.isArray(section.apiKeys) ? [...section.apiKeys, minted] : [minted]
  writeFileSync(path, stringifyYaml({ ...parsed, [GATEWAY_PACKAGE]: { ...section, apiKeys } }), 'utf8')
  return minted
}
