/**
 * 坐席对账（设计稿：内部设计库 `manager/topics/service-model.md` §1/§2 第 1 步）。
 *
 * 服务声明是真相源（`services[].agents` = 期望坐席数），实际在跑的坐席是派生品。
 * 本模块算的是两者的差：**要起几个、要撤几个、撤不掉的为什么撤不掉**。
 * 放置（放哪台机器）交给 `placement.ts`，本模块只管"数量对账 + 落位后编号"。
 *
 * 四条纪律：
 * 1. **稳定优先**：已有坐席只要还在允许范围内就原样保留（不重排、不搬机器）——
 *    换机器 = 客户会话失忆，代价远大于"让某台机器看起来更均衡"。
 * 2. **缩容要排水**：还有会话在跑的坐席不立刻撤，标记为 draining 等它空下来。
 * 3. **少配必须可见**：放不下就如实回报 shortfall + 每台机器的拒绝原因，绝不静默少起。
 * 4. **不自动迁移**：已有坐席落在离线/不被允许的机器上 → 只回报 stranded 供界面告警，
 *    迁移属于自愈（P3.5），且必须走"会话重开"的完整流程。
 */
import { planPlacement, type MachineFacts, type RejectReason, type Thresholds } from './placement.js'

/** 一个坐席 = 一个独立进程 + 一个对外 agent。名字由服务 id 与序号派生，可预测、可复算。 */
export interface Seat {
  serviceId: string
  ordinal: number
  /** 派生端点 id（= 坐席进程）。 */
  endpointId: string
  /** 派生 agent id（对外挡位；会话粘在它上面）。 */
  agentId: string
  machineId: string
}

/** 已在跑的坐席（由派生端点/agent 反推）。 */
export interface ExistingSeat {
  ordinal: number
  machineId: string
}

export interface SeatsRequest {
  serviceId: string
  /** 期望坐席数（`services[].agents`）。 */
  agents: number
  placement: 'spread' | 'pack' | 'pin'
  /** pin 策略下的机器白名单。 */
  machines?: string[]
  maxAgentsPerMachine?: number
  existing: ExistingSeat[]
  /** 负载快照（含已在跑的坐席，扩容时在其之上继续落位）。 */
  facts: MachineFacts[]
  /** 每个坐席当前的会话数（agentId → 数量）：缩容时据此判断能不能立刻撤。 */
  sessionsBySeat?: Record<string, number>
  thresholds?: Thresholds
}

export type StrandedReason = RejectReason | 'machine_unknown'

export interface SeatsPlan {
  /** 对账后应有的坐席表（保留 + 新建），按序号升序。 */
  seats: Seat[]
  keep: Seat[]
  create: Seat[]
  /** 可以立刻撤的坐席（空闲）。 */
  remove: Seat[]
  /** 想撤但还有会话在跑：等它空下来（排水），不硬断。 */
  draining: Seat[]
  /** 想加却没地方放的数量。 */
  shortfall: number
  /** 已存在但落位不再合规的坐席：只告警，不自动迁移。 */
  stranded: Array<{ seat: Seat; reason: StrandedReason }>
  /** 每台被排除的机器一个原因（来自放置器）。 */
  rejections: Array<{ machineId: string; reason: RejectReason }>
}

export const seatNames = (serviceId: string, ordinal: number): { endpointId: string; agentId: string } => ({
  endpointId: `svc-${serviceId}-${ordinal}`,
  agentId: `${serviceId}-${ordinal}`,
})

const makeSeat = (serviceId: string, ordinal: number, machineId: string): Seat => ({
  serviceId,
  ordinal,
  ...seatNames(serviceId, ordinal),
  machineId,
})

/**
 * 反解派生端点 id（运行时对账要认出"这个端点是哪个服务的第几号坐席"）。
 * 解析规则只有这一处，避免正则散落各处后各解各的（服务 id 本身允许短横线，
 * 所以序号取最后一段：`svc-a-b-2` = 服务 `a-b` 的 2 号席）。
 */
