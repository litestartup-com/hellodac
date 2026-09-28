/**
 * Agent placement (contract: internal design library `manager/topics/CONCEPTS-ALIGNED.md` §4.5;
 * strategy details in `topics/service-model.md` §5).
 *
 * Input: one load snapshot (per machine: online state, agents already running, sessions, resource
 * headroom, and whether it hosts an internal agent or another service's agents). Output: which
 * machines a new agent should land on, and **why every other machine was rejected**.
 *
 * Three rules:
 * 1. **Hard constraints are never traded away**: the isolation red lines (an internal agent, or
 *    another service's agents, on the same machine) and low headroom veto outright -- "the other
 *    machine is busier" does not make them acceptable, because such mistakes are almost impossible
 *    to trace afterwards.
 * 2. **Pure**: same input, same output (ties break by machine id), so it can be unit-tested,
 *    previewed in the UI, and recomputed after the fact.
 */
export interface MachineFacts {
  id: string
  online: boolean
  /** Agents already running on this machine (this service and any other). */
  agentCount: number
  /** Service ids owning the agents on this machine. */
  services: string[]
  /** Whether this machine hosts an internal agent (red line: one OS user, one filesystem view). */
  hasPrivateAgents: boolean
  /** Live conversations; used to mildly penalise a machine that is already busy. */
  sessions: number
  cpuFreePercent?: number
  memFreeBytes?: number
  diskFreeBytes?: number
  /** Knowledge or workspace already lives here: preferred on ties, saves network and IO. */
  knowledgeAffinity?: boolean
}

export interface Thresholds {
  minFreeCpuPercent: number
  minFreeMemBytes: number
  minFreeDiskBytes: number
}

/** Defaults confirmed by the user on 2026-09-27. */
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
  /** How many agents to place (the service's `count`). */
  count: number
  machines: MachineFacts[]
  strategy?: 'spread' | 'pack' | 'pin'
  pinMachines?: string[]
  maxAgentsPerMachine?: number
  thresholds?: Thresholds
}

export interface PlacementPlan {
  placements: Array<{ machineId: string; score: number; metricsKnown: boolean }>
  /** Agents that did not fit: callers queue or alert instead of silently under-provisioning. */
  shortfall: number
  /** One reason per rejected machine (the first constraint it failed). */
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

/** Hard constraints: the first failing reason, or null when everything passes. */
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
 * Score (higher is better; integers keep tests and display simple).
 *
 * A machine with no metrics is **allowed but ranked last** (-1000): single-machine setups report
 * no agent_metric at all, and rejecting it outright would lock out the most common deployment --
 * but "no data" must never look better than "healthy data" either.
 */
export const scoreMachine = (facts: MachineFacts, serviceId: string, opts: ResolvedOptions, agentsOnMachine: number): number => {
  if (!metricsKnown(facts)) return -1000
  let score = facts.cpuFreePercent ?? 0
  score += Math.min(4, (facts.memFreeBytes ?? 0) / opts.thresholds.minFreeMemBytes) * 10
  score += Math.min(4, (facts.diskFreeBytes ?? 0) / opts.thresholds.minFreeDiskBytes) * 5
  score -= facts.sessions
  // The heart of spread: an agent of this service already here costs a lot (spread by default, so
  // one machine failing takes down only part of the conversations); pack is the opposite.
  if (opts.strategy !== 'pack') {
    score -= facts.services.filter((id) => id === serviceId).length * 400
    score -= agentsOnMachine * 400
  }
  if (facts.knowledgeAffinity === true) score += 50
  return Math.round(score)
}

/** Place agents one by one, updating the per-machine count -- that is what makes spread spread. */
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
        // Record rejections only in the first round: later rounds mostly fail with "just filled",
        // and repeating those would drown out the real reason.
        if (!reported) rejections.push({ machineId: facts.id, reason: blocked })
        continue
      }
      candidates.push({ machineId: facts.id, score: scoreMachine(facts, req.serviceId, opts, used), metricsKnown: metricsKnown(facts) })
    }
    reported = true
    if (candidates.length === 0) break
    // Ties break by ascending id: a pure function must be deterministic, or tests and
    candidates.sort((a, b) => (b.score === a.score ? a.machineId.localeCompare(b.machineId) : b.score - a.score))
    const chosen = candidates[0]
    if (chosen === undefined) break
    placements.push(chosen)
    agentsOnMachine.set(chosen.machineId, (agentsOnMachine.get(chosen.machineId) ?? 0) + 1)
  }

  return { placements, shortfall: Math.max(0, req.count - placements.length), rejections }
}
