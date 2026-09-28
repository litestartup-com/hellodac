import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mintApiKey } from '../auth/api-key.js'
import type { AppConfig, ResolvedService } from '../config.js'
import { getChat, findLiveConversation } from '../chat/store.js'
import { schema, type Db } from '../db/index.js'
import { makeDbWithAgents } from '../test-harness.js'
import { sweepIdleConversations } from './idle-sweep.js'

/**
 * Idle reclaim of outward conversations (position CONCEPTS-ALIGNED.md §6/§8.3 -- "an idle conversation
 * is reclaimed after 24 hours by default, and the window is editable per service").
 *
 * The clock is injected, so "24 hours later" is a number here rather than a wait. Every case asserts
 * the thing a customer would notice: their conversation is gone (a new one starts) and their slot is
 * back, while a conversation that is still inside its window is untouched.
 */
const HOUR = 3_600_000

const service = (over: Partial<ResolvedService> & { id: string; workers: string[] }): ResolvedService => ({
  label: over.id,
  surfaces: ['conversations'],
  knowledge: [],
  count: over.workers.length,
  maxSessionsPerAgent: 4,
  permission: 'read',
  sessionIdleHours: 24,
  placement: 'spread',
  machines: [],
  maxAgentsPerMachine: 4,
  ...over,
})

const configWith = (services: ResolvedService[]): AppConfig => ({ services }) as unknown as AppConfig

/**
 * A real key row: `chat.api_key_id` is a foreign key to `api_key(id)`, so a made-up id does not
 * describe an outward conversation at all (the FK refuses it, which is the point of the column).
 */
const keyId = (db: Db, name: string): string =>
  mintApiKey(db, { name, scopes: ['conversations:write'], scopeServices: ['*'], createdBy: 'test' }).key.id

const conversation = (
  db: Db,
  row: { id: string; agentId?: string; lastActiveAt: number; apiKeyId: string | null; serviceId: string | null; externalUserId?: string | null },
): void => {
  db.insert(schema.chat)
    .values({
      id: row.id,
      agentId: row.agentId ?? 'svc-1',
      dshSessionId: `sess-${row.id}`,
      title: null,
      createdAt: row.lastActiveAt,
      lastActiveAt: row.lastActiveAt,
      removedAt: null,
      accessModeOverride: null,
      accessMode: null,
      apiKeyId: row.apiKeyId,
      externalUserId: row.externalUserId ?? 'customer-1',
      serviceId: row.serviceId,
    })
    .run()
}

test('idle reclaim: a conversation idle past its service window is archived and its sticky anchor is released', () => {
  const db = makeDbWithAgents([{ id: 'svc-1' }])
  const now = 1_700_000_000_000
  const key = keyId(db, 'acme')
  conversation(db, { id: 'stale', lastActiveAt: now - 25 * HOUR, apiKeyId: key, serviceId: 'chat' })

  const archived = sweepIdleConversations({ db, config: configWith([service({ id: 'chat', workers: ['svc-1'] })]), now })

  assert.equal(archived, 1)
  const row = getChat(db, 'stale')
  assert.notEqual(row?.removedAt, null, 'an idle conversation is archived (removed_at), never deleted: the ledger and the transcript stay')
  assert.equal(row?.dshSessionId, 'sess-stale', 'the session pointer survives the archive (the transcript is still readable on the host)')
  assert.equal(
    findLiveConversation(db, key, 'customer-1'),
    null,
    'the sticky anchor is released with it, so the same user gets a fresh conversation next time',
  )
})

test('idle reclaim: a conversation still inside its window is untouched (the boundary is not approximate)', () => {
  const db = makeDbWithAgents([{ id: 'svc-1' }])
  const now = 1_700_000_000_000
  conversation(db, { id: 'fresh', lastActiveAt: now - 23 * HOUR, apiKeyId: keyId(db, 'acme'), serviceId: 'chat' })

  assert.equal(sweepIdleConversations({ db, config: configWith([service({ id: 'chat', workers: ['svc-1'] })]), now }), 0)
  assert.equal(getChat(db, 'fresh')?.removedAt, null)
})

test('idle reclaim: the window comes from the conversation\'s own service (a 6h service reclaims before a 24h one)', () => {
  const db = makeDbWithAgents([{ id: 'svc-1' }, { id: 'svc-2' }])
  const now = 1_700_000_000_000
  const age = 8 * HOUR
  const key = keyId(db, 'acme')
  conversation(db, { id: 'short-window', agentId: 'svc-1', lastActiveAt: now - age, apiKeyId: key, serviceId: 'quick', externalUserId: 'a' })
  conversation(db, { id: 'long-window', agentId: 'svc-2', lastActiveAt: now - age, apiKeyId: key, serviceId: 'chat', externalUserId: 'b' })

  const archived = sweepIdleConversations({
    db,
    config: configWith([
      service({ id: 'quick', workers: ['svc-1'], sessionIdleHours: 6 }),
      service({ id: 'chat', workers: ['svc-2'], sessionIdleHours: 24 }),
    ]),
    now,
  })

  assert.equal(archived, 1)
  assert.notEqual(getChat(db, 'short-window')?.removedAt, null, 'the 6-hour service reclaimed its conversation')
  assert.equal(getChat(db, 'long-window')?.removedAt, null, 'the 24-hour service kept its own')
})

test('idle reclaim: internal chats are never reclaimed (the reclaim is an outward contract, not a housekeeping sweep)', () => {
  const db = makeDbWithAgents([{ id: 'personal' }])
  const now = 1_700_000_000_000
  // An internal chat: no key, no service. Its owner is the operator, who decides when it goes.
  conversation(db, { id: 'mine', agentId: 'personal', lastActiveAt: now - 90 * 24 * HOUR, apiKeyId: null, serviceId: null, externalUserId: null })

  assert.equal(sweepIdleConversations({ db, config: configWith([]), now }), 0)
  assert.equal(getChat(db, 'mine')?.removedAt, null)
})

test('idle reclaim: a conversation of an agent that left the config is reclaimed on the default window (it cannot be resumed anyway)', () => {
  const db = makeDbWithAgents([{ id: 'svc-1' }])
  const now = 1_700_000_000_000
  // The service or agent is gone from the config; the row still says it was an outward conversation.
  conversation(db, { id: 'orphan', lastActiveAt: now - 25 * HOUR, apiKeyId: keyId(db, 'acme'), serviceId: 'retired' })

  assert.equal(sweepIdleConversations({ db, config: configWith([]), now }), 1)
  assert.notEqual(getChat(db, 'orphan')?.removedAt, null)
})

test('idle reclaim: an already-archived conversation is not counted again (the sweep is idempotent)', () => {
  const db = makeDbWithAgents([{ id: 'svc-1' }])
  const now = 1_700_000_000_000
  conversation(db, { id: 'stale', lastActiveAt: now - 30 * HOUR, apiKeyId: keyId(db, 'acme'), serviceId: 'chat' })

  assert.equal(sweepIdleConversations({ db, config: configWith([service({ id: 'chat', workers: ['svc-1'] })]), now }), 1)
  assert.equal(sweepIdleConversations({ db, config: configWith([service({ id: 'chat', workers: ['svc-1'] })]), now }), 0)
})
