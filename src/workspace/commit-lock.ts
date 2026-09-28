/**
 * Hive P5.4 + Debt H3: one git commit lock per workspace.
 *
 * Run snapshot commits and fleet.md sync commits both land in the same workspace, so two git processes running
 * add/commit at once trample each other on index.lock. The disk write is the queueing point; everything else runs in
 * parallel throughout -- the lock is keyed by agent id, fns on the same lock are serialized, and the git child process
 * inside an fn is covered for its whole lifetime.
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
