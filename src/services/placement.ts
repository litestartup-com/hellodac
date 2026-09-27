/**
 * agent 放置（口径：内部设计库 `manager/topics/CONCEPTS-ALIGNED.md` §4.5；策略细节
 * 见 `topics/service-model.md` §5）。
 *
 * 输入 = 一张"负载快照"（每台机器的在线状态、已跑 agent 数、会话数、资源水位、是否混放
 * 内对的或别的服务的 agent），输出 = 新 agent 该落在哪几台机器上，以及**其余机器为什么
 * 没被选**。
 *
 * 三条纪律：
 * 1. **硬约束不做加权妥协**：隔离红线（同机混放对内 agent / 别的服务的 agent）与水位不足是
 *    一票否决，不因为"别的机器更忙"就放行——这类错误事后极难追。
 * 2. **纯函数**：输入不变则输出不变（平手按机器 id 排序），便于测试、界面预览与事后复算。
 * 3. **决策要能解释**：被排除的机器各带一个原因码，直接进审计与界面。
 */
export interface MachineFacts {
  id: string
  online: boolean
  /** 该机器上已在跑的 agent 数（含本服务与其它服务）。 */
  agentCount: number
  /** 该机器上 agent 所属的服务 id 列表。 */
  services: string[]
  /** 该机器上是否有对内 agent（隔离红线：同一机器的文件视野可达彼此的 workspace）。 */
  hasPrivateAgents: boolean
  /** 当前会话总数（用于轻微惩罚"已经在忙"的机器）。 */
  sessions: number
  cpuFreePercent?: number
  memFreeBytes?: number
  diskFreeBytes?: number
  /** 只读手册/工作区本就落在这台机器：同分时优先它，省网络与 IO。 */
  knowledgeAffinity?: boolean
}

export interface Thresholds {
  minFreeCpuPercent: number
  minFreeMemBytes: number
  minFreeDiskBytes: number
}

/** 用户 2026-09-27 确认的默认值。 */
export const DEFAULT_THRESHOLDS: Thresholds = {
  minFreeCpuPercent: 20,
  minFreeMemBytes: 1_500_000_000,
  minFreeDiskBytes: 5_000_000_000,
}

export const DEFAULT_MAX_AGENTS_PER_MACHINE = 4

export type RejectReason =
  | 'offline'
  | 'private_agents_present'
  | 'other_service_present'
  | 'machine_full'
  | 'insufficient_cpu'
  | 'insufficient_memory'
  | 'insufficient_disk'
  | 'not_in_pin_list'

export interface PlacementRequest {
  serviceId: string
  /** 要放几个 agent（= 服务的 `count` 声明）。 */
  count: number
  machines: MachineFacts[]
  strategy?: 'spread' | 'pack' | 'pin'
  pinMachines?: string[]
  maxAgentsPerMachine?: number
  thresholds?: Thresholds
}

export interface PlacementPlan {
  placements: Array<{ machineId: string; score: number; metricsKnown: boolean }>
  /** 放不下的 agent 数：调用方据此排队/告警，而不是静默少配。 */
  shortfall: number
  /** 每台被排除的机器一个原因（取第一个不满足的约束）。 */
  rejections: Array<{ machineId: string; reason: RejectReason }>
}

interface ResolvedOptions {
  strategy: 'spread' | 'pack' | 'pin'
  pinMachines: string[]
  maxAgentsPerMachine: number
  thresholds: Thresholds
}

const resolveOptions = (req: PlacementRequest): ResolvedOptions => ({
  strategy: req.strategy ?? 'spread',
  pinMachines: req.pinMachines ?? [],
  maxAgentsPerMachine: req.maxAgentsPerMachine ?? DEFAULT_MAX_AGENTS_PER_MACHINE,
  thresholds: req.thresholds ?? DEFAULT_THRESHOLDS,
})

const metricsKnown = (facts: MachineFacts): boolean =>
  facts.cpuFreePercent !== undefined && facts.memFreeBytes !== undefined && facts.diskFreeBytes !== undefined

