/**
 * 负载快照（口径：内部设计库 `manager/topics/CONCEPTS-ALIGNED.md` §4.5；负载项细节
 * 见 `topics/service-model.md` §4）。
 *
 * 把**已经存在**的四路数据拼成放置器能吃的 `MachineFacts[]`，不新增任何采集：
 * - 机器与在线状态：由配置端点推导（本机 / agent 机器）+ `agent_machine.last_seen_at`
 * - 资源水位：`agent_metric` 最新一行；本机没有这行 → 指标缺失（放置器允许但排在最后）
 * - 会话数：`chat`（未归档）按 agent 归属到机器
 * - 隔离标记：该机器上是否有对内 agent、是否有别的服务的 agent（都从配置推导）
 *
 * 机器 id 约定：`spawn.host`（agent 机器）或 `'local'`（本机进程/容器）。
 * 这个 id 同时用于放置决策与审计里的机器标识。
 */
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { machineIdOf, type AppConfig, type ResolvedService } from '../config.js'
import { schema, type Db } from '../db/index.js'
import type { MachineFacts } from './placement.js'

/** agent 机器多久没心跳算离线（与 routes/agents.ts 的 AGENT_OFFLINE_MS 同口径）。 */
const OFFLINE_MS = 90_000
export const LOCAL_MACHINE = 'local'

export const machineIdOfEndpoint = (config: AppConfig, endpointId: string): string =>
  machineIdOf(config.endpoints, endpointId)

/** 服役中的服务（快照与放置器共用；缺省 = 没有对外服务）。 */
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

/** 最新一行指标：CPU 忙占比 ×10 → 空闲百分比反算；内存与磁盘取空闲量。 */
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

/** 未归档会话按 agent 归属到机器（会话 = 一次长驻对话，机器负载的主要来源）。 */
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
  if (machineId === LOCAL_MACHINE) return true // 本机：manager 在跑就是在线
  const row = db.select().from(schema.agentMachine).where(eq(schema.agentMachine.id, machineId)).all()[0]
  if (row === undefined || row.revokedAt !== null || row.lastSeenAt === null) return false
  return now - row.lastSeenAt <= OFFLINE_MS
}

export interface SnapshotOptions {
  db: Db
  config: AppConfig
  now?: number
}

/** 全部机器的负载快照（按机器 id 排序，便于展示与复算）。 */
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
