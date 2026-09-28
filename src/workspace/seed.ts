/**
 * Hive plan 2 P6: the container path has no setup step -- an empty workspace is seeded with templates
 * when the manager starts (aligned with bare-metal setup). Only a completely empty directory is
 * touched: a workspace with any file at all (a note vault, a wizard-made workspace) is left alone.
 */
import { existsSync, readdirSync } from 'node:fs'
import { ensureWorkspaceGit, initWorkspace, listPresets } from './init.js'

export const seedEmptyWorkspaces = (
  agents: Array<{ id: string; workspacePath: string }>,
  log?: (line: string) => void,
): string[] => {
  const presets = listPresets()
  const seeded: string[] = []
  for (const agent of agents) {
    const ws = agent.workspacePath
    if (!existsSync(ws)) continue
    if (readdirSync(ws).length > 0) continue
    const preset = [agent.id, ...presets].find((p) => presets.includes(p))
    try {
      if (preset !== undefined) {
        initWorkspace({ workspacePath: ws, preset })
        log?.(`workspace ${agent.id}: seeded preset "${preset}" (empty directory; the container path has no setup step)`)
      } else {
        ensureWorkspaceGit(ws, agent.id)
        log?.(`workspace ${agent.id}: no matching template; did a minimal git init`)
      }
      seeded.push(agent.id)
    } catch (error) {
      log?.(`workspace ${agent.id}: seed failed: ${(error as Error).message.split('\n')[0]}`)
    }
  }
  return seeded
}
