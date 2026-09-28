/**
 * Load snapshot (contract: internal design library `manager/topics/CONCEPTS-ALIGNED.md` §4.5;
 * the load items themselves are described in `topics/service-model.md` §4).
 *
 * Assembles four data sources that **already exist** into the `MachineFacts[]` the placer
 * consumes; nothing new is collected:
 * - machines and liveness: derived from configured endpoints (local / agent machines) plus
 *   `agent_machine.last_seen_at`
 * - resource headroom: the newest `agent_metric` row; absent on a local-only machine, which
 *   means missing metrics (the placer allows that, ranked last)
 * - sessions: live `chat` rows attributed to their agent's machine
 * - isolation flags: whether the machine hosts an internal agent, or another service's agents
 *   (both derived from the config)
 *
 * Machine id convention: `spawn.host` (agent machine) or `'local'` (this host). The same id is
 * used for placement decisions and as the machine label in the audit log.
 */
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { machineIdOf, type AppConfig, type ResolvedService } from '../config.js'
import { schema, type Db } from '../db/index.js'
import type { MachineFacts } from './placement.js'

/** How long without a heartbeat an agent machine counts as offline (same window as routes/agents.ts). */
const OFFLINE_MS = 90_000
export const LOCAL_MACHINE = 'local'

export const machineIdOfEndpoint = (config: AppConfig, endpointId: string): string =>
  machineIdOf(config.endpoints, endpointId)

/** Services in service (shared by the snapshot and the placer; empty = no outward service). */
export const activeServices = (config: AppConfig): ResolvedService[] => config.services ?? []

interface MachineAggregate {
  id: string
  agents: string[]
  services: Set<string>
  hasPrivateAgents: boolean
}

const groupByMachine = (config: AppConfig): Map<string, MachineAggregate> => {
  const machines = new Map<string, MachineAggregate>()
  const ensure = (id: string): MachineAggregate => {
    const existing = machines.get(id)
    if (existing !== undefined) return existing
    const created: MachineAggregate = { id, agents: [], services: new Set(), hasPrivateAgents: false }
    machines.set(id, created)
    return created
  }

  for (const agent of Object.values(config.agents)) {
    const machine = ensure(machineIdOfEndpoint(config, agent.endpoint))
    machine.agents.push(agent.id)
    if (!agent.public) machine.hasPrivateAgents = true
  }
  for (const service of activeServices(config)) {
    for (const worker of service.workers) {
      const agent = config.agents[worker]
      if (agent === undefined) continue
      ensure(machineIdOfEndpoint(config, agent.endpoint)).services.add(service.id)
    }
  }
  return machines
}

/** Newest metrics row: cpu busy permille -> free percent; memory and disk report free bytes. */
const latestMetrics = (
  db: Db,
  machineId: string,
): Pick<MachineFacts, 'cpuFreePercent' | 'memFreeBytes' | 'diskFreeBytes'> => {
  const row = db
    .select()
    .from(schema.agentMetric)
    .where(eq(schema.agentMetric.agentId, machineId))
    .orderBy(desc(schema.agentMetric.at))
    .limit(1)
    .all()[0]
  if (row === undefined) return {}
  const facts: Pick<MachineFacts, 'cpuFreePercent' | 'memFreeBytes' | 'diskFreeBytes'> = {}
  if (row.cpuPercent !== null) facts.cpuFreePercent = Math.max(0, Math.min(100, 100 - row.cpuPercent / 10))
  if (row.memTotal !== null && row.memUsed !== null) facts.memFreeBytes = Math.max(0, row.memTotal - row.memUsed)
  if (row.diskFree !== null) facts.diskFreeBytes = row.diskFree
  return facts
}

/** Live chats attributed to their agent's machine (a chat is a long-lived conversation: the main load). */
const sessionsByMachine = (db: Db, machines: MachineAggregate[]): Map<string, number> => {
  const counts = new Map<string, number>()
  const allAgents = machines.flatMap((m) => m.agents)
  if (allAgents.length === 0) return counts
  const rows = db
    .select({ agentId: schema.chat.agentId })
    .from(schema.chat)
    .where(and(isNull(schema.chat.removedAt), inArray(schema.chat.agentId, allAgents)))
    .all()
  for (const row of rows) {
    for (const machine of machines) {
      if (machine.agents.includes(row.agentId)) counts.set(machine.id, (counts.get(machine.id) ?? 0) + 1)
    }
  }
  return counts
}

const isOnline = (db: Db, machineId: string, now: number): boolean => {
  if (machineId === LOCAL_MACHINE) return true // this host: manager running means online
  const row = db.select().from(schema.agentMachine).where(eq(schema.agentMachine.id, machineId)).all()[0]
  if (row === undefined || row.revokedAt !== null || row.lastSeenAt === null) return false
  return now - row.lastSeenAt <= OFFLINE_MS
}

export interface SnapshotOptions {
  db: Db
  config: AppConfig
  now?: number
}

/** Load snapshot for every machine, sorted by machine id for stable display and recomputation. */
export const loadMachineFacts = (options: SnapshotOptions): MachineFacts[] => {
  const now = options.now ?? Date.now()
  const machines = [...groupByMachine(options.config).values()]
  const sessions = sessionsByMachine(options.db, machines)

  return machines
    .map((machine) => ({
      id: machine.id,
      online: isOnline(options.db, machine.id, now),
      agentCount: machine.agents.length,
      services: [...machine.services],
      hasPrivateAgents: machine.hasPrivateAgents,
      sessions: sessions.get(machine.id) ?? 0,
      ...latestMetrics(options.db, machine.id),
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
}
