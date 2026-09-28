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
 * The 0.1.2 line (switched onto the main road): the facade plugin's package name = ohdsh-api-facade (the dac-
 * prefix convention). The repository URL is still litestartup-com/dsh-api-gateway (the pinning chain stays put for
 * now), referencing the latest commit on the next-012 branch.
 */
export const GATEWAY_PACKAGE = 'ohdsh-api-facade'
export const GATEWAY_REF = 'github:litestartup-com/dsh-api-gateway#b592b4f'

export const SUPPORTED_DSH: DshPair[] = [
  { dsh: '0.1.2-rc.1', gateway: GATEWAY_REF, status: 'verified' },
  // P3 smoke (2026-09-20, the smoke15 node on the intranet pilot server): a 0.1.5-rc.2 host plus
  // facade b592b4f passed the full chain -- host.describe synthesised version / session.create /
  // a real session.prompt turn / the mux frame stream (user -> assistant -> turn/end). Fact card
  // dsh-facts.md §9/§10: installing needs --legacy-peer-deps (the facade peer range does not cover the
  // 0.1.5 line) and running needs node ≥22.19 (node 24 was used).
  { dsh: '0.1.5-rc.2', gateway: GATEWAY_REF, status: 'verified', needsLegacyPeerDeps: true },
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
