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
 * Outward contract of `POST /v1/conversations` and `/messages` (contract CONCEPTS-ALIGNED.md §4.2/§6).
 *
 * What is pinned here is what a customer can observe: they get a conversation id, the same user returns to the same
 * conversation, a conversation belonging to somebody else is invisible, full capacity is refused explicitly, and a
 * failed turn is never disguised as a successful one.
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
        label: 'Support',
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
      { id: 'report', label: 'Reporting', workers: ['a'], surfaces: ['tasks'], knowledge: [], count: 1 },
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

/** chat.agent_id is a foreign key to agent(id): the fixture must insert agent rows first or no conversation can be created. */
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
    name: 'Customer product',
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
      // record a run row, the way a real turn leaves an entry (quota and concurrency both read it).
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
          resultSummary: `reply: ${input.text}`,
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
        summary: `reply: ${input.text}`,
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

test('creating a conversation: picks the least busy agent, records ownership, returns the id (with text it runs the first turn too)', async () => {
  const h = setup()
  // make agent a busy (two live conversations), so agent b should be chosen.
  createChat(h.db, 'a')
  createChat(h.db, 'a')

  const res = await post(h.app, '/v1/conversations', h.token, { externalUserId: 'user-1', text: 'why did the refund fail' })
  assert.equal(res.statusCode, 201, res.body)
  const body = res.json() as { conversationId: string; agentId: string; created: boolean; reply: string }
  assert.equal(body.agentId, 'b', 'picks the least busy one')
  assert.equal(body.created, true)
  assert.equal(body.reply, 'reply: why did the refund fail')
  assert.equal(h.turnCalls.length, 1)
  assert.equal(h.turnCalls[0]?.apiKeyId, h.key.id, 'the run is booked to this key')

  const row = getChat(h.db, body.conversationId)
  assert.equal(row?.apiKeyId, h.key.id)
  assert.equal(row?.externalUserId, 'user-1')
  assert.equal(row?.serviceId, 'chat')
})

test('stickiness: the same external user returns to the same conversation, without dispatching again', async () => {
  const h = setup()
  const first = await post(h.app, '/v1/conversations', h.token, { externalUserId: 'user-7' })
  assert.equal(first.statusCode, 201)
  const firstId = (first.json() as { conversationId: string }).conversationId

  const again = await post(h.app, '/v1/conversations', h.token, { externalUserId: 'user-7', text: 'still there?' })
  assert.equal(again.statusCode, 200)
  const body = again.json() as { conversationId: string; created: boolean; agentId: string; reply: string }
  assert.equal(body.conversationId, firstId, 'same user = same conversation')
  assert.equal(body.created, false)
  assert.equal(body.reply, 'reply: still there?')
  assert.equal(h.db.select().from(schema.chat).all().length, 1, 'no extra conversation was created')
})

test('stickiness isolation: the same external user id under different keys does not interfere', async () => {
  const h = setup()
  const other = mintApiKey(h.db, {
    name: 'Another customer',
    scopes: ['conversations:write'],
    scopeServices: ['chat'],
    createdBy: 'admin',
  })
  const mine = await post(h.app, '/v1/conversations', h.token, { externalUserId: 'u1' })
  const theirs = await post(h.app, '/v1/conversations', other.token, { externalUserId: 'u1' })
  assert.notEqual(
    (mine.json() as { conversationId: string }).conversationId,
    (theirs.json() as { conversationId: string }).conversationId,
    'the anchor is "key + user", not the user id alone',
  )
})

test('continuing: the conversation id plus this key can send a message; a conversation id belonging to somebody else answers 404 (indistinguishable from missing)', async () => {
  const h = setup()
  const created = await post(h.app, '/v1/conversations', h.token, {})
  const id = (created.json() as { conversationId: string }).conversationId

  const mine = await post(h.app, `/v1/conversations/${id}/messages`, h.token, { text: 'second message' })
  assert.equal(mine.statusCode, 200, mine.body)
  assert.equal((mine.json() as { reply: string }).reply, 'reply: second message')

  const other = mintApiKey(h.db, { name: 'Someone else', scopes: ['conversations:write'], scopeServices: ['chat'], createdBy: 'admin' })
  const stolen = await post(h.app, `/v1/conversations/${id}/messages`, other.token, { text: 'peek' })
  assert.equal(stolen.statusCode, 404)
  assert.equal((stolen.json() as { error: string }).error, 'unknown_conversation')

  const ghost = await post(h.app, '/v1/conversations/does-not-exist/messages', h.token, { text: 'x' })
  assert.equal(ghost.statusCode, 404, 'missing and not-yours get the same answer outward')
})

