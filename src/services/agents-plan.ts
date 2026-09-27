/**
 * 服务 agent 对账（口径：内部设计库 `manager/topics/CONCEPTS-ALIGNED.md` §8.2）。
 *
 * 服务声明是真相源（`services[].count` = 期望 agent 数），实际在跑的 agent 是派生品。
 * 本模块算的是两者的差：**要起几个、要撤几个、撤不掉的为什么撤不掉**。
 * 放置（放哪台机器）交给 `placement.ts`，本模块只管"数量对账 + 落位后编号"。
 *
 * 四条纪律：
 * 1. **稳定优先**：已有 agent 只要还在允许范围内就原样保留（不重排、不搬机器）——
 *    换机器 = 客户会话失忆，代价远大于"让某台机器看起来更均衡"。
 * 2. **缩容要排水**：还有会话在跑的 agent 不立刻撤，标记为 draining 等它空下来。
 * 3. **少配必须可见**：放不下就如实回报 shortfall + 每台机器的拒绝原因，绝不静默少起。
 * 4. **不自动迁移**：已有 agent 落在离线/不被允许的机器上 → 只回报 stranded 供界面告警，
 *    迁移属于自愈（P3.5），且必须走"会话重开"的完整流程。
 */
import { planPlacement, type MachineFacts, type RejectReason, type Thresholds } from './placement.js'

/** 服务的一个 agent = 一个独立 DSH 进程（口径 §1）。名字由服务 id 与序号派生，可预测、可复算。 */
export interface PlannedAgent {
  serviceId: string
  ordinal: number
  /** 派生端点 id（= 该 agent 独占的 DSH 进程）。 */
  endpointId: string
  /** 派生 agent id（对外挡位；会话粘在它上面）。 */
  agentId: string
  machineId: string
}

/** 已在跑的 agent（由派生端点/agent 反推）。 */
export interface ExistingAgent {
  ordinal: number
  machineId: string
}

export interface AgentsPlanRequest {
  serviceId: string
  /** 期望 agent 数（`services[].count`）。 */
  count: number
  placement: 'spread' | 'pack' | 'pin'
  /** pin 策略下的机器白名单。 */
  machines?: string[]
  maxAgentsPerMachine?: number
  existing: ExistingAgent[]
  /** 负载快照（含已在跑的 agent，扩容时在其之上继续落位）。 */
  facts: MachineFacts[]
  /** 每个 agent 当前的会话数（agentId → 数量）：缩容时据此判断能不能立刻撤。 */
  sessionsByAgent?: Record<string, number>
  thresholds?: Thresholds
}

export type StrandedReason = RejectReason | 'machine_unknown'

export interface AgentsPlan {
  /** 对账后应有的 agent 表（保留 + 新建），按序号升序。 */
  agents: PlannedAgent[]
  keep: PlannedAgent[]
  create: PlannedAgent[]
  /** 可以立刻撤的 agent（空闲）。 */
  remove: PlannedAgent[]
  /** 想撤但还有会话在跑：等它空下来（排水），不硬断。 */
  draining: PlannedAgent[]
  /** 想加却没地方放的数量。 */
  shortfall: number
  /** 已存在但落位不再合规的 agent：只告警，不自动迁移。 */
  stranded: Array<{ agent: PlannedAgent; reason: StrandedReason }>
  /** 每台被排除的机器一个原因（来自放置器）。 */
  rejections: Array<{ machineId: string; reason: RejectReason }>
}

export const agentNames = (serviceId: string, ordinal: number): { endpointId: string; agentId: string } => ({
  endpointId: `svc-${serviceId}-${ordinal}`,
  agentId: `${serviceId}-${ordinal}`,
})

/**
 * 反解派生端点 id（运行时对账要认出"这个端点是哪个服务的第几号 agent"）。
 * 解析规则只有这一处，避免正则散落各处后各解各的（服务 id 本身允许短横线，
 * 所以序号取最后一段：`svc-a-b-2` = 服务 `a-b` 的 2 号 agent）。
 */
export const parseAgentEndpoint = (endpointId: string): { serviceId: string; ordinal: number } | null => {
  const matched = /^svc-(.+)-([1-9]\d*)$/.exec(endpointId)
  const serviceId = matched?.[1]
  const ordinal = matched?.[2]
  if (serviceId === undefined || ordinal === undefined) return null
  return { serviceId, ordinal: Number(ordinal) }
}

