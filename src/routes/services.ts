/**
 * The outward-service administration surface (admin port 8080, behind `requireUser`).
 *
 * This is the operator's view of §4.3 in `manager/topics/CONCEPTS-ALIGNED.md`: per service, each
 * agent's liveness / current conversations / queue, the capacity the service has promised, and how
 * much of today's quota the keys serving it have burned.
 *
 * Read-only on purpose (user, 2026-09-28): the "add/remove an agent with one click" half of P2.5
 * needs *provisioning an agent from the declaration* (placement -> spawn -> mint a gateway key ->
 * probe -> record), and that capability does not exist yet -- `services[].count` must still equal the
 * number of listed workers. A button that cannot do what it says is worse than no button, so the page
 * shows the truth instead: what is running, how busy, and what the declaration asks for.
 *
 * Nothing here talks to a node: liveness is the **single** source the outward dispatcher uses
 * (the supervisor state machine), injected by the wiring layer, so the page and the dispatcher can
 * never disagree about who is online.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { and, gte, inArray, isNull, sql } from 'drizzle-orm'
import { listApiKeys } from '../auth/api-key.js'
import { machineIdOf, type AppConfig } from '../config.js'
import { schema, type Db } from '../db/index.js'
import { startOfLocalDay } from '../public-api/quota.js'

/** Live conversations and queued turns per agent (counts, not rates -- nothing to aggregate). */
interface AgentCounts {
  sessions: number
  queueDepth: number
}

const agentCounts = (db: Db, agentIds: string[]): Map<string, AgentCounts> => {
  const counts = new Map<string, AgentCounts>()
  if (agentIds.length === 0) return counts
  const ensure = (agentId: string): AgentCounts => {
    const existing = counts.get(agentId)
    if (existing !== undefined) return existing
    const created: AgentCounts = { sessions: 0, queueDepth: 0 }
    counts.set(agentId, created)
    return created
  }

  const sessions = db
    .select({ agentId: schema.chat.agentId })
    .from(schema.chat)
    .where(and(isNull(schema.chat.removedAt), inArray(schema.chat.agentId, agentIds)))
    .all()
  for (const row of sessions) ensure(row.agentId).sessions += 1

  // Turns inside one conversation are serial, so whatever is pending/running is what is queued
  // behind -- the same reading `public-api/service-load.ts` gives the dispatcher.
  const queue = db
    .select({ agentId: schema.run.agentId })
    .from(schema.run)
    .where(and(inArray(schema.run.agentId, agentIds), inArray(schema.run.state, ['pending', 'running'])))
    .all()
  for (const row of queue) ensure(row.agentId).queueDepth += 1

  return counts
}

/** How many times each machine has been seen, for "is the machine itself alive" (the agent's own state is the supervisor's). */
const machineSeen = (db: Db, machineIds: string[]): Map<string, { hostname: string; lastSeenAt: number | null; revokedAt: number | null }> => {
  const out = new Map<string, { hostname: string; lastSeenAt: number | null; revokedAt: number | null }>()
  if (machineIds.length === 0) return out
  const rows = db
    .select({ id: schema.agentMachine.id, hostname: schema.agentMachine.hostname, lastSeenAt: schema.agentMachine.lastSeenAt, revokedAt: schema.agentMachine.revokedAt })
    .from(schema.agentMachine)
    .where(inArray(schema.agentMachine.id, machineIds))
    .all()
  for (const row of rows) out.set(row.id, { hostname: row.hostname, lastSeenAt: row.lastSeenAt, revokedAt: row.revokedAt })
  return out
}

export interface ServiceAgentRow {
  id: string
  name: string
  endpoint: string
  machine: string
  /** The supervisor's own state for this agent's node (the same answer dispatch gets). */
  online: boolean
  /** Live conversations on this agent right now, internal ones included (they occupy the same agent). */
  sessions: number
  queueDepth: number
  /** The service's per-agent concurrency ceiling. */
  maxSessions: number
  provider: string | null
  model: string | null
  /** The agent's permission tier as loaded (read-only is the outward default). */
  sandboxMode: string | null
}

export interface ServiceKeyRow {
  id: string
  name: string
  /** Runs dispatched by this key since local midnight (the quota counter's own number). */
  usedToday: number
  quotaRunsDay: number | null
  active: number
  maxConcurrency: number
  revokedAt: number | null
}

export interface ServiceRow {
  id: string
  label: string
  surfaces: Array<'tasks' | 'conversations'>
  agents: ServiceAgentRow[]
  declaredCount: number
  permission: 'read' | 'write'
  sessionIdleHours: number
  placement: string
  machines: string[]
  knowledge: Array<{ host: string; mount: string; readOnly: boolean }>
  capacity: {
    /** What the service promises when every member is online. */
    maxConcurrent: number
    /** The part of it that is actually reachable right now. */
    onlineMaxConcurrent: number
    inUse: number
    queued: number
    onlineAgents: number
    declaredAgents: number
  }
  keys: ServiceKeyRow[]
}

/**
 * Register `/api/services`. Returns the projection only -- the route is a thin shell, so the numbers
 * can be tested without a server.
 */
