import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import { desc, eq } from 'drizzle-orm'
import type { AppConfig } from '../config.js'
import { schema, type Db } from '../db/index.js'
import { errorText } from '../errors.js'
import type { GatewayClient } from '../gateway/client.js'
import type { SessionDriver } from '../session-driver/port.js'
import { listArchivedChats, listChats } from '../chat/store.js'
import { activeRunCount, runningRunId } from '../runner.js'
import { currentMonth, monthByAgent } from '../usage/store.js'
// Fleet M1 pilot regression: the compatibility signal goes through the version matrix (0.1.5-rc.2 is a verified
// row, and the old === COMPAT_DSH_VERSION logic misreported it as incompatible)
import { dshCompatible } from '../dsh-matrix.js'
// Debt D5: the manager's own version (injected at build time; do not confuse it with the DSH compatibility version)
import { MANAGER_VERSION } from '../version.js'

export interface EndpointStatus {
  id: string
  url: string
  driver: 'gateway' | 'apiproxy'
  reachable: boolean
  sessions: number | null
  apiKeySet: boolean | null
  enabled: boolean | null
  error: string | null
  /** Hive plan 2 P1: the node's DSH version as probed over apiproxy; gateway/unknown = null. */
  dshVersion: string | null
  /** Fleet M1 pilot regression: decided by the version matrix (dsh-matrix.ts); null = version unknown (no warning). */
  dshCompatible: boolean | null
}

/**
 * One endpoint liveness probe, branched by driver:
 * - gateway  → the old plugin's own GET /health
 * - apiproxy → one bounded host.describe RPC (there is no /health under /api)
 *
 * Exported for the nodes route (Hive P3): an unmanaged node's state *is* its
 * probe result.
 */
export const probeEndpoint = async (
  config: AppConfig,
  clients: Map<string, GatewayClient>,
  upstreamClients: Map<string, SessionDriver>,
  endpointId: string,
): Promise<EndpointStatus> => {
  const endpoint = config.endpoints[endpointId]
  const url = endpoint?.url ?? ''
  const driver = endpoint?.driver ?? 'gateway'
  const row: EndpointStatus = {
    id: endpointId,
    url,
    driver,
    reachable: false,
    sessions: null,
    apiKeySet: null,
    enabled: null,
    error: null,
    dshVersion: null,
    dshCompatible: null,
  }
  if (driver === 'apiproxy') {
    const upstream = upstreamClients.get(endpointId)
    if (upstream === undefined) {
      row.error = 'endpoint not configured'
      return row
    }
    try {
      const version = await upstream.probeVersion()
      row.reachable = true
      if (version !== 'unknown') {
        // From 0.1.2 on, host.describe is synthesised by the facade and version returns the real DSH
        // version of the host tree (falling back to the protocol number '0.0.1' when unreadable) -- for display, and the compatibility signal follows from it.
        row.dshVersion = version
        row.dshCompatible = dshCompatible(version)
      }
      return row
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      row.error = detail.slice(0, 300)
      return row
    }
  }
  const client = clients.get(endpointId)
  if (client === undefined) {
    row.error = 'endpoint not configured'
    return row
  }
  try {
    const health = await client.health()
    row.reachable = true
    row.sessions = health.sessions
    row.apiKeySet = health.apiKeySet
    row.enabled = health.enabled
    return row
  } catch (error) {
    // A dead endpoint must not take the whole status page down; it shows
    // up as one unreachable row instead.
    const detail = errorText(error)
    row.error = detail.slice(0, 300)
    return row
  }
}

/**
 * Debt B4: a TTL cache for probe results. The frontend polls /api/status every 5s, and the old code fanned
 * out a real probe to every endpoint on every request (the more nodes, the bigger the storm, and a slow probe
 * dragged the whole page out). Cached = every poll inside one TTL window hits; past the TTL or after an explicit
 * clear, probing resumes. Note: the supervisor already maintains node lifecycle state in the background, so the
 * more thorough "read the supervisor snapshot" option waits for a later B-class pass (folding HTTP probe semantics into the supervisor is a big change).
 */
const probeCache = new Map<string, { at: number; result: EndpointStatus }>()
const PROBE_TTL_MS = 5_000

/** Testing only: clear the probe cache (so no TTL residue leaks between tests). */
export const _clearProbeCache = (): void => {
  probeCache.clear()
}

const probeCached = async (
  config: AppConfig,
  clients: Map<string, GatewayClient>,
  upstreamClients: Map<string, SessionDriver>,
  endpointId: string,
): Promise<EndpointStatus> => {
  const hit = probeCache.get(endpointId)
  if (hit !== undefined && Date.now() - hit.at < PROBE_TTL_MS) return hit.result
  const result = await probeEndpoint(config, clients, upstreamClients, endpointId)
  probeCache.set(endpointId, { at: Date.now(), result })
  return result
}