export const parseSeatEndpoint = (endpointId: string): { serviceId: string; ordinal: number } | null => {
  const matched = /^svc-(.+)-([1-9]\d*)$/.exec(endpointId)
  const serviceId = matched?.[1]
  const ordinal = matched?.[2]
  if (serviceId === undefined || ordinal === undefined) return null
  return { serviceId, ordinal: Number(ordinal) }
}

/** 期望坐席的序号：1..agents（与声明数量对齐，缩容时先撤编号最大的）。 */
const wantedOrdinals = (agents: number): number[] => Array.from({ length: Math.max(0, agents) }, (_, i) => i + 1)

export const planSeats = (req: SeatsRequest): SeatsPlan => {
  const wanted = wantedOrdinals(req.agents)
  const existing = [...req.existing].sort((a, b) => a.ordinal - b.ordinal)
  const factsById = new Map(req.facts.map((m) => [m.id, m]))
  const sessions = req.sessionsBySeat ?? {}

  // 保留 = 期望序号内的已有坐席（按序号对应，低序号先保）。
  const keep: Seat[] = []
  const surplus: Seat[] = []
  for (const [index, seat] of existing.entries()) {
    const target = wanted[index]
    if (target === undefined) surplus.push(makeSeat(req.serviceId, seat.ordinal, seat.machineId))
    else keep.push(makeSeat(req.serviceId, seat.ordinal, seat.machineId))
  }

  // 缩容：先撤编号大的；还有会话在跑的转排水，不硬断。
  const remove: Seat[] = []
  const draining: Seat[] = []
  for (const seat of surplus.reverse()) {
    if ((sessions[seat.agentId] ?? 0) > 0) draining.push(seat)
    else remove.push(seat)
  }

  // 扩容：只补差额，序号取最小空闲号（缩容又扩容时不会乱跳）。
  // 差额必须按"保留了几个"算，不能按"空闲号有几个"算：已有坐席的序号是它的身份，
  // 不能重排（重排 = 客户会话失忆），所以序号集合与数量必须分开数
  // —— 例：已有 2、3 号而期望 1 个坐席时，若只看空闲号会误判成"缺 1 号"再多起一个。
  const usedOrdinals = new Set(keep.map((s) => s.ordinal))
  const slots = Math.max(0, wanted.length - keep.length)
  const freeOrdinals = wanted.filter((ordinal) => !usedOrdinals.has(ordinal)).slice(0, slots)
  const created: Seat[] = []
  let shortfall = 0
  let rejections: SeatsPlan['rejections'] = []
  if (freeOrdinals.length > 0) {
    const plan = planPlacement({
      serviceId: req.serviceId,
      agents: freeOrdinals.length,
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
      created.push(makeSeat(req.serviceId, ordinal, placement.machineId))
    })
  }

  // 落单告警：已有坐席的机器没了、离线了、或被隔离红线挡住 —— 只报告，不搬。
  const stranded: SeatsPlan['stranded'] = []
  for (const seat of keep) {
    const facts = factsById.get(seat.machineId)
    if (facts === undefined) {
      stranded.push({ seat, reason: 'machine_unknown' })
      continue
    }
    if (!facts.online) stranded.push({ seat, reason: 'offline' })
    else if (facts.hasPrivateAgents) stranded.push({ seat, reason: 'private_agents_present' })
    else if (facts.services.some((id) => id !== req.serviceId)) stranded.push({ seat, reason: 'other_service_present' })
    else if (req.placement === 'pin' && !(req.machines ?? []).includes(seat.machineId)) {
      stranded.push({ seat, reason: 'not_in_pin_list' })
    }
  }

  return {
    seats: [...keep, ...created].sort((a, b) => a.ordinal - b.ordinal),
    keep,
    create: created,
    remove,
    draining,
    shortfall,
    stranded,
    rejections,
  }
}
