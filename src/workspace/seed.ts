/**
 * 蜂群2计划 P6：容器路径没有 setup 步骤——空工作区在 manager 启动时自动播种
 * 模板（与裸机 setup 行为对齐）。只碰「完全空」的目录：有任何文件的工作区
 * （笔记库、向导建的工作区）一律不动。
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
