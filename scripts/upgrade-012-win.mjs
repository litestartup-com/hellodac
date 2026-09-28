/**
 * Compatibility shell (Capability two, 2026-09-20): the historical 0.1.2 main-path switch script keeps its
 * original command line; the implementation = upgrade-node-version.mjs pinned to the 0.1.2-rc.1 target
 * (the pin is kept in sync by the matrix guard).
 *
 * Usage unchanged: node scripts/upgrade-012-win.mjs [config path] [--dry-run] [--force]
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
