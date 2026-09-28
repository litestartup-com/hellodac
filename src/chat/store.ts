import { randomUUID } from 'node:crypto'
import { and, count, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import type { Db } from '../db/index.js'
import { schema } from '../db/index.js'

/**
 * Chat threads: manager's side of a multi-turn conversation.
 *
 * A chat owns exactly one gateway session and many turns. The turns themselves
 * stay in `run`, so the cost ledger, cron jobs and the outward task API are
 * untouched by any of this -- a chat is only the thread that groups them.
 *
 * Nothing here talks to the gateway. The transcript is *not* stored: the gateway
 * already persists it and will replay it on request, and a second copy would
 * only be a copy that can disagree with the first.
 */

export const TITLE_LIMIT = 60

/**
 * A readable title from the first thing the user said.
 *
 * Used only when the gateway has no title of its own for the session, and never
 * paraphrased -- it is a prefix of the user's own words, so it cannot claim
 * something they did not say.
 */
export const deriveTitle = (text: string): string => {
  const line = text.replace(/\s+/gu, ' ').trim()
  if (line === '') return '新会话'
  // Intl.Segmenter counts a grapheme, so a CJK title is cut at 60 characters
  // rather than 60 UTF-16 code units, and an emoji is never split in half.
  const segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' })
  const graphemes = [...segmenter.segment(line)].map((s) => s.segment)
  if (graphemes.length <= TITLE_LIMIT) return line
  return `${graphemes.slice(0, TITLE_LIMIT).join('')}…`
}

export interface ChatRow {
  id: string
  agentId: string
  dshSessionId: string | null
  title: string | null
  createdAt: number
  lastActiveAt: number
  removedAt: number | null
  /** Outward ownership: all three columns null = an internal chat (§6 of CONCEPTS-ALIGNED.md). */
  apiKeyId: string | null
  externalUserId: string | null
  serviceId: string | null
}

/** Outward chat ownership (all three absent on an internal chat = null). A null `externalUserId` = the caller keeps the chat id itself. */
export interface ChatOwner {
  apiKeyId: string
  externalUserId: string | null
  serviceId: string
}

export const createChat = (db: Db, agentId: string, now = Date.now(), owner?: ChatOwner): ChatRow => {
  const row: ChatRow = {
    id: randomUUID(),
    agentId,
    // Null until the first turn: creating a gateway session for a chat the user
    // may never type into would burn a slot against the gateway's maxSessions.
    dshSessionId: null,
    title: null,
    createdAt: now,
    lastActiveAt: now,
    removedAt: null,
    apiKeyId: owner?.apiKeyId ?? null,
    externalUserId: owner?.externalUserId ?? null,
    serviceId: owner?.serviceId ?? null,
  }
  db.insert(schema.chat).values(row).run()
  return row
}

/**
 * Sticky lookup: the **live** chat of this external user under this key.
 *
 * The partial unique index `chat_api_key_user_live` guarantees at most one row, so no sorting for
 * the newest is needed -- two rows mean the index was bypassed (a manual DB edit), which must throw
 * rather than pick one at random and wipe the customer's memory.
 */
export const findLiveConversation = (db: Db, apiKeyId: string, externalUserId: string): ChatRow | null => {
  const rows = db
    .select()
    .from(schema.chat)
    .where(
      and(
        eq(schema.chat.apiKeyId, apiKeyId),
        eq(schema.chat.externalUserId, externalUserId),
        isNull(schema.chat.removedAt),
      ),
    )
    .all()
  return rows[0] ?? null
}

export const getChat = (db: Db, id: string): ChatRow | null =>
  (db.select().from(schema.chat).where(eq(schema.chat.id, id)).all()[0]) ?? null

export interface ChatListItem extends ChatRow {
  /** Number of turns recorded against this chat. */
  turns: number
}

/**
 * An agent's chats, most recently active first.
 *
 * Removed chats are excluded rather than deleted; see `removeChat`.
 *
 * Debt E16: why turn counting uses a two-level grouped query instead of a correlated subquery (a
 * post-mortem of the clever version silently counting 0) is in docs/adr/0003-chat-turn-count-query.md.
 */
export const listChats = (db: Db, agentId: string, limit = 100): ChatListItem[] => {
  const rows = db
    .select()
    .from(schema.chat)
    .where(and(eq(schema.chat.agentId, agentId), isNull(schema.chat.removedAt)))
    .orderBy(desc(schema.chat.lastActiveAt))
    .limit(limit)
    .all() as ChatRow[]

  if (rows.length === 0) return []

  const counts = db
    .select({ chatId: schema.run.chatId, turns: count() })
    .from(schema.run)
    .where(
      inArray(
        schema.run.chatId,
        rows.map((r) => r.id),
      ),
    )
    .groupBy(schema.run.chatId)
    .all()
  const byChat = new Map(counts.map((c) => [c.chatId, c.turns]))

  return rows.map((row) => ({ ...row, turns: byChat.get(row.id) ?? 0 }))
}

/** Records the gateway session a chat became bound to on its first turn. */
export const bindSession = (db: Db, chatId: string, sessionId: string, now = Date.now()): void => {
  db.update(schema.chat)
    .set({ dshSessionId: sessionId, lastActiveAt: now })
    .where(eq(schema.chat.id, chatId))
    .run()
}

export const touchChat = (db: Db, chatId: string, now = Date.now()): void => {
  db.update(schema.chat).set({ lastActiveAt: now }).where(eq(schema.chat.id, chatId)).run()
}

/** Sets the title once. Later turns must not silently rewrite it. */
export const setTitleIfEmpty = (db: Db, chatId: string, title: string): void => {
  db.update(schema.chat)
    .set({ title })
    .where(and(eq(schema.chat.id, chatId), isNull(schema.chat.title)))
    .run()
}

export const renameChat = (db: Db, chatId: string, title: string): void => {
  db.update(schema.chat).set({ title }).where(eq(schema.chat.id, chatId)).run()
}

/**
 * Hides a chat from manager.
 *
 * Deliberately not a DELETE, and `dshSessionId` is deliberately left on the row.
 * The gateway's own `DELETE /sessions/:id` -- which routes/chat.ts calls when a
 * chat is removed -- frees the session's slot but keeps the transcript, so the
 * conversation stays readable through this id and could be adopted again.
 * Clearing the id here would throw that away and tell the user something untrue
 * about their own data.
 *
 * The run rows are kept too: they are the cost ledger, and money spent does not
 * become unspent because a thread was tidied away.
 */
export const removeChat = (db: Db, chatId: string, now = Date.now()): void => {
  db.update(schema.chat).set({ removedAt: now }).where(eq(schema.chat.id, chatId)).run()
}

/**
 * Hive plan 2 P6: orphan chat archiving -- an unarchived chat whose agent is gone from the config
 * 409s `agent_gone` on every API (chat.ts resolve) and can never send a message in the UI. Boot
 * reconcile soft-archives them (removed_at), as a manual archive would, losing no data; returns the count.
 */
export const archiveOrphanChats = (db: Db, knownAgentIds: Set<string>, now = Date.now()): number => {
  const rows = db
    .select({ id: schema.chat.id, agentId: schema.chat.agentId })
    .from(schema.chat)
    .where(isNull(schema.chat.removedAt))
    .all()
  let archived = 0
  for (const row of rows) {
    if (knownAgentIds.has(row.agentId)) continue
    db.update(schema.chat).set({ removedAt: now }).where(eq(schema.chat.id, row.id)).run()
    archived += 1
  }
  return archived
}

export interface ArchivedChat extends ChatRow {
  turns: number
}

/**
 * Archived chats across every agent, most recently archived first.
 *
 * Ordered by `removedAt` rather than `lastActiveAt`: on this list the question
 * is "what did I just tidy away", and the thing you want back is almost always
 * the one you archived last.
 */
export const listArchivedChats = (db: Db, limit = 200): ArchivedChat[] => {
  const rows = db
    .select()
    .from(schema.chat)
    .where(isNotNull(schema.chat.removedAt))
    .orderBy(desc(schema.chat.removedAt))
    .limit(limit)
    .all() as ChatRow[]

  if (rows.length === 0) return []

  // Same grouped-query shape as listChats, and for the same reason: a column
  // interpolated into a correlated subquery resolves against the inner table.
  const counts = db
    .select({ chatId: schema.run.chatId, turns: count() })
    .from(schema.run)
    .where(
      inArray(
        schema.run.chatId,
        rows.map((r) => r.id),
      ),
    )
    .groupBy(schema.run.chatId)
    .all()
  const byChat = new Map(counts.map((c) => [c.chatId, c.turns]))

  return rows.map((row) => ({ ...row, turns: byChat.get(row.id) ?? 0 }))
}

/**
 * Brings an archived chat back into the list.
 *
 * Only clears the flag. The gateway session was released when the chat was
 * archived, so a restored chat may come back `cold` or `lost` -- which
 * `GET /api/chats/:id` already reports, and which is the truth rather than
 * something to paper over here.
 */
export const restoreChat = (db: Db, chatId: string): void => {
  db.update(schema.chat).set({ removedAt: null }).where(eq(schema.chat.id, chatId)).run()
}

/** The turns of a chat, oldest first, with their usage rows attached. */
export const chatRuns = (db: Db, chatId: string) => {
  const runs = db
    .select()
    .from(schema.run)
    .where(eq(schema.run.chatId, chatId))
    .orderBy(schema.run.startedAt)
    .all()
  if (runs.length === 0) return []
  // Scoped to this chat's runs. Reading the whole usage table and filtering in
  // JS would scan the entire cost ledger every time a conversation is opened.
  const usage = db
    .select()
    .from(schema.usageRecord)
    .where(
      inArray(
        schema.usageRecord.runId,
        runs.map((r) => r.id),
      ),
    )
    .all()
  const byRun = new Map(usage.map((u) => [u.runId, u]))
  return runs.map((r) => ({ ...r, usage: byRun.get(r.id) ?? null }))
}
