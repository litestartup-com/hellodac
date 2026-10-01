/**
 * Hive plan 2 P1: the single source of truth for DSH version governance (a re-export shim).
 *
 * Capability two (2026-09-20): the constants and the matrix moved to dsh-matrix.ts (the version pair
 * table is the source of truth). This file keeps the existing import surface -- every constant still works.
 */
export {
  COMPAT_DSH_PACKAGE, COMPAT_DSH_VERSION, DSH_INSTALL_COMMAND,
  GATEWAY_PACKAGE, GATEWAY_REF, GATEWAY_REF_LEGACY, dshCompatible, isLegacyDshLine,
  SUPPORTED_DSH, defaultDshVersion, resolvePair, pairStatus, isSupportedDsh,
  type DshPair,
} from './dsh-matrix.js'
