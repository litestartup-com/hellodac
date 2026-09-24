/**
 * 兼容壳（能力二，2026-09-20）：0.1.2 切主路的历史脚本保留原命令行面，
 * 实现 = upgrade-node-version.mjs 固定目标 0.1.2-rc.1（钉版随矩阵守卫同步）。
 *
 * 用法不变：node scripts/upgrade-012-win.mjs [config路径] [--dry-run] [--force]
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
execFileSync(
  process.execPath,
  [join(here, 'upgrade-node-version.mjs'), '0.1.2-rc.1', ...process.argv.slice(2)],
  { stdio: 'inherit' },
)
