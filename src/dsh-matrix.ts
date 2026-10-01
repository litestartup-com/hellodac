/**
 * Capability two (2026-09-20): the DSH version matrix -- a (dsh version <-> facade ref) pair table and the
 * single source of truth for manager version governance (the old dsh-version.ts constants moved here, and that
 * file became a re-export shim to keep the import surface).
 *
 * The key insight (design doc §2.1): the manager's upstream wire is a contract frozen by the facade, so the
 * coupling of "multiple DSH versions" = a (dsh, facade) pair; every row must pass the full-chain smoke on its
 * own (the same one as scripts/smoke-proxy-b.ts, plus question/approval cards, the version warning and the GUI
 * token), and only then does its status go up to verified. An unverified pair may still be installed but must
 * carry a yellow-text warning (the same at-your-own-risk wording as setup --skip-version-check).
 */
export const COMPAT_DSH_PACKAGE = '@deepseek-ai/dsh'

export interface DshPair {
  dsh: string
  /** The facade commit pinned for this DSH version pair (github:<repo>#<sha>). */
  gateway: string
  /** verified = the full-chain smoke passed; pending = unverified (a yellow-text warning at install). */
  status: 'verified' | 'pending'
  /**
   * The profile npm install for this pair must carry --legacy-peer-deps (the facade peer range
   * `^0.1.2-rc.1` does not cover this DSH line -> ERESOLVE). Fact: dsh-facts §12
   * (measured on a 0.1.5 server); the 0.1.2 line does not need it.
   */
  needsLegacyPeerDeps?: boolean
}

/**
 * The facade plugin's package name = ohdsh-api-facade (the dac- prefix convention). The repository
 * URL is still litestartup-com/dsh-api-gateway (the pinning chain stays put for now).
 */
export const GATEWAY_PACKAGE = 'ohdsh-api-facade'
/**
 * The facade ref paired with the DEFAULT matrix row (= tag v0.2.5, the 0.2.0 corridor release:
 * dual-range peers, the wireStream arity adaptation and the assistant/chunk typewriter restoration
 * for frozen-wire clients -- dsh-facts §18.13). Every code path that combines the default version
 * with a ref uses this constant, so the default pair can never drift apart.
 */
export const GATEWAY_REF = 'github:litestartup-com/dsh-api-gateway#398ea94'
/**
 * The facade pin of the two verified LEGACY rows. A verified row is never re-pinned without a
 * re-smoke, so they stay on the pre-corridor commit. WARNING: this facade dies SILENTLY on a 0.2.0
 * host (the 3-arg wireStream.open kills the answerer pump on first iteration, so question/approval
 * cards hang forever -- dsh-facts §18.2); it must never be paired with a new-line version.
 */
export const GATEWAY_REF_LEGACY = 'github:litestartup-com/dsh-api-gateway#b592b4f'

export const SUPPORTED_DSH: DshPair[] = [
  // 0.2.0 corridor (2026-09-30/10-01, fact card dsh-facts §18): the default line (npm latest).
  // Manager-side promotion evidence (2026-10-01, Windows bare-metal + GitHub CI):
  // - full-chain smoke on a real 0.2.0-rc.2 node: gateway smoke --model 7/7 (real turn),
  //   smoke-proxy-b all steps (manager client, chunk frames through the mux), question +
  //   approval card chains end to end (probe-cards, file landed on disk), GUI token line
  //   byte-identical, manager E2E (smoke.mjs: relay turn_done + usage ledger + git audit);
  // - container path: CI compose-e2e green on the 0.2.0 image (build + boot + claim +
  //   dynamic provisioning + backup/restore protection), run #78.
  // Install needs --legacy-peer-deps plus the full peer-closure pin table (profile.ts
  // LEGACY_PEER_PINS); running needs node ≥22.19 (registry engines); the session log migrates
  // V3→V4 ONE-WAY (§18.7 -- back the volume up before switching an existing node).
  { dsh: '0.2.0-rc.2', gateway: GATEWAY_REF, status: 'verified', needsLegacyPeerDeps: true },
  // P3 smoke (2026-09-20, the smoke15 node on the intranet pilot server): a 0.1.5-rc.2 host plus
  // facade b592b4f passed the full chain -- host.describe synthesised version / session.create /
  // a real session.prompt turn / the mux frame stream (user -> assistant -> turn/end). Fact card
  // dsh-facts.md §9/§10: installing needs --legacy-peer-deps (the facade peer range does not cover the
  // 0.1.5 line) and running needs node ≥22.19 (node 24 was used).
  { dsh: '0.1.5-rc.2', gateway: GATEWAY_REF_LEGACY, status: 'verified', needsLegacyPeerDeps: true },
  { dsh: '0.1.2-rc.1', gateway: GATEWAY_REF_LEGACY, status: 'verified' },
]

