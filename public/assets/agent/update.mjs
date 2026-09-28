// @ts-check
/**
 * Capability four (Fleet M4-3): atomic agent self-update -- uses node:fs only, and is called before the entry
 * imports runtime (the new code must be swapped in before it can take effect).
 *
 * Layout (under AGENT_DIR):
 * - .next/        the new files waiting to be applied (agent.mjs + runtime.mjs + .version) --
 *                 staged by execUpdate after verification, swapped in atomically when the entry starts;
 * - .prev/        the previous generation (the rollback source, one generation kept);
 * - .update-version  the version string currently running (reported by version negotiation);
 * - .update-at    the timestamp of the last swap (used to detect an instant crash for rollback);
 * - .last-boot    the previous startup timestamp (written on this startup; a gap <90s together with a swap
 *                 less than 10min ago = the new code is in an instant-crash loop (the scheduled task restarts
 *                 every 60s) -> roll back).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'

export const NEXT_DIR = '.next'
export const PREV_DIR = '.prev'
export const UPDATE_VERSION_FILE = '.update-version'
export const UPDATE_AT_FILE = '.update-at'
export const BOOT_MARKER = '.last-boot'
/** The runtime files carried by a self-update (both the swap and the rollback follow this list). */
export const RUNTIME_FILES = ['agent.mjs', 'runtime.mjs', 'update.mjs']
/** Instant-crash test: a gap between two startups below this value and a swap less than 10 minutes ago = roll back. */
export const CRASH_GAP_MS = 90_000
export const UPDATE_AGE_MS = 10 * 60_000

const readTs = (path) => {
  try {
    const n = Number(readFileSync(path, 'utf8').trim())
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

const renameBack = (prevDir, agentDir, log) => {
  for (const name of RUNTIME_FILES) {
    if (!existsSync(`${prevDir}/${name}`)) continue
    rmSync(`${agentDir}/${name}`, { force: true })
    renameSync(`${prevDir}/${name}`, `${agentDir}/${name}`)
  }
  rmSync(prevDir, { recursive: true, force: true })
  log('[node-agent] rolled back to the previous generation (the new code crashed immediately)')
}

/**
 * Called at startup: decide on a rollback first, then apply a pending .next. Returns { updated }.
 * @param {string} agentDir
 * @param {(line: string) => void} [log]
 */
export const applyPendingUpdate = (agentDir, log = () => {}) => {
  const nextDir = `${agentDir}/${NEXT_DIR}`
  const prevDir = `${agentDir}/${PREV_DIR}`
  const updateAtPath = `${agentDir}/${UPDATE_AT_FILE}`
  const bootMarker = `${agentDir}/${BOOT_MARKER}`

  // 1) instant-crash rollback decision (before any swap)
  const updatedAt = readTs(updateAtPath)
  const lastBoot = readTs(bootMarker)
  if (updatedAt !== null && lastBoot !== null && Date.now() - updatedAt < UPDATE_AGE_MS && Date.now() - lastBoot < CRASH_GAP_MS && existsSync(`${prevDir}/agent.mjs`)) {
    renameBack(prevDir, agentDir, log)
    rmSync(updateAtPath, { force: true })
    rmSync(`${agentDir}/${UPDATE_VERSION_FILE}`, { force: true })
  }
  writeFileSync(bootMarker, String(Date.now()), 'utf8')

  // 2) apply a pending .next (atomic swap: current -> .prev, .next -> current)
  if (existsSync(nextDir)) {
    try {
      mkdirSync(prevDir, { recursive: true })
      for (const name of RUNTIME_FILES) {
        if (existsSync(`${agentDir}/${name}`)) {
          rmSync(`${prevDir}/${name}`, { force: true })
          renameSync(`${agentDir}/${name}`, `${prevDir}/${name}`)
        }
      }
      for (const name of RUNTIME_FILES) {
        if (existsSync(`${nextDir}/${name}`)) renameSync(`${nextDir}/${name}`, `${agentDir}/${name}`)
      }
      const version = existsSync(`${nextDir}/.version`) ? readFileSync(`${nextDir}/.version`, 'utf8').trim() : ''
      rmSync(nextDir, { recursive: true, force: true })
      if (version !== '') writeFileSync(`${agentDir}/${UPDATE_VERSION_FILE}`, version, 'utf8')
      writeFileSync(updateAtPath, String(Date.now()), 'utf8')
      log(`[node-agent] self-update applied${version !== '' ? ` (-> ${version})` : ''}; restart through the service manager to load the new code`)
    } catch (error) {
      log(`[node-agent] self-update failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { updated: existsSync(updateAtPath) && Date.now() - (readTs(updateAtPath) ?? 0) < 60_000 }
}

/** The version string currently running (reported by version negotiation; none = null). */
export const currentAgentVersion = (agentDir) => {
  try {
    const v = readFileSync(`${agentDir}/${UPDATE_VERSION_FILE}`, 'utf8').trim()
    return v === '' ? null : v
  } catch {
    return null
  }
}
