/**
 * Service agent reconciliation (contract: internal design library
 * `manager/topics/CONCEPTS-ALIGNED.md` §8.2).
 *
 * The service declaration is the source of truth (`services[].count` = how many agents are
 * wanted) and the agents actually running are derived from it. This module computes the
 * difference: **how many to start, how many to retire, and why a retirement has to wait**.
 * Placement (which machine) belongs to `placement.ts`; this module only does the count and
 * the ordinals that follow from it.
 *
 * Four rules:
 * 1. **Stability first**: an existing agent stays exactly where it is as long as it is still
 *    allowed (no renumbering, no moving) -- moving loses customer conversations, which costs
 *    far more than a machine looking unevenly loaded.
 * 2. **Drain before shrinking**: an agent with live conversations is not retired on the spot;
 *    it is marked draining and goes away once it is quiet.
 * 3. **Under-provisioning stays visible**: whatever does not fit is reported as a shortfall
 *    plus one rejection reason per machine, never as a silent headcount cut.
 * 4. **No automatic migration**: an existing agent on an offline or now-forbidden machine is
 *    only reported as stranded for the UI to flag; moving it belongs to self-healing (P3.5)
 *    and has to go through the full "reopen the conversation" flow.
 */
import { planPlacement, type MachineFacts, type RejectReason, type Thresholds } from './placement.js'

/**
 * One agent of a service = one dedicated DSH process (contract §1). Names derive from the
 * service id and the ordinal, so they are predictable and recomputable.
 */
export interface PlannedAgent {
  serviceId: string
  ordinal: number
  /** Derived endpoint id: the DSH process this agent owns exclusively. */
  endpointId: string
  /** Derived agent id; conversations stick to it. */
  agentId: string
  machineId: string
}

/** An agent that is already running (inferred back from its derived endpoint/agent). */
export interface ExistingAgent {
  ordinal: number
  machineId: string
}

export interface AgentsPlanRequest {
  serviceId: string
  /** How many agents are wanted (`services[].count`). */
  count: number
  placement: 'spread' | 'pack' | 'pin'
  /** Machine allow-list under the pin strategy. */
  machines?: string[]
  maxAgentsPerMachine?: number
  existing: ExistingAgent[]
  /** Load snapshot, including agents already running (scale-up places on top of them). */
  facts: MachineFacts[]
  /** Conversations each agent currently holds (agentId -> count): decides whether a retirement can happen at once. */
  sessionsByAgent?: Record<string, number>
  thresholds?: Thresholds
}

export type StrandedReason = RejectReason | 'machine_unknown'

export interface AgentsPlan {
  /** Agents that should exist after reconciliation (kept + created), ascending by ordinal. */
  agents: PlannedAgent[]
  keep: PlannedAgent[]
  create: PlannedAgent[]
  /** Agents that can be retired immediately (idle). */
  remove: PlannedAgent[]
  /** Wanted retired but still serving: wait until quiet (drain), never cut off. */
  draining: PlannedAgent[]
  /** How many agents were wanted but had nowhere to go. */
  shortfall: number
  /** Existing agents whose placement is no longer acceptable: reported, never moved automatically. */
  stranded: Array<{ agent: PlannedAgent; reason: StrandedReason }>
  /** One reason per rejected machine (from the placer). */
  rejections: Array<{ machineId: string; reason: RejectReason }>
}

export const agentNames = (serviceId: string, ordinal: number): { endpointId: string; agentId: string } => ({
  endpointId: `svc-${serviceId}-${ordinal}`,
  agentId: `${serviceId}-${ordinal}`,
})

/**
 * Parse a derived endpoint id back into service and ordinal (runtime reconciliation has to
 * recognise which service and which agent an endpoint is). The rule lives here and only here,
 * so no regex drifts apart elsewhere. Service ids may themselves contain dashes, so the
 * ordinal is the last segment: `svc-a-b-2` is agent 2 of service `a-b`.
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

/** Ordinals wanted: 1..count (matching the declaration; scale-down retires the highest first). */
const wantedOrdinals = (count: number): number[] => Array.from({ length: Math.max(0, count) }, (_, i) => i + 1)

export const planAgents = (req: AgentsPlanRequest): AgentsPlan => {
  const wanted = wantedOrdinals(req.count)
  const existing = [...req.existing].sort((a, b) => a.ordinal - b.ordinal)
  const factsById = new Map(req.facts.map((m) => [m.id, m]))
  const sessions = req.sessionsByAgent ?? {}

  // Keep = existing agents inside the wanted ordinals (lower ordinals are kept first).
  const keep: PlannedAgent[] = []
  const surplus: PlannedAgent[] = []
  for (const [index, agent] of existing.entries()) {
    const target = wanted[index]
    if (target === undefined) surplus.push(makeAgent(req.serviceId, agent.ordinal, agent.machineId))
    else keep.push(makeAgent(req.serviceId, agent.ordinal, agent.machineId))
  }

  // Scale-down: retire the highest ordinals first; anything still serving switches to draining.
  const remove: PlannedAgent[] = []
  const draining: PlannedAgent[] = []
  for (const agent of surplus.reverse()) {
    if ((sessions[agent.agentId] ?? 0) > 0) draining.push(agent)
    else remove.push(agent)
  }

  // Scale-up: fill only the gap, using the smallest free ordinals (so shrink-then-grow does not
  // make numbers jump). The gap is computed from "how many were kept", not from "how many free
  // ordinals exist": an existing agent's ordinal is its identity and may not be reorganised
  // (that would lose customer conversations), so ordinals and counts are counted separately --
  // e.g. agents 2 and 3 exist while only 1 is wanted: looking at free ordinals alone would
  // think "ordinal 1 is missing" and start an extra agent.
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

  // Stranded: an existing agent whose machine is gone, offline, or blocked by a red line.
  // Reported only -- the manager does not move agents on its own.
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
