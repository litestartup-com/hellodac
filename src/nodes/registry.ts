/**
 * Node registry — builds a NodeSupervisor per managed endpoint (Hive P1).
 *
 * The probe is the endpoint health check the manager already knows how to run:
 * apiproxy → host.describe (hostVersion), gateway → /health. Nothing in here
 * touches the filesystem or the database; the wiring layer passes in the
 * clients and the logger.
 */

import { NodeSupervisor, type NodeProbeResult } from './supervisor.js'
import type { DockerRunner } from './docker-runner.js'
import type { AppConfig, ResolvedEndpoint } from '../config.js'
import type { GatewayClient } from '../gateway/client.js'
import type { SessionDriver } from '../session-driver/port.js'

export interface NodeRegistryDeps {
  gateway: (id: string) => GatewayClient | undefined
  upstream: (id: string) => SessionDriver | undefined
  log?: (line: string) => void
  /** Hive plan 2 P2b: the docker runner (only needed by endpoints with runner=docker). */
  docker?: DockerRunner
  /** Capability four (M1-4): the agent runner trio (only needed by endpoints with runner=agent). */
  agentCommand?: (agentId: string, type: string, payload: unknown) => number
  agentResult?: (commandId: number, cb: (ok: boolean) => void) => () => void
  agentLog?: (agentId: string, nodeId: string) => string
  /** Capability four (M1-6): fleet.md content generation (the payload of the derived push). */
  fleetDoc?: () => string
  /** Fleet M3: an agent node unlocked to the full sandbox (a bound workspace with sandboxMode=danger-full-access)
   * -- the spawn payload carries ALLOW_FULL_ACCESS and the agent writes it into the facade settings (allowFullAccess). */
  agentFullAccess?: boolean
}

/** Hive P5.5: building one node supervisor (shared by the full boot build and runtime hot loads). */
export const makeSupervisor = (endpoint: ResolvedEndpoint, deps: NodeRegistryDeps): NodeSupervisor =>
  new NodeSupervisor(endpoint.id, {
    probe: async (): Promise<NodeProbeResult> => {
      try {
        if (endpoint.driver === 'apiproxy') {
          const version = await deps.upstream(endpoint.id)?.probeVersion()
          return version === undefined || version === 'unknown'
            ? { ok: false, detail: 'host.describe returned no version' }
            : { ok: true, detail: `host.describe ok (${version})` }
        }
        const health = await deps.gateway(endpoint.id)?.health()
        return health !== undefined && health.status === 'ok'
          ? { ok: true, detail: 'gateway health ok' }
          : { ok: false, detail: 'gateway health not ok' }
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : String(error) }
      }
    },
    ...(deps.log === undefined ? {} : { log: deps.log }),
    ...(deps.docker === undefined ? {} : { docker: deps.docker }),
    ...(deps.agentCommand === undefined ? {} : { agentCommand: deps.agentCommand }),
    ...(deps.agentResult === undefined ? {} : { agentResult: deps.agentResult }),
    ...(deps.agentLog === undefined ? {} : { agentLog: deps.agentLog }),
    ...(deps.fleetDoc === undefined ? {} : { fleetDoc: deps.fleetDoc }),
    // Capability four (M1-6): extra environment on an agent node's spawn payload -- GW_KEY is the gateway
    // sandbox key (the agent writes DSH_HOME/settings.yaml), the model key comes from the inherited environment.
    // Fleet M3: agentFullAccess = the unlock signal for an ops node (the agent writes the facade allowFullAccess).
    agentEnv: () => ({
      GW_KEY: endpoint.sandboxKey,
      ...(deps.agentFullAccess === true ? { ALLOW_FULL_ACCESS: 'true' } : {}),
      ...(process.env.DEEPSEEK_API_KEY !== undefined && process.env.DEEPSEEK_API_KEY !== ''
        ? { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY }
        : {}),
    }),
    // Hive plan 2 P2b: a node container's environment -- GW_KEY is the gateway sandbox key (the same one
    // settings injection uses), the model key comes from the inherited environment (highest in DSH's credential layering).
    // MANAGER_URL: for the brain's skill manual calling the internal API (inside the container 127.0.0.1 is the node itself, not the manager).
    dockerEnv: () => ({
      DSH_HOME: '/data',
      GW_KEY: endpoint.sandboxKey,
      MANAGER_URL: 'http://manager:8080',
      ...(process.env.DEEPSEEK_API_KEY !== undefined && process.env.DEEPSEEK_API_KEY !== ''
        ? { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY }
        : {}),
    }),
  })

export const buildNodeSupervisors = (config: AppConfig, deps: NodeRegistryDeps): Map<string, NodeSupervisor> => {
  const map = new Map<string, NodeSupervisor>()
  for (const endpoint of Object.values(config.endpoints)) {
    // Hive plan 2 P2b: a docker-runner node is a managed node too (the manager pulls the container over the socket)
    if (endpoint.spawn === null || !endpoint.spawn.managed) continue
    // Fleet M3: any workspace bound to this endpoint being danger-full-access = the unlock signal
    const fullAccess = Object.values(config.agents).some(
      (a) => a.endpoint === endpoint.id && a.sandboxMode === 'danger-full-access',
    )
    map.set(endpoint.id, makeSupervisor(endpoint, { ...deps, ...(fullAccess ? { agentFullAccess: true } : {}) }))
  }
  return map
}