test('full: every agent at its cap -> 429 + Retry-After (no silent queuing)', async () => {
  const h = setup()
  for (let i = 0; i < 4; i += 1) createChat(h.db, 'a')
  for (let i = 0; i < 4; i += 1) createChat(h.db, 'b')

  const res = await post(h.app, '/v1/conversations', h.token, {})
  assert.equal(res.statusCode, 429)
  assert.equal((res.json() as { error: string }).error, 'all_agents_busy')
  assert.ok(res.headers['retry-after'] !== undefined, 'the caller must be told when to try again')
})

test('everyone offline -> 503; quota spent -> 429; service outside the key scope -> 403', async () => {
  const offline = setup({ online: [] })
  const down = await post(offline.app, '/v1/conversations', offline.token, {})
  assert.equal(down.statusCode, 503)
  assert.equal((down.json() as { error: string }).error, 'no_agent_online')

  // quota counts how many runs this key already did today, so book one run first (the minimum quota is 1).
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

test('without the conversation surface wired in, the answer is 503 rather than pretending a conversation exists', async () => {
  const h = setup({ withPorts: false })
  const res = await post(h.app, '/v1/conversations', h.token, {})
  assert.equal(res.statusCode, 503)
  assert.equal((res.json() as { error: string }).error, 'conversations_unavailable')
  assert.equal(h.db.select().from(schema.chat).all().length, 0, 'not even half a conversation is left behind')
})

test('a failed turn: 502 with the reason, not 200 with an empty reply (a caller must tell "never arrived" from "ran and failed")', async () => {
  const { db } = openDb(':memory:')
  seedAgents(db)
  const { token } = mintApiKey(db, { name: 'Customer Co', scopes: ['conversations:write'], scopeServices: ['chat'], createdBy: 'admin' })
  const app = buildPublicApiApp({
    config: config(),
    db,
    ports: { isOnline: () => true, runTurn: async () => { throw new Error('agent blew up') } },
  })
  const res = await post(app, '/v1/conversations', token, { text: 'hello' })
  assert.equal(res.statusCode, 502)
  assert.equal((res.json() as { detail: string }).detail, 'agent blew up')
})

test('database guarantee: one key plus one external user can only have a single live conversation (concurrent creates hit the unique index)', () => {
  const h = setup()
  createChat(h.db, 'a', Date.now(), { apiKeyId: h.key.id, externalUserId: 'u-live', serviceId: 'chat' })
  assert.throws(
    () => createChat(h.db, 'b', Date.now(), { apiKeyId: h.key.id, externalUserId: 'u-live', serviceId: 'chat' }),
    /UNIQUE/i,
    'the index stops the race, not a check-then-insert',
  )

  // after archiving, a fresh one can be opened (the partial index only covers live conversations).
  const first = findLiveConversation(h.db, h.key.id, 'u-live')
  assert.ok(first !== null)
  h.db.update(schema.chat).set({ removedAt: Date.now() }).where(eq(schema.chat.id, first.id)).run()
  assert.doesNotThrow(() =>
    createChat(h.db, 'b', Date.now(), { apiKeyId: h.key.id, externalUserId: 'u-live', serviceId: 'chat' }),
  )
})

test('the stickiness lookup only sees live conversations (after archiving, the same user starts a new conversation)', async () => {
  const h = setup()
  const created = await post(h.app, '/v1/conversations', h.token, { externalUserId: 'u9' })
  const id = (created.json() as { conversationId: string }).conversationId
  h.db.update(schema.chat).set({ removedAt: Date.now() }).where(eq(schema.chat.id, id)).run()
  assert.equal(findLiveConversation(h.db, h.key.id, 'u9'), null)

  const fresh = await post(h.app, '/v1/conversations', h.token, { externalUserId: 'u9' })
  assert.equal((fresh.json() as { created: boolean }).created, true)
})