export const registerStatusRoutes = (
  app: FastifyInstance,
  config: AppConfig,
  db: Db,
  clients: Map<string, GatewayClient>,
  requireUser: preHandlerHookHandler,
  upstreamClients: Map<string, SessionDriver>,
  /** Node supervisors (the agent detail panel reads the container image tag from them; without docker it is empty or the lookup misses). */
  supervisors: Map<string, import('../nodes/supervisor.js').NodeSupervisor> = new Map(),
): void => {
  /** Liveness for a supervisor. Intentionally unauthenticated and contentless. */
  app.get('/healthz', async (_request, reply) => reply.send({ ok: true }))

  app.get('/api/status', { preHandler: requireUser }, async (_request, reply) => {
    // Every configured endpoint gets a row, whatever its driver: the green dot
    // is the page's whole job, and a missing row reads as "forgotten", not "down".
    // Debt B4: the TTL cache -- reuse the previous probe inside the polling window instead of fanning out per request.
    const endpoints: EndpointStatus[] = await Promise.all(
      Object.keys(config.endpoints).map((id) => probeCached(config, clients, upstreamClients, id)),
    )

    const agents = Object.values(config.agents).map((agent) => ({
      id: agent.id,
      name: agent.name,
      endpoint: agent.endpoint,
      workspacePath: agent.workspacePath,
      public: agent.public,
    }))

    // Boot-time warnings were only ever written to the log, where nobody sees
    // them again. Things like "these agents share one DSH sandbox root" need to
    // be visible in the UI for as long as they remain true.
    return reply.send({ endpoints, agents, warnings: config.warnings, managerVersion: MANAGER_VERSION })
  })

  /**
   * Everything about one agent, in one request.
   *
   * The sidebar's green dot is endpoint health, not agent health, and when two
   * agents share an endpoint their dots move together -- which reads as "both
   * agents are down" when the truth is "one DSH process is down". This is where
   * that gets spelled out: which endpoint, who else is on it, and what the
   * sandbox consequence of sharing it is.
   *
   * One aggregate rather than five requests from the drawer: the panel is opened
   * to answer a single question, and five independent fetches can disagree with
   * each other about which agent is busy.
   */
  app.get<{ Params: { id: string } }>('/api/agents/:id', { preHandler: requireUser }, async (request, reply) => {
    const agent = config.agents[request.params.id]
    if (agent === undefined) return reply.code(404).send({ error: 'unknown_agent' })

    const health = await probeCached(config, clients, upstreamClients, agent.endpoint)

    // Container form: the node's image tag (the image tag is the DSH version) -- the detail panel shows it first.
    const image = await supervisors.get(agent.endpoint)?.containerImage() ?? null

    // Sharing an endpoint is the fact most worth surfacing here: a DSH sandbox
    // root is per process, not per session, so these agents can read and write
    // each other's workspaces no matter what manager asks for.
    const sharedWith = Object.values(config.agents)
      .filter((a) => a.endpoint === agent.endpoint && a.id !== agent.id)
      .map((a) => ({ id: a.id, name: a.name }))

    const month = currentMonth()
    const spend = monthByAgent(db, month).find((row) => row.agentId === agent.id) ?? null

    const runs = db
      .select()
      .from(schema.run)
      .where(eq(schema.run.agentId, agent.id))
      .orderBy(desc(schema.run.startedAt))
      .limit(5)
      .all()

    return reply.header('cache-control', 'no-store').send({
      agent: {
        id: agent.id,
        name: agent.name,
        endpoint: agent.endpoint,
        workspacePath: agent.workspacePath,
        public: agent.public,
        preset: agent.preset,
        provider: agent.provider,
        model: agent.model,
        gitRemote: agent.gitRemote,
      },
      endpoint: { ...health, ...(image === null ? {} : { image }) },
      sharedWith,
      busyRunId: runningRunId(agent.id),
      activeRuns: activeRunCount(agent.id),
      chats: {
        active: listChats(db, agent.id).length,
        archived: listArchivedChats(db).filter((c) => c.agentId === agent.id).length,
      },
      month: {
        month,
        costMicroUsd: spend?.costMicroUsd ?? 0,
        peakCostMicroUsd: spend?.peakCostMicroUsd ?? 0,
        unpriced: spend?.unpriced ?? 0,
        runs: spend?.runs ?? 0,
      },
      runs: runs.map((r) => ({
        id: r.id,
        trigger: r.trigger,
        state: r.state,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        error: r.error,
      })),
      // Only the warnings that are about this agent's endpoint. The full list is
      // on /api/status for the pages that show all of them.
      warnings: config.warnings.filter((w) => w.includes(`"${agent.endpoint}"`)),
    })
  })
}
