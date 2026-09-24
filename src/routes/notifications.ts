import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import { desc, eq } from 'drizzle-orm'
import type { Db } from '../db/index.js'
import { schema } from '../db/index.js'

/**
 * 蜂群 P5.3：站内通知路由（铃铛）。列表、单条已读、全部已读。
 */
export const registerNotificationRoutes = (app: FastifyInstance, db: Db, requireUser: preHandlerHookHandler): void => {
  app.get('/api/notifications', { preHandler: requireUser }, async () => {
    const items = db
      .select()
      .from(schema.notification)
      .orderBy(desc(schema.notification.at))
      .limit(50)
      .all()
    const unread = items.filter((n) => n.read === 0).length
    return {
      unread,
      items: items.map((n) => ({
        id: n.id,
        kind: n.kind,
        title: n.title,
        body: n.body,
        link: n.link,
        at: n.at,
        read: n.read === 1,
      })),
    }
  })

  app.post('/api/notifications/read-all', { preHandler: requireUser }, async () => {
    db.update(schema.notification).set({ read: 1 }).where(eq(schema.notification.read, 0)).run()
    return { ok: true }
  })

  app.post<{ Params: { id: string } }>('/api/notifications/:id/read', { preHandler: requireUser }, async (request, reply) => {
    const row = db.select().from(schema.notification).where(eq(schema.notification.id, request.params.id)).all()[0]
    if (row === undefined) return reply.code(404).send({ error: 'unknown_notification' })
    db.update(schema.notification).set({ read: 1 }).where(eq(schema.notification.id, row.id)).run()
    return { ok: true }
  })
}
