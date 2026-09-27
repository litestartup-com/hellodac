/**
 * 分发（口径：内部设计库 `manager/topics/CONCEPTS-ALIGNED.md`；策略细节见 `topics/service-model.md` §6）。
 *
 * 新会话进来时挑一个 agent，之后**粘住不变**（换了 agent = 客户失忆，所以这里只负责"第一次选谁"）。
 *
 * 排序口径（依次比较，全部是"越少越好"）：
 *   1. 当前会话数（未达 `maxSessionsPerAgent` 才算候选）
 *   2. 本 agent 队列长度
 *   3. 最近一轮耗时（**未知排最后**：宁可给有实测数据的 agent，也不赌一个没数据的）
 *   4. 同一把钥匙在本 agent 上的会话数（同一调用方尽量分散，避免一个大客户占满一个 agent）
 *   5. 平手 → 按轮询种子取模，保证公平且**结果确定**（同输入同种子必得同结果）
 *
 * 纯函数：不读库、不看时钟。调用方把负载快照与种子传进来，因此可分发的每一步都能复算、
 * 能单测、能在界面上"预演"。
 */
export interface WorkerFacts {
  agentId: string
  online: boolean
  /** 该 agent 当前接了几个会话。 */
  sessions: number
  /** 该 agent 本会话队列的长度（同一会话内排队的回合数）。 */
  queueDepth: number
  /** 最近一轮耗时（毫秒）；未知 = undefined。 */
  lastTurnMs?: number
}

export interface DispatchRequest {
  workers: WorkerFacts[]
  /** 每个 agent 能同时接待的会话数（服务的 capacity.max_sessions_per_agent）。 */
  maxSessionsPerAgent: number
  /** 同一把钥匙（调用方）已在各 agent 上的会话数：agentId → 数量。 */
  keySessionsByAgent?: Record<string, number>
  /** 轮询种子（通常是"本次分发序号"），让平手时轮流坐庄而不是永远选同一个。 */
  rotationSeed?: number
}

export type DispatchResult =
  | { ok: true; agentId: string; sessions: number; full: string[] }
  | { ok: false; reason: 'no_worker_online' | 'all_full'; capacity: number; inUse: number }

/**
 * 耗时升序比较；未知（undefined）恒排在有实测数据之后，**两者都未知时返回 0**。
 * 注意别"简化"成 `(a ?? Infinity) - (b ?? Infinity)`：Infinity - Infinity = NaN，
 * 而 NaN !== 0，会让后面所有平手判据（同钥匙分散、轮询种子）被整个吞掉 —— 症状是
 * "轮询永远选同一台"，且排序结果变成 undefined 行为（曾实测踩中，见 dispatch.test.ts）。
 */
const compareLatency = (a: number | undefined, b: number | undefined): number => {
  const left = a ?? Number.MAX_SAFE_INTEGER
  const right = b ?? Number.MAX_SAFE_INTEGER
  return left === right ? 0 : left - right
}

/** 候选 = 在线且未满；返回候选与被容量/在线状态排除的 agent（后者用于界面解释"为什么没人接"）。 */
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
  // 稳定排序：平手时按「种子每加一，胜者顺延一位」轮转 —— 同种子同输入结果唯一，
  // 且种子递增时依次轮到 a、b、c……，而不是看似随机的跳跃（运维看日志时好核对）。
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
