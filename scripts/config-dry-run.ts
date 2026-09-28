/**
 * `npm run config:dry` —— 改生产配置前的干跑校验。
 *
 * 为什么需要它：`loadConfig` 会做迁移（可能写备份文件），直接在生产目录里跑一次
 * "试试看"本身就是一次写操作。这里是把它放进临时目录、用副本加载，所以**只读生产文件**：
 * 报错就改，绿了再重启（2026-09-27 首次对外服务上线即按这个顺序走）。
 *
 * 输出 = 解析后的端点/agent/服务清单 + 启动告警（当前配置的全部告警，含死路告警）。
 */
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/config.js'

const CONFIG = process.env.DAC_CONFIG ?? 'manager.config.yaml'
const ENV_FILE = process.env.DAC_ENV ?? '.env'
const dir = mkdtempSync(join(tmpdir(), 'prod-config-dry-'))
copyFileSync(CONFIG, join(dir, 'manager.config.yaml'))
copyFileSync(ENV_FILE, join(dir, '.env'))
const previous = process.cwd()
try {
  process.chdir(dir)
  const cfg = loadConfig(join(dir, 'manager.config.yaml'))
  console.log(`endpoints (${Object.keys(cfg.endpoints).length}):`, Object.keys(cfg.endpoints).join(', '))
  console.log(`agents (${Object.keys(cfg.agents).length}):`, Object.keys(cfg.agents).join(', '))
  console.log(
    `services (${cfg.services?.length ?? 0}):`,
    (cfg.services ?? []).map((s) => `${s.id}[count=${s.count ?? 1} ${s.placement ?? 'spread'} ${s.permission ?? 'read'}]`).join(', '),
  )
  console.log('warnings:', cfg.warnings.length === 0 ? '(none)' : cfg.warnings.join(' | '))
  for (const [id, ep] of Object.entries(cfg.endpoints)) {
    console.log(`  ${id}: ${ep.url} driver=${ep.driver} machine=${ep.spawn?.host ?? 'local'} managed=${ep.spawn?.managed ?? false}`)
  }
} catch (error) {
  console.error('DRY RUN FAILED:', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  process.chdir(previous)
  rmSync(dir, { recursive: true, force: true })
}
