import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import type { Db } from '../db/index.js'
import { listAudit } from '../audit.js'

/** 蜂群2计划 P3：审计流水（只读，最新在前）。 */
export const registerAuditRoutes = (app: FastifyInstance, db: Db, requireUser: preHandlerHookHandler): void => {
  app.get<{ Querystring: { limit?: string } }>('/api/audit', { preHandler: requireUser }, async (request, reply) => {
    const limit = Math.min(Math.max(Number(request.query.limit ?? 200) || 200, 1), 1000)
    return reply.send({ entries: listAudit(db, limit) })
  })
}
