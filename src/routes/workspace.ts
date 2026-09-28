import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import type { AppConfig, ResolvedAgent } from '../config.js'
import { inspectWorkspace } from '../workspace/adopt.js'
import { readNoteData } from '../workspace/notedata.js'
import { DEFAULT_RULES, validateNoteData } from '../workspace/validate.js'

const findAgent = (config: AppConfig, id: string): ResolvedAgent | null => config.agents[id] ?? null

export const registerWorkspaceRoutes = (
  app: FastifyInstance,
  config: AppConfig,
  requireUser: preHandlerHookHandler,
): void => {
  app.get<{ Params: { id: string } }>(
    '/api/agents/:id/workspace',
    { preHandler: requireUser },
    async (request, reply) => {
      const agent = findAgent(config, request.params.id)
      if (agent === null) return reply.code(404).send({ error: 'unknown_agent' })
      // Debt E12: the inspection rules follow the agent config (the default is the generic credential check)
      const report = await inspectWorkspace(agent.workspacePath, agent.validate ?? DEFAULT_RULES)
      return reply.send({ agent: { id: agent.id, name: agent.name }, ...report })
    },
  )

  app.get<{ Params: { id: string } }>(
    '/api/agents/:id/notedata',
    { preHandler: requireUser },
    async (request, reply) => {
      const agent = findAgent(config, request.params.id)
      if (agent === null) return reply.code(404).send({ error: 'unknown_agent' })
      const { data, loaded, problems } = readNoteData(agent.workspacePath)
      // Reported alongside the data rather than blocking the read: the dashboard
      // should still render what exists, with the problems visible.
      // Debt E12: the violation check follows the agent rules (the default is the generic credential check)
      const violations = validateNoteData(data, { rules: agent.validate ?? DEFAULT_RULES })
      return reply.send({ loaded, problems, violations, data })
    },
  )
}
