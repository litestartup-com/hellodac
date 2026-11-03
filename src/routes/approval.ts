import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import type { AppConfig } from '../config.js'
import type { Db } from '../db/index.js'
import { schema } from '../db/index.js'
import type { SessionDriver } from '../session-driver/port.js'
import { decidePendingApproval } from '../approval.js'

/**
 * The user-facing half of headless approval (design doc hive/topics/headless-approval-p1.md): the
 * PO sees pending permission prompts here and decides them with a logged-in session. The decide path
 * itself is shared with the internal brain-token endpoint (src/approval.ts); only the door differs.
 */
export const registerApprovalRoutes = (
  app: FastifyInstance,
  config: AppConfig,
  db: Db,
  requireUser: preHandlerHookHandler,
  upstreamClients: Map<string, SessionDriver>,
): void => {
  app.get('/api/approvals', { preHandler: requireUser }, async (_request, reply) => {
    const rows = db.select().from(schema.approvalQueue).all()
    return reply.send({ ok: true, approvals: rows })
  })

  app.post<{ Params: { decisionId: string }; Body: { outcome?: unknown } }>(
    '/api/approvals/:decisionId',
    { preHandler: requireUser },
    async (request, reply) => {
      const actor = (request as unknown as { currentUser?: { username?: string } }).currentUser?.username ?? 'unknown'
      const result = await decidePendingApproval(
        db,
        config,
        upstreamClients,
        request.params.decisionId,
        request.body?.outcome,
        actor,
      )
      return reply.code(result.status).send(result.body)
    },
  )
}
