/**
 * Dispatch (contract: internal design library `manager/topics/CONCEPTS-ALIGNED.md`; strategy
 *
 * Pick one agent when a new conversation arrives, then **stick to it** (moving a customer to
 *
 * Ordering compares, always "less is better":
 *   1. current sessions (only below `maxSessionsPerAgent` counts as a candidate)
 *   2. queue depth on this agent
 *   3. duration of the most recent turn (**unknown ranks last**: prefer an agent with real
 *      measurements over betting on one without)
 *   4. sessions of the same key on this agent (spread one caller out so a single big customer
 *      cannot fill one agent)
 *   5. exact tie -> rotate by seed, which is fair and **deterministic** (same input and seed
 *      always give the same result)
 *
 * Pure: no database, no clock. The caller passes the load snapshot and the seed, so every
 * dispatch decision can be recomputed, unit-tested, and previewed in the UI.
 */
export interface WorkerFacts {
  agentId: string
  online: boolean
  /** Conversations this agent is serving right now. */
  sessions: number
  /** Turns queued inside this agent's conversations (turns are serial per conversation). */
  queueDepth: number
  /** Duration of the most recent turn in ms; undefined when never measured. */
  lastTurnMs?: number
}

export interface DispatchRequest {
  workers: WorkerFacts[]
  /** Conversations one agent can serve at once (the service's capacity.max_sessions_per_agent). */
  maxSessionsPerAgent: number
  /** Conversations this key (caller) already holds per agent: agentId -> count. */
  keySessionsByAgent?: Record<string, number>
  /** Rotation seed (usually the dispatch sequence number) so ties take turns instead of
   * always picking the same agent. */
  rotationSeed?: number
}

export type DispatchResult =
  | { ok: true; agentId: string; sessions: number; full: string[] }
  | { ok: false; reason: 'no_worker_online' | 'all_full'; capacity: number; inUse: number }

/**
 * Compare latencies ascending; unknown (undefined) always ranks after a measured value, and
 * **two unknowns compare equal (0)**. Do not "simplify" this to
 * `(a ?? Infinity) - (b ?? Infinity)`: Infinity - Infinity is NaN, NaN !== 0, and an early
 * return would swallow every tie-break below (same-key spread, rotation seed) -- the symptom is
 */
const compareLatency = (a: number | undefined, b: number | undefined): number => {
  const left = a ?? Number.MAX_SAFE_INTEGER
  const right = b ?? Number.MAX_SAFE_INTEGER
  return left === right ? 0 : left - right
}

/** Candidates = online and below capacity; also reports who was excluded by capacity or
 * liveness, which is what the UI needs to explain "why is nobody taking it". */
export const dispatchCandidates = (
  req: DispatchRequest,
): { candidates: WorkerFacts[]; offline: string[]; full: string[] } => {
  const offline: string[] = []
  const full: string[] = []
  const candidates: WorkerFacts[] = []
  for (const worker of req.workers) {
    if (!worker.online) {
      offline.push(worker.agentId)
      continue
    }
    if (worker.sessions >= req.maxSessionsPerAgent) {
      full.push(worker.agentId)
      continue
    }
    candidates.push(worker)
  }
  return { candidates, offline, full }
}

export const pickWorker = (req: DispatchRequest): DispatchResult => {
  const { candidates, offline, full } = dispatchCandidates(req)
  const capacity = req.workers.length * req.maxSessionsPerAgent
  const inUse = req.workers.reduce((sum, w) => sum + w.sessions, 0)

  if (candidates.length === 0) {
    return {
      ok: false,
      reason: req.workers.length > 0 && offline.length === req.workers.length ? 'no_worker_online' : 'all_full',
      capacity,
      inUse,
    }
  }

  const keySessions = req.keySessionsByAgent ?? {}
  const offset = (req.rotationSeed ?? 0) % candidates.length
  // Stable sort: on a tie, "each seed step shifts the winner by one" -- same seed and input give
  // one answer, and increasing the seed walks a, b, c in order rather than jumping around
  // (which makes checking logs by hand possible).
  const ordered = candidates
    .map((worker, index) => ({ worker, rotated: (index - offset + candidates.length) % candidates.length }))
    .sort((a, b) => {
      const bySessions = a.worker.sessions - b.worker.sessions
      if (bySessions !== 0) return bySessions
      const byQueue = a.worker.queueDepth - b.worker.queueDepth
      if (byQueue !== 0) return byQueue
      const byLatency = compareLatency(a.worker.lastTurnMs, b.worker.lastTurnMs)
      if (byLatency !== 0) return byLatency
      const byKey = (keySessions[a.worker.agentId] ?? 0) - (keySessions[b.worker.agentId] ?? 0)
      if (byKey !== 0) return byKey
      return a.rotated - b.rotated
    })

  const chosen = ordered[0]?.worker
  if (chosen === undefined) return { ok: false, reason: 'all_full', capacity, inUse }
  return { ok: true, agentId: chosen.agentId, sessions: chosen.sessions, full }
}
