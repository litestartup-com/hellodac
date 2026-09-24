/**
 * 蜂群2计划 P1：DSH 版本治理单一真相源（re-export 垫片）。
 *
 * 能力二（2026-09-20）：常量与矩阵已迁至 dsh-matrix.ts（版本配对表 =
 * 真相源）。本文件保留既有导入面——全部常量照旧可用。
 */
export {
  COMPAT_DSH_PACKAGE, COMPAT_DSH_VERSION, DSH_INSTALL_COMMAND,
  GATEWAY_PACKAGE, GATEWAY_REF, dshCompatible,
  SUPPORTED_DSH, defaultDshVersion, resolvePair, pairStatus, isSupportedDsh,
  type DshPair,
} from './dsh-matrix.js'
