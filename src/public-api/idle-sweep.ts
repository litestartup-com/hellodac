/**
 * Idle reclaim of outward conversations (contract: internal design library
 * `manager/topics/CONCEPTS-ALIGNED.md` §6 and §8.3).
 *
 * A conversation is an agent's capacity unit: while it sits in the live list it holds one of that
 * agent's concurrent slots, and the sticky anchor (key + external user) keeps pointing at it. Left
 * alone, a customer who asked one question and never came back would hold a slot forever -- the
 * outward promise "N agents x M concurrent" would decay into "however many people ever wrote in".
 *
 * So: an outward conversation whose `lastActiveAt` is older than **its own service's**
 * `session_idle_hours` (default 24) is archived -- the same soft archive a manual removal does, with
 * `dsh_session_id` kept so the transcript stays readable -- which frees the slot and releases the
 * anchor. The next call from that user is simply a new conversation (§4.2 step 7: history stays
 * queryable, the conversation is not resurrected).
 *
 * Three deliberate limits:
 * - **outward only**: a conversation with no service attribution is an internal chat, and reclaiming
 *   an operator's own chat behind their back would be losing their work, not enforcing a contract;
 * - the window is read from the config on every sweep, so editing `session_idle_hours` takes effect
 *   without a migration (a conversation of a service that has since left the config falls back to the
 *   default -- it cannot be resumed anyway);
 * - nothing is deleted: the run rows are the cost ledger and money spent does not become unspent
 *   because a thread was tidied away (`chat/store.ts` makes the same point about `removeChat`).
 *
 * Pure database work, no scheduler of its own: the periodic reconcile calls it (see
 * `reconcile/index.ts`), which is the one place that already runs periodically.
 */
import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import type { AppConfig } from '../config.js'
import { schema, type Db } from '../db/index.js'

/** The window a conversation gets when its service is no longer in the config (matches the schema default). */
export const DEFAULT_SESSION_IDLE_HOURS = 24

const HOUR_MS = 3_600_000

export interface IdleSweepOptions {
  db: Db
  config: AppConfig
  /** Injected so tests can move the clock instead of waiting a day. */
  now?: number
}

/**
 * Archive every outward conversation idle past its window. Returns how many were archived
 * (0 is the normal answer).
 */
export const sweepIdleConversations = (options: IdleSweepOptions): number => {
  const now = options.now ?? Date.now()
  const windowOf = new Map<string, number>()
  for (const service of options.config.services ?? []) {
    windowOf.set(service.id, (service.sessionIdleHours ?? DEFAULT_SESSION_IDLE_HOURS) * HOUR_MS)
  }

  const live = options.db
    .select({ id: schema.chat.id, lastActiveAt: schema.chat.lastActiveAt, serviceId: schema.chat.serviceId })
    .from(schema.chat)
    .where(and(isNull(schema.chat.removedAt), isNotNull(schema.chat.serviceId)))
    .all()

  let archived = 0
  for (const row of live) {
    const window = windowOf.get(row.serviceId ?? '') ?? DEFAULT_SESSION_IDLE_HOURS * HOUR_MS
    if (now - row.lastActiveAt < window) continue
    options.db.update(schema.chat).set({ removedAt: now }).where(eq(schema.chat.id, row.id)).run()
    archived += 1
  }
  return archived
}
