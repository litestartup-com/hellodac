/**
 * 债务 B2(半项):会话历史缓存的「容量上限 LRU + 惰性 TTL」。
 *
 * 旧实现是 routes/chat.ts 闭包里的裸 Map:只在读取时惰性过期、无容量上限、
 * 无后台清扫。键是会话 id、值是整段历史事件数组(全项目最贵的对象)——
 * 大量「读过一次、不再跑回合」的会话会让它单调增长,直到进程重启。
 *
 * 本类:
 * - `max`:容量封顶,超出驱逐最旧(Map 迭代序 = 插入序);
 * - `get` 命中即 LRU 提升,超 TTL 返回 null 并删除(惰性清扫,与旧语义一致);
 * - `set` 同键重设也提升序位。
 * AppContext 依赖注入容器(全局状态整体收口)仍是 B2 的另半项,留待排期。
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
    // LRU 提升:删除后重插 = 移到迭代序末尾
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
