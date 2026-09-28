/**
 * Per-chat send queue (revised for Hive P5.4).
 *
 * Concurrency semantics: **serial within a chat, parallel across chats**. One gateway chat can run
 * only one turn at a time, so a new message for a chat queues until that chat's previous turn ends
 * (FIFO, consistent across pages); different chats never block each other -- the concurrency P5.4 wants.
 *
 * In-memory only — a manager restart drops queued turns, which is no worse
 * than today's refusal (the sender re-sends).
 */

export interface QueuedTurn {
  id: string
  chatId: string
  execute: () => Promise<void>
}

const queues = new Map<string, QueuedTurn[]>()
const draining = new Set<string>()

/** How many turns are queued for one chat. */
export const queuedTurnsFor = (chatId: string): number => queues.get(chatId)?.length ?? 0

/**
 * Add one turn to the chat's queue. Returns its 1-based position.
 */
export const enqueueTurn = (chatId: string, turn: QueuedTurn): number => {
  const q = queues.get(chatId) ?? []
  q.push(turn)
  queues.set(chatId, q)
  return q.length
}

/**
 * Start the next queued turn for a chat, if any. Safe to call at any time:
 * a concurrent drain is a no-op, and when the queue is empty nothing happens.
 * The queued turn's own `execute` awaits the round-trip, so the chain only
 * advances when the previous turn truly finished.
 */
export const drainChatQueue = (chatId: string): void => {
  if (draining.has(chatId)) return
  const q = queues.get(chatId)
  if (q === undefined || q.length === 0) {
    queues.delete(chatId)
    return
  }
  const next = q.shift()
  if (next === undefined) {
    // Debt E10: check for empty explicitly (length>0 was checked above, but TS cannot narrow shift's result)
    queues.delete(chatId)
    return
  }
  draining.add(chatId)
  // The catch is load-bearing: a rejecting execute would otherwise surface as
  // an unhandledRejection and, on some runtimes, take the process down. The
  // turn's own error reporting is the execute closure's job.
  void next.execute().catch(() => undefined).finally(() => {
    draining.delete(chatId)
    drainChatQueue(chatId)
  })
}

/**
 * Drop one queued turn by id (edit/undo or delete from the dock).
 * Idempotent: an id that already ran — or never existed — is a no-op, so the
 * caller can apply the UI removal optimistically.
 */
export const cancelQueuedTurn = (chatId: string, turnId: string): void => {
  const q = queues.get(chatId)
  if (q === undefined) return
  const kept = q.filter((turn) => turn.id !== turnId)
  if (kept.length === 0) queues.delete(chatId)
  else queues.set(chatId, kept)
}

/** Drop every queued turn of one chat (archive / delete). */
export const cancelQueuedTurns = (chatId: string): void => {
  queues.delete(chatId)
}

/** Clear all queues (shutdown / tests). */
export const closeQueues = (): void => {
  queues.clear()
  draining.clear()
}
