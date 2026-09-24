import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import type { Db } from '../db/index.js'
import { notify } from '../notify.js'
import { registerNotificationRoutes } from './notifications.js'
// 债务 C3:裸测试库收敛进 test-harness(不落 agent 行,notifications 不查 agent)。
import { makeDbWithAgents } from '../test-harness.js'

const boot = (): { app: ReturnType<typeof Fastify>; db: Db } => {
  const db = makeDbWithAgents([])
  const app = Fastify()
  registerNotificationRoutes(app, db, async () => {})
  return { app, db }
}

test('蜂群 P5.3: notifications list unread counts and mark read', async () => {
  const { app, db } = await boot()
  notify(db, { kind: 'cron_done', title: '定时任务完成：周报', body: '做完了', link: '/crons' })
  notify(db, { kind: 'brain_budget', title: '预算用完', body: '明天再来', link: '/spend' })
  notify(db, { kind: 'node_offline', title: '节点挂了', body: 'brain 离线', link: null })

  const list = await app.inject({ method: 'GET', url: '/api/notifications' })
  assert.equal(list.statusCode, 200)
  const body = list.json() as { unread: number; items: Array<{ id: string; title: string; link: string | null; read: boolean }> }
  assert.equal(body.unread, 3)
  assert.equal(body.items.length, 3)
  // 新在前
  assert.equal(body.items[0]?.title, '节点挂了')
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