/** 硬约束：返回第一个不满足的原因；全部满足返回 null。 */
export const blockingReason = (
  facts: MachineFacts,
  serviceId: string,
  opts: ResolvedOptions,
  agentsOnMachine: number,
): RejectReason | null => {
  if (!facts.online) return 'offline'
  if (facts.hasPrivateAgents) return 'private_agents_present'
  if (facts.services.some((id) => id !== serviceId)) return 'other_service_present'
  if (agentsOnMachine >= opts.maxAgentsPerMachine) return 'machine_full'
  if (opts.strategy === 'pin' && !opts.pinMachines.includes(facts.id)) return 'not_in_pin_list'
  if (facts.cpuFreePercent !== undefined && facts.cpuFreePercent < opts.thresholds.minFreeCpuPercent) return 'insufficient_cpu'
  if (facts.memFreeBytes !== undefined && facts.memFreeBytes < opts.thresholds.minFreeMemBytes) return 'insufficient_memory'
  if (facts.diskFreeBytes !== undefined && facts.diskFreeBytes < opts.thresholds.minFreeDiskBytes) return 'insufficient_disk'
  return null
}

/**
 * 打分（越高越好，整数便于测试与展示）。
 *
 * 指标缺失的机器**允许但排最后**（-1000）：单机自用场景没有 agent_metric 上报，
 * 一刀切拒绝会把最常见的部署挡在门外；但也不能让"没数据"的机器显得比"数据健康"的更好。
 */
export const scoreMachine = (facts: MachineFacts, serviceId: string, opts: ResolvedOptions, agentsOnMachine: number): number => {
  if (!metricsKnown(facts)) return -1000
  let score = facts.cpuFreePercent ?? 0
  score += Math.min(4, (facts.memFreeBytes ?? 0) / opts.thresholds.minFreeMemBytes) * 10
  score += Math.min(4, (facts.diskFreeBytes ?? 0) / opts.thresholds.minFreeDiskBytes) * 5
  score -= facts.sessions
  // spread 的核心：本机已有本服务的 agent 就大幅扣分（默认铺开，单机故障只影响一部分会话）；
  // pack 反过来：先塞满一台再上下一台。
  if (opts.strategy !== 'pack') {
    score -= facts.services.filter((id) => id === serviceId).length * 400
    score -= agentsOnMachine * 400
  }
  if (facts.knowledgeAffinity === true) score += 50
  return Math.round(score)
}

/** 逐个 agent 落位：每放一个就更新本机计数，于是 spread 会把下一个放到别处。 */
export const planPlacement = (req: PlacementRequest): PlacementPlan => {
  const opts = resolveOptions(req)
  const agentsOnMachine = new Map<string, number>(req.machines.map((m) => [m.id, m.agentCount]))
  const placements: PlacementPlan['placements'] = []
  const rejections: PlacementPlan['rejections'] = []
  let reported = false

  for (let index = 0; index < Math.max(0, req.count); index += 1) {
    const candidates: Array<{ machineId: string; score: number; metricsKnown: boolean }> = []
    for (const facts of req.machines) {
      const used = agentsOnMachine.get(facts.id) ?? facts.agentCount
      const blocked = blockingReason(facts, req.serviceId, opts, used)
      if (blocked !== null) {
        // 只在第一轮记录拒绝原因：后续轮次的拒绝多为"刚被填满"，重复记录会淹没真正的原因。
        if (!reported) rejections.push({ machineId: facts.id, reason: blocked })
        continue
      }
      candidates.push({ machineId: facts.id, score: scoreMachine(facts, req.serviceId, opts, used), metricsKnown: metricsKnown(facts) })
    }
    reported = true
    if (candidates.length === 0) break
    // 平手按 id 升序：纯函数必须给出确定结果，否则测试与事后复算都无从谈起。
    candidates.sort((a, b) => (b.score === a.score ? a.machineId.localeCompare(b.machineId) : b.score - a.score))
    const chosen = candidates[0]
    if (chosen === undefined) break
    placements.push(chosen)
    agentsOnMachine.set(chosen.machineId, (agentsOnMachine.get(chosen.machineId) ?? 0) + 1)
  }

  return { placements, shortfall: Math.max(0, req.count - placements.length), rejections }
}
