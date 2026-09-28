/**
 * Debt B2 (half of it): the chat history cache's "capped LRU + lazy TTL".
 *
 * The old implementation was a bare Map in a routes/chat.ts closure: lazy expiry on read only, no capacity cap,
 * no background sweep. The key is the chat id and the value is a whole history event array (the most expensive
 * object in the project) -- chats that are "read once and never run another turn" made it grow until a restart.
 *
 * This class:
 * - `max`: a hard capacity cap; anything beyond it evicts the oldest (Map iteration order = insertion order);
 * - `get` promotes on a hit (LRU), returns null and deletes past the TTL (lazy sweep, same semantics as before);
 * - `set` on the same key also promotes its position.
 * The AppContext dependency-injection container (one home for all global state) is still the other half of B2, unscheduled for now.
 */
export class HistoryCache<V> {
  private readonly map = new Map<string, { v: V; at: number }>()
  private readonly max: number
  private readonly ttlMs: number

  constructor(opts: { max?: number; ttlMs?: number } = {}) {
    this.max = opts.max ?? 200
    this.ttlMs = opts.ttlMs ?? 30_000
  }

  get(sessionId: string, now: number = Date.now()): V | null {
    const hit = this.map.get(sessionId)
    if (hit === undefined) return null
    if (now - hit.at > this.ttlMs) {
      this.map.delete(sessionId)
      return null
    }
    // LRU promotion: delete and re-insert = move to the end of the iteration order
    this.map.delete(sessionId)
    this.map.set(sessionId, hit)
    return hit.v
  }

  set(sessionId: string, value: V, now: number = Date.now()): void {
    this.map.delete(sessionId)
    this.map.set(sessionId, { v: value, at: now })
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.map.delete(oldest)
    }
  }

  delete(sessionId: string): void {
    this.map.delete(sessionId)
  }

  get size(): number {
    return this.map.size
  }
}
