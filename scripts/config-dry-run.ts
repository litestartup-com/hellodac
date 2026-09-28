/**
 * `npm run config:dry` -- dry-run check before editing the production config.
 *
 * Why it exists: `loadConfig` migrates (and may write a backup file), so running it in place
 * to "see whether it parses" is already a write. This copies the config and `.env` into a temp
 * directory and loads that copy, so the production files are only ever read: red means fix it,
 * green means the restart will come up (the order used when the first outward service went live).
 *
 * Output: the resolved endpoints/agents/services plus every startup warning.
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
