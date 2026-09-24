import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import type { AppConfig } from '../config.js'
import { currentHead } from '../workspace/snapshot.js'

/**
 * 蜂群 P5.2：技能清单（v1 只读）。
 *
 * 技能的真相源 = 每个 agent 工作区的 `.skills/<name>/SKILL.md`（文件即真相）；
 * 版本 = 工作区 git HEAD（2026-09-05 已修复工作区嵌套，运行审计与技能版本同源）。
 * 启停/分发/仓库化写入是 P5.5 配置写回机制的事——本页不放假按钮。
 */

export interface SkillInfo {
  name: string
  /** SKILL.md 的第一行标题（去掉 #），或空串。 */
  description: string
  file: string
}

export interface AgentSkills {
  agentId: string
  agentName: string
  workspacePath: string
  /** 工作区 git HEAD 短哈希；null = 不是 git 仓库（审计未生效）。 */
  version: string | null
  skills: SkillInfo[]
}

const SKILLS_REPO = `${process.env.USERPROFILE ?? process.env.HOME ?? '.'}/.dac/skills`

const scanSkills = async (workspacePath: string): Promise<SkillInfo[]> => {
  const root = join(workspacePath, '.skills')
  if (!existsSync(root)) return []
  let entries: string[] = []
  try {
    entries = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
  const out: SkillInfo[] = []
  for (const name of entries.sort()) {
    const file = join(root, name, 'SKILL.md')
    if (!existsSync(file)) continue
    let description = ''
    try {
      const first = readFileSync(file, 'utf8').split(/\r?\n/).find((line) => line.startsWith('# '))
      description = first === undefined ? '' : first.replace(/^#+\s*/, '')
    } catch {
      // unreadable skill file: still list it, without a description
    }
    out.push({ name, description, file: relative(workspacePath, file).replace(/\\/g, '/') })
  }
  return out
}

export const registerSkillsRoutes = (app: FastifyInstance, config: AppConfig, requireUser: preHandlerHookHandler): void => {
  app.get('/api/skills', { preHandler: requireUser }, async () => {
    const agents = await Promise.all(
      Object.values(config.agents).map(async (agent) => ({
        agentId: agent.id,
        agentName: agent.name,
        workspacePath: agent.workspacePath,
        version: await currentHead(agent.workspacePath),
        skills: await scanSkills(agent.workspacePath),
      })),
    )

    // 约定俗成的技能仓库位置（未来分发/同步的源）。现在只报状态，不写。
    const repo = existsSync(join(SKILLS_REPO, '.git'))
      ? {
          path: SKILLS_REPO,
          version: await currentHead(SKILLS_REPO),
        }
      : null

    return {
      agents,
      repo,
      note:
        'Skill files live under .skills/ in each workspace (files are the source of truth); version = workspace git HEAD. ' +
        'Enabling and distribution arrive with the config write-back mechanism.',
    }
  })
}