export const serviceRows = (deps: {
  db: Db
  config: AppConfig
  isOnline: (agentId: string) => boolean
  now?: number
}): ServiceRow[] => {
  const { db, config } = deps
  const now = deps.now ?? Date.now()
  const services = config.services ?? []
  const allAgentIds = [...new Set(services.flatMap((service) => service.workers))]
  const counts = agentCounts(db, allAgentIds)
  const machines = machineSeen(
    db,
    [...new Set(allAgentIds.flatMap((agentId) => {
      const agent = config.agents[agentId]
      return agent === undefined ? [] : [machineIdOf(config.endpoints, agent.endpoint)]
    }))],
  )
  const keys = listApiKeys(db)
  const since = startOfLocalDay(now)

  return services.map((service) => {
    const maxSessions = service.maxSessionsPerAgent ?? 4
    const agents: ServiceAgentRow[] = service.workers.map((agentId) => {
      const agent = config.agents[agentId]
      // A worker that is not in `agents:` is rejected by loadConfig, so this branch means the route
      // was handed a config from somewhere else. Report it honestly rather than inventing a row.
      if (agent === undefined) {
        return {
          id: agentId,
          name: agentId,
          endpoint: '(missing from config)',
          machine: '(unknown)',
          online: false,
          sessions: 0,
          queueDepth: 0,
          maxSessions,
          provider: null,
          model: null,
          sandboxMode: null,
        }
      }
      const machineId = machineIdOf(config.endpoints, agent.endpoint)
      const seen = machines.get(machineId)
      return {
        id: agent.id,
        name: agent.name,
        endpoint: agent.endpoint,
        // The machine id is what the placement rules name, so show it; an unknown machine is shown as
        // such rather than as a plausible-looking hostname.
        machine: seen === undefined ? machineId : `${seen.hostname} (${machineId})`,
        online: deps.isOnline(agent.id),
        sessions: counts.get(agent.id)?.sessions ?? 0,
        queueDepth: counts.get(agent.id)?.queueDepth ?? 0,
        maxSessions,
        provider: agent.provider,
        model: agent.model,
        sandboxMode: agent.sandboxMode,
      }
    })

    const inUse = agents.reduce((sum, agent) => sum + agent.sessions, 0)
    const onlineAgents = agents.filter((agent) => agent.online).length

    // Which keys can enter this service: '*' covers every service, an explicit list names it. A
    // revoked key is listed too (its history stays attributable) but flagged.
    const scoped = keys.filter((key) => key.scopeServices.includes('*') || key.scopeServices.includes(service.id))
    const usageByKey = new Map<string, { used: number; active: number }>()
    if (scoped.length > 0) {
      const usedRows = db
        .select({ apiKeyId: schema.run.apiKeyId, n: sql<number>`COUNT(*)`.as('n') })
        .from(schema.run)
        .where(and(inArray(schema.run.apiKeyId, scoped.map((key) => key.id)), gte(schema.run.startedAt, since)))
        .groupBy(schema.run.apiKeyId)
        .all()
      for (const row of usedRows) {
        if (row.apiKeyId === null) continue
        usageByKey.set(row.apiKeyId, { used: row.n, active: 0 })
      }
      const activeRows = db
        .select({ apiKeyId: schema.run.apiKeyId, n: sql<number>`COUNT(*)`.as('n') })
        .from(schema.run)
        .where(and(inArray(schema.run.apiKeyId, scoped.map((key) => key.id)), inArray(schema.run.state, ['pending', 'running'])))
        .groupBy(schema.run.apiKeyId)
        .all()
      for (const row of activeRows) {
        if (row.apiKeyId === null) continue
        const entry = usageByKey.get(row.apiKeyId) ?? { used: 0, active: 0 }
        usageByKey.set(row.apiKeyId, { ...entry, active: row.n })
      }
    }

    return {
      id: service.id,
      label: service.label,
      surfaces: service.surfaces,
      agents,
      declaredCount: service.count ?? agents.length,
      permission: service.permission ?? 'read',
      sessionIdleHours: service.sessionIdleHours ?? 24,
      placement: service.placement ?? 'spread',
      machines: service.machines ?? [],
      knowledge: service.knowledge,
      capacity: {
        maxConcurrent: maxSessions * agents.length,
        onlineMaxConcurrent: maxSessions * onlineAgents,
        inUse,
        queued: agents.reduce((sum, agent) => sum + agent.queueDepth, 0),
        onlineAgents,
        declaredAgents: agents.length,
      },
      keys: scoped.map((key) => ({
        id: key.id,
        name: key.name,
        usedToday: usageByKey.get(key.id)?.used ?? 0,
        quotaRunsDay: key.quotaRunsDay,
        active: usageByKey.get(key.id)?.active ?? 0,
        maxConcurrency: key.maxConcurrency,
        revokedAt: key.revokedAt,
      })),
    }
  })
}

export const registerServiceRoutes = (
  app: FastifyInstance,
  // The guard is typed as the async hook it actually is (`makeRequireUser` returns Promise<void>).
  // Fastify's own `preHandlerHookHandler` allows a synchronous variant too, and passing an async
  // function where a void return is "expected" trips no-misused-promises at the call site.
  deps: { db: Db; config: AppConfig; isOnline: (agentId: string) => boolean; requireUser: (request: FastifyRequest, reply: FastifyReply) => Promise<void> },
): void => {
  app.get('/api/services', { preHandler: deps.requireUser }, async (_request, reply) =>
    reply.header('cache-control', 'no-store').send({
      services: serviceRows({ db: deps.db, config: deps.config, isOnline: deps.isOnline }),
      // The page needs to tell "no service is configured at all" from "a service is configured but
      // has no keys yet": the two want different next steps from the operator.
      keysExist: listApiKeys(deps.db).some((key) => key.revokedAt === null),
    }),
  )
}