const makeAgent = (serviceId: string, ordinal: number, machineId: string): PlannedAgent => ({
  serviceId,
  ordinal,
  ...agentNames(serviceId, ordinal),
  machineId,
})

/** 期望 agent 的序号：1..count（与声明数量对齐，缩容时先撤编号最大的）。 */
const wantedOrdinals = (count: number): number[] => Array.from({ length: Math.max(0, count) }, (_, i) => i + 1)

export const planAgents = (req: AgentsPlanRequest): AgentsPlan => {
  const wanted = wantedOrdinals(req.count)
  const existing = [...req.existing].sort((a, b) => a.ordinal - b.ordinal)
  const factsById = new Map(req.facts.map((m) => [m.id, m]))
  const sessions = req.sessionsByAgent ?? {}

  // 保留 = 期望序号内的已有 agent（按序号对应，低序号先保）。
  const keep: PlannedAgent[] = []
  const surplus: PlannedAgent[] = []
  for (const [index, agent] of existing.entries()) {
    const target = wanted[index]
    if (target === undefined) surplus.push(makeAgent(req.serviceId, agent.ordinal, agent.machineId))
    else keep.push(makeAgent(req.serviceId, agent.ordinal, agent.machineId))
  }

  // 缩容：先撤编号大的；还有会话在跑的转排水，不硬断。
  const remove: PlannedAgent[] = []
  const draining: PlannedAgent[] = []
  for (const agent of surplus.reverse()) {
    if ((sessions[agent.agentId] ?? 0) > 0) draining.push(agent)
    else remove.push(agent)
  }

  // 扩容：只补差额，序号取最小空闲号（缩容又扩容时不会乱跳）。
  // 差额必须按"保留了几个"算，不能按"空闲号有几个"算：已有 agent 的序号是它的身份，
  // 不能重排（重排 = 客户会话失忆），所以序号集合与数量必须分开数
  // —— 例：已有 2、3 号而期望 1 个 agent 时，若只看空闲号会误判成"缺 1 号"再多起一个。
  const usedOrdinals = new Set(keep.map((a) => a.ordinal))
  const slots = Math.max(0, wanted.length - keep.length)
  const freeOrdinals = wanted.filter((ordinal) => !usedOrdinals.has(ordinal)).slice(0, slots)
  const created: PlannedAgent[] = []
  let shortfall = 0
  let rejections: AgentsPlan['rejections'] = []
  if (freeOrdinals.length > 0) {
    const plan = planPlacement({
      serviceId: req.serviceId,
      count: freeOrdinals.length,
      machines: req.facts,
      strategy: req.placement,
      pinMachines: req.machines ?? [],
      ...(req.maxAgentsPerMachine === undefined ? {} : { maxAgentsPerMachine: req.maxAgentsPerMachine }),
      ...(req.thresholds === undefined ? {} : { thresholds: req.thresholds }),
    })
    rejections = plan.rejections
    shortfall = plan.shortfall
    plan.placements.forEach((placement, index) => {
      const ordinal = freeOrdinals[index]
      if (ordinal === undefined) return
      created.push(makeAgent(req.serviceId, ordinal, placement.machineId))
    })
  }

  // 落单告警：已有 agent 的机器没了、离线了、或被隔离红线挡住 —— 只报告，不搬。
  const stranded: AgentsPlan['stranded'] = []
  for (const agent of keep) {
    const facts = factsById.get(agent.machineId)
    if (facts === undefined) {
      stranded.push({ agent, reason: 'machine_unknown' })
      continue
    }
    if (!facts.online) stranded.push({ agent, reason: 'offline' })
    else if (facts.hasPrivateAgents) stranded.push({ agent, reason: 'private_agents_present' })
    else if (facts.services.some((id) => id !== req.serviceId)) stranded.push({ agent, reason: 'other_service_present' })
    else if (req.placement === 'pin' && !(req.machines ?? []).includes(agent.machineId)) {
      stranded.push({ agent, reason: 'not_in_pin_list' })
    }
  }

  return {
    agents: [...keep, ...created].sort((a, b) => a.ordinal - b.ordinal),
    keep,
    create: created,
    remove,
    draining,
    shortfall,
    stranded,
    rejections,
  }
}
