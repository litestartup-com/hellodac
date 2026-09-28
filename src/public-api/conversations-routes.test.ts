import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { mintApiKey, type ApiKey, type KeyScope } from '../auth/api-key.js'
import { createChat, findLiveConversation, getChat } from '../chat/store.js'
import type { AppConfig } from '../config.js'
import { openDb, schema, type Db } from '../db/index.js'
import { buildPublicApiApp } from './listener.js'
import type { PublicApiPorts } from './routes.js'

/**
 * `POST /v1/conversations` 与 `/messages` 的对外契约（口径 CONCEPTS-ALIGNED.md §4.2/§6）。
 *
 * 这里钉的是"客户能感知到的后果"：拿到会话号、同一用户回到同一会话、别人的会话看不见、
 * 满载会被明确拒绝、回合失败不会被伪装成成功。
 */
const agent = (id: string): Record<string, unknown> => ({
  id,
  name: id,
  endpoint: `ep-${id}`,
  workspacePath: '.',
  public: true,
  preset: null,
  sandboxMode: 'read-only',
  gitRemote: null,
  provider: null,
  model: null,
  validate: null,
})

const config = (over: Partial<AppConfig> = {}): AppConfig =>
  ({
    listen: { host: '127.0.0.1', port: 8080 },
    endpoints: {},
    agents: { a: agent('a'), b: agent('b') },
    services: [
      {
        id: 'chat',
        label: '客服',
        workers: ['a', 'b'],
        surfaces: ['conversations'],
        knowledge: [],
        count: 2,
        maxSessionsPerAgent: 4,
        permission: 'read',
        sessionIdleHours: 24,
        placement: 'pin',
        machines: ['m1'],
        maxAgentsPerMachine: 4,
      },
      { id: 'report', label: '报表', workers: ['a'], surfaces: ['tasks'], knowledge: [], count: 1 },
    ],
    runner: { timeoutMs: 1000, silenceMs: 0, maxConsecutiveFailures: 3, dailyBudgetMicroUsd: null },
    databasePath: ':memory:',
    pricing: { rates: {}, peakWindows: [] },
    sessionSecret: 'x'.repeat(32),
    initialUser: { username: 'admin', password: null },
    warnings: [],
    ...over,
  }) as unknown as AppConfig

interface Harness {
  db: Db
  app: FastifyInstance
  key: ApiKey
  token: string
  turnCalls: Array<{ chatId: string; agentId: string; text: string; apiKeyId: string }>
}

/** chat.agent_id 是指向 agent(id) 的外键：夹具必须先把 agent 行落库，会话才建得起来。 */
const seedAgents = (db: Db, ids: string[] = ['a', 'b']): void => {
  for (const id of ids) {
    db.insert(schema.agent)
      .values({ id, name: id, workspacePath: '.', endpoint: `ep-${id}`, preset: null, gitRemote: null, public: 1, createdAt: Date.now() })
      .run()
  }
}

const setup = (over: {
  scopes?: KeyScope[]
  scopeServices?: string[]
  quotaRunsDay?: number | null
  maxConcurrency?: number
  online?: string[]
  withPorts?: boolean
} = {}): Harness => {
  const { db } = openDb(':memory:')
  seedAgents(db)
  const { token, key } = mintApiKey(db, {
    name: '甲方产品',
    scopes: over.scopes ?? ['services:read', 'usage:read', 'conversations:write'],
    scopeServices: over.scopeServices ?? ['chat'],
    createdBy: 'admin',
    ...(over.quotaRunsDay === undefined ? {} : { quotaRunsDay: over.quotaRunsDay }),
    ...(over.maxConcurrency === undefined ? {} : { maxConcurrency: over.maxConcurrency }),
  })
  const turnCalls: Harness['turnCalls'] = []
  const online = new Set(over.online ?? ['a', 'b'])
  const ports: PublicApiPorts = {
    isOnline: (agentId) => online.has(agentId),
    runTurn: async (input) => {
      turnCalls.push(input)
      // 记一行 run，模拟真实回合会留下的账（配额/并发都读它）。
      db.insert(schema.run)
        .values({
          id: `run-${turnCalls.length}`,
          agentId: input.agentId,
          chatId: input.chatId,
          dshSessionId: null,
          trigger: 'manual',
          idempotencyKey: null,
          apiKeyId: input.apiKeyId,
          state: 'done',
          resultSummary: `答复：${input.text}`,
          startedAt: 1,
          endedAt: 2,
          error: null,
          conflict: null,
        })
        .run()
      return {
        runId: `run-${turnCalls.length}`,
        state: 'done' as const,
        sessionId: 'sess-1',
        summary: `答复：${input.text}`,
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15 },
        costMicroUsd: 1234,
        peakCostMicroUsd: 0,
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        reason: 'turn_end',
        error: null,
        toolCalls: 0,
        durationMs: 42,
        commit: null,
        changedFiles: [],
        conflict: null,
        snapshotSkipped: null,
      }
    },
  }
  const app = buildPublicApiApp({ config: config(), db, ...(over.withPorts === false ? {} : { ports }) })
  return { db, app, key, token, turnCalls }
}

