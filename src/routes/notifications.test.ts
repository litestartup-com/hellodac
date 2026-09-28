import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import type { Db } from '../db/index.js'
import { notify } from '../notify.js'
import { registerNotificationRoutes } from './notifications.js'
// Debt C3: the bare test database moved into the test harness (no agent rows; notifications never looks up an agent).
import { makeDbWithAgents } from '../test-harness.js'

const boot = (): { app: ReturnType<typeof Fastify>; db: Db } => {
  const db = makeDbWithAgents([])
  const app = Fastify()
  registerNotificationRoutes(app, db, async () => {})
  return { app, db }
}

test('Hive P5.3: notifications list unread counts and mark read', async () => {
  const { app, db } = await boot()
  notify(db, { kind: 'cron_done', title: 'Cron job done: weekly report', body: 'All done', link: '/crons' })
  notify(db, { kind: 'brain_budget', title: 'Budget used up', body: 'Come back tomorrow', link: '/spend' })
  notify(db, { kind: 'node_offline', title: 'Node is down', body: 'brain offline', link: null })

  const list = await app.inject({ method: 'GET', url: '/api/notifications' })
  assert.equal(list.statusCode, 200)
  const body = list.json() as { unread: number; items: Array<{ id: string; title: string; link: string | null; read: boolean }> }
  assert.equal(body.unread, 3)
  assert.equal(body.items.length, 3)
  // newest first
  assert.equal(body.items[0]?.title, 'Node is down')
  assert.equal(body.items[0]?.link, null)

  const one = await app.inject({ method: 'POST', url: `/api/notifications/${body.items[0].id}/read` })
  assert.equal(one.statusCode, 200)

  const after = (await app.inject({ method: 'GET', url: '/api/notifications' })).json() as { unread: number }
  assert.equal(after.unread, 2)

  await app.inject({ method: 'POST', url: '/api/notifications/read-all' })
  const all = (await app.inject({ method: 'GET', url: '/api/notifications' })).json() as { unread: number }
  assert.equal(all.unread, 0)

  const missing = await app.inject({ method: 'POST', url: '/api/notifications/no-such/read' })
  assert.equal(missing.statusCode, 404)
})
