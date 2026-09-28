import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import type { Db } from '../db/index.js'
import { listAudit } from '../audit.js'

/** Hive plan 2 P3: audit trail (read-only, newest first). */
export const registerAuditRoutes = (app: FastifyInstance, db: Db, requireUser: preHandlerHookHandler): void => {
  app.get<{ Querystring: { limit?: string } }>('/api/audit', { preHandler: requireUser }, async (request, reply) => {
    const limit = Math.min(Math.max(Number(request.query.limit ?? 200) || 200, 1), 1000)
    return reply.send({ entries: listAudit(db, limit) })
  })
}