/** The default version = the first row of the matrix (the default for a new node). */
export const COMPAT_DSH_VERSION = SUPPORTED_DSH[0]?.dsh ?? '0.1.2-rc.1'

/** The install command: the version is pinned, not chasing the latest. */
export const DSH_INSTALL_COMMAND = `npm install -g ${COMPAT_DSH_PACKAGE}@${COMPAT_DSH_VERSION}`

/**
 * A test injection seam (the same _setSocketFactory pattern as mux.ts): replacing the pair table takes effect
 * in the resolvePair family at once -- provision's "pending yellow text" path depends on a pending row being in
 * the matrix, and once the real matrix is all verified a test injects one pending row to cover it.
 */
let matrixOverride: DshPair[] | null = null
export const _setMatrixForTest = (pairs: DshPair[]): void => {
  matrixOverride = pairs
}
export const _resetMatrixForTest = (): void => {
  matrixOverride = null
}
const activeMatrix = (): DshPair[] => matrixOverride ?? SUPPORTED_DSH

export const defaultDshVersion = (): string => COMPAT_DSH_VERSION

/**
 * The 0.2.0 corridor gate (dsh-facts §18.5/§18.10, upgrade card J1-04/J1-15): the legacy 0.1.2/0.1.5
 * lines configure the facade through $DSH_HOME/settings.yaml and carry patchReload in the profile
 * manifest; from the 0.1.7 corridor on, settings.yaml is a ONE-SHOT import (renamed to
 * settings.yaml.imported at first boot), ctx.settings.register is gone host-side, and patchReload was
 * dropped from the manifest contract -- the durable facade config path is the profile's
 * cordis.patch.yml composition row.
 *
 * NOTE the prerelease spelling: "0.1.5-rc.2" carries a DASH after the patch number, so a `0.1.5.*`
 * style pattern silently misses it (§18.10 crash-loop: the miss dropped patchReload and the legacy
 * node boot-crashed). The gate accepts the dash, the dot AND the end-of-string form (a bare "0.1.5"
 * final release is still the legacy line -- one notch stricter than the gateway's entrypoint case).
 * Kept in sync with the case patterns in images/node/entrypoint.sh and the regex in
 * images/node/gen-node-profile.mjs (a standing check-docs.mjs assertion).
 */
export const isLegacyDshLine = (version: string): boolean => /^0\.1\.(2|5)($|-|\.)/.test(version.replace(/^v/, ''))

/** A known pair returns its matrix row; an unknown version returns null (the caller treats it as "not in the matrix"). */
export const resolvePair = (version: string): DshPair | null =>
  activeMatrix().find((p) => p.dsh === version.replace(/^v/, '')) ?? null

/** verified | pending | null (not in the matrix). */
export const pairStatus = (version: string): 'verified' | 'pending' | null => {
  const pair = resolvePair(version)
  return pair === null ? null : pair.status
}

export const isSupportedDsh = (version: string | null): boolean =>
  version !== null && resolvePair(version) !== null

/**
 * Version comparison: tolerates a v prefix; null = not probed.
 * Capability two's semantics were upgraded: the old implementation required strict equality with COMPAT_DSH_VERSION;
 * now = being in the matrix (unverified pairs included -- install and warning are layered through pairStatus).
 */
export const dshCompatible = (version: string | null): boolean => isSupportedDsh(version)