const auth = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` })
const post = async (app: FastifyInstance, url: string, token: string, body: Record<string, unknown>) =>
  await app.inject({ method: 'POST', url, headers: auth(token), payload: body })

test('建会话: 挑最闲的 agent、写清归属、返回会话号（带 text 时同一请求里跑完第一轮）', async () => {
  const h = setup()
  // 让 a 忙起来（两个活会话），于是应当挑 b。
  createChat(h.db, 'a')
  createChat(h.db, 'a')

  const res = await post(h.app, '/v1/conversations', h.token, { externalUserId: 'user-1', text: '退款为什么失败' })
  assert.equal(res.statusCode, 201, res.body)
  const body = res.json() as { conversationId: string; agentId: string; created: boolean; reply: string }
  assert.equal(body.agentId, 'b', '挑最闲的')
  assert.equal(body.created, true)
  assert.equal(body.reply, '答复：退款为什么失败')
  assert.equal(h.turnCalls.length, 1)
  assert.equal(h.turnCalls[0]?.apiKeyId, h.key.id, '账记在这把钥匙上')

  const row = getChat(h.db, body.conversationId)
  assert.equal(row?.apiKeyId, h.key.id)
  assert.equal(row?.externalUserId, 'user-1')
  assert.equal(row?.serviceId, 'chat')
})

test('粘性: 同一个外部用户再次调用回到同一会话，且不再跑分发', async () => {
  const h = setup()
  const first = await post(h.app, '/v1/conversations', h.token, { externalUserId: 'user-7' })
  assert.equal(first.statusCode, 201)
  const firstId = (first.json() as { conversationId: string }).conversationId

  const again = await post(h.app, '/v1/conversations', h.token, { externalUserId: 'user-7', text: '还在吗' })
  assert.equal(again.statusCode, 200)
  const body = again.json() as { conversationId: string; created: boolean; agentId: string; reply: string }
  assert.equal(body.conversationId, firstId, '同一用户 = 同一会话')
  assert.equal(body.created, false)
  assert.equal(body.reply, '答复：还在吗')
  assert.equal(h.db.select().from(schema.chat).all().length, 1, '没有多建会话')
})

test('粘性隔离: 不同钥匙的同一个外部用户 id 互不影响', async () => {
  const h = setup()
  const other = mintApiKey(h.db, {
    name: '另一个甲方',
    scopes: ['conversations:write'],
    scopeServices: ['chat'],
    createdBy: 'admin',
  })
  const mine = await post(h.app, '/v1/conversations', h.token, { externalUserId: 'u1' })
  const theirs = await post(h.app, '/v1/conversations', other.token, { externalUserId: 'u1' })
  assert.notEqual(
    (mine.json() as { conversationId: string }).conversationId,
    (theirs.json() as { conversationId: string }).conversationId,
    '锚点是"钥匙 + 用户"，不是用户 id 本身',
  )
})

test('续聊: 会话号 + 这把钥匙能发消息；别人的会话号 = 404（不区分不存在）', async () => {
  const h = setup()
  const created = await post(h.app, '/v1/conversations', h.token, {})
  const id = (created.json() as { conversationId: string }).conversationId

  const mine = await post(h.app, `/v1/conversations/${id}/messages`, h.token, { text: '第二句' })
  assert.equal(mine.statusCode, 200, mine.body)
  assert.equal((mine.json() as { reply: string }).reply, '答复：第二句')

  const other = mintApiKey(h.db, { name: '别人', scopes: ['conversations:write'], scopeServices: ['chat'], createdBy: 'admin' })
  const stolen = await post(h.app, `/v1/conversations/${id}/messages`, other.token, { text: '偷看' })
  assert.equal(stolen.statusCode, 404)
  assert.equal((stolen.json() as { error: string }).error, 'unknown_conversation')

  const ghost = await post(h.app, '/v1/conversations/does-not-exist/messages', h.token, { text: 'x' })
  assert.equal(ghost.statusCode, 404, '不存在与不是你的，对外同一种回答')
})

test('满载: 所有 agent 到并发上限 → 429 + Retry-After（不静默排队）', async () => {
  const h = setup()
  for (let i = 0; i < 4; i += 1) createChat(h.db, 'a')
  for (let i = 0; i < 4; i += 1) createChat(h.db, 'b')

  const res = await post(h.app, '/v1/conversations', h.token, {})
  assert.equal(res.statusCode, 429)
  assert.equal((res.json() as { error: string }).error, 'all_agents_busy')
  assert.ok(res.headers['retry-after'] !== undefined, '要告诉调用方什么时候可以再试')
})

test('全员离线 → 503；配额用完 → 429；服务不在钥匙范围 → 403', async () => {
  const offline = setup({ online: [] })
  const down = await post(offline.app, '/v1/conversations', offline.token, {})
  assert.equal(down.statusCode, 503)
  assert.equal((down.json() as { error: string }).error, 'no_agent_online')

  // 配额按"这把钥匙今天已经跑了几轮"算，所以先把今天的账记上一笔（quota 最小是 1）。
  const spent = setup({ quotaRunsDay: 1 })
  spent.db
    .insert(schema.run)
    .values({
      id: 'run-today',
      agentId: 'a',
      chatId: null,
      dshSessionId: null,
      trigger: 'manual',
      idempotencyKey: null,
      apiKeyId: spent.key.id,
      state: 'done',
      resultSummary: null,
      startedAt: Date.now(),
      endedAt: Date.now(),
      error: null,
      conflict: null,
    })
    .run()
  const over = await post(spent.app, '/v1/conversations', spent.token, {})
  assert.equal(over.statusCode, 429)
  assert.equal((over.json() as { error: string }).error, 'quota_exhausted')

  const narrow = setup({ scopeServices: ['chat'] })
  const denied = await post(narrow.app, '/v1/conversations', narrow.token, { service: 'report' })
  assert.equal(denied.statusCode, 403)
  assert.equal((denied.json() as { error: string }).error, 'service_not_allowed')
})

test('wiring 没注入会话面时回 503，而不是假装建好了会话', async () => {
  const h = setup({ withPorts: false })
  const res = await post(h.app, '/v1/conversations', h.token, {})
  assert.equal(res.statusCode, 503)
  assert.equal((res.json() as { error: string }).error, 'conversations_unavailable')
  assert.equal(h.db.select().from(schema.chat).all().length, 0, '没有留下半个会话')
})

test('回合失败: 502 带原因，而不是 200 空答复（客户要能区分"没送到"与"跑了但失败"）', async () => {
  const { db } = openDb(':memory:')
  seedAgents(db)
  const { token } = mintApiKey(db, { name: '甲方', scopes: ['conversations:write'], scopeServices: ['chat'], createdBy: 'admin' })
  const app = buildPublicApiApp({
    config: config(),
    db,
    ports: { isOnline: () => true, runTurn: async () => { throw new Error('agent blew up') } },
  })
  const res = await post(app, '/v1/conversations', token, { text: '你好' })
  assert.equal(res.statusCode, 502)
  assert.equal((res.json() as { detail: string }).detail, 'agent blew up')
})

test('数据库侧保证: 同一把钥匙 + 同一外部用户的活会话只能有一条（并发重复创建撞唯一索引）', () => {
  const h = setup()
  createChat(h.db, 'a', Date.now(), { apiKeyId: h.key.id, externalUserId: 'u-live', serviceId: 'chat' })
  assert.throws(
    () => createChat(h.db, 'b', Date.now(), { apiKeyId: h.key.id, externalUserId: 'u-live', serviceId: 'chat' }),
    /UNIQUE/i,
    '靠索引挡住竞态，而不是"先查再插"',
  )

  // 归档之后可以再开一个新的（部分索引只约束活会话）。
  const first = findLiveConversation(h.db, h.key.id, 'u-live')
  assert.ok(first !== null)
  h.db.update(schema.chat).set({ removedAt: Date.now() }).where(eq(schema.chat.id, first.id)).run()
  assert.doesNotThrow(() =>
    createChat(h.db, 'b', Date.now(), { apiKeyId: h.key.id, externalUserId: 'u-live', serviceId: 'chat' }),
  )
})

test('粘性查询只认活会话（归档后同用户再来 = 新会话）', async () => {
  const h = setup()
  const created = await post(h.app, '/v1/conversations', h.token, { externalUserId: 'u9' })
  const id = (created.json() as { conversationId: string }).conversationId
  h.db.update(schema.chat).set({ removedAt: Date.now() }).where(eq(schema.chat.id, id)).run()
  assert.equal(findLiveConversation(h.db, h.key.id, 'u9'), null)

  const fresh = await post(h.app, '/v1/conversations', h.token, { externalUserId: 'u9' })
  assert.equal((fresh.json() as { created: boolean }).created, true)
})
