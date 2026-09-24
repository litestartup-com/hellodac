/**
 * 蜂群 P5.4 + 债务 H3:每工作区一把 git 提交锁。
 *
 * run 快照提交与 fleet.md 同步提交都落同一个工作区,两个 git 进程同时
 * add/commit 会在 index.lock 上互相踩踏。落盘是排队点,其余全程并行——
 * 锁按 agent id 计,同一把锁的 fn 串行,fn 内的 git 子进程生命周期完整覆盖。
 */
const commitTails = new Map<string, Promise<void>>()

export const withCommitLock = async <T>(agentId: string, fn: () => Promise<T>): Promise<T> => {
  const prev = commitTails.get(agentId) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  commitTails.set(agentId, gate)
  await prev
  try {
    return await fn()
  } finally {
    release()
    if (commitTails.get(agentId) === gate) commitTails.delete(agentId)
  }
}
