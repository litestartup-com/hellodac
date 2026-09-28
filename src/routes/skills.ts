import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import type { AppConfig } from '../config.js'
import { currentHead } from '../workspace/snapshot.js'

/**
 * Hive P5.2: the skill list (v1 is read-only).
 *
 * A skill's source of truth = `.skills/<name>/SKILL.md` in each agent's workspace (the file is truth);
 * the version = the workspace git HEAD (workspace nesting fixed 2026-09-05, same source as the run
 * audit). Enabling/dispatching/repo writes belong to P5.5's config writeback -- no fake buttons here.
 */

export interface SkillInfo {
  name: string
  /** The first-line title of SKILL.md (with the # stripped), or an empty string. */
  description: string
  file: string
}

export interface AgentSkills {
  agentId: string
  agentName: string
  workspacePath: string
  /** The workspace git HEAD short hash; null = not a git repo (audit not in effect). */
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

    // The conventional skills repo location (the future source for dispatch/sync). Reports status only; writes nothing.
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
