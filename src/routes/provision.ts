import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import { z } from 'zod'
import { mutateYamlFile, withConfigLock, writeFileAtomic } from '../config-store.js'
import type { AppConfig, ResolvedEndpoint, ResolvedSpawnSpec } from '../config.js'
import type { Db } from '../db/index.js'
import { schema } from '../db/index.js'
import type { GatewayClient } from '../gateway/client.js'
import type { SessionDriver } from '../session-driver/port.js'
import { buildUpstreamClients } from '../upstream/client.js'
import type { NodeSupervisor } from '../nodes/supervisor.js'
import type { DockerRunner } from '../nodes/docker-runner.js'
import { makeSupervisor } from '../nodes/registry.js'
import { detectDshBin, ensureNodeCredentials, ensureNodeProfiles, mergeEnv, profileInstallCommand, resolveGatewayKey } from '../cli/setup.js'
import { dshBinInProfile } from '../host-node/profile.js'
import { ensureWorkspaceGit } from '../workspace/init.js'
import { reconcileAll, removeAgentRow } from '../reconcile/index.js'
import { GATEWAY_REF } from '../dsh-version.js'
import { SUPPORTED_DSH, defaultDshVersion, resolvePair } from '../dsh-matrix.js'
import { recordAudit } from '../audit.js'

/**
 * Hive P5.5: adding / deleting nodes at runtime.
 *
 * Principle: files are the truth + additive-only hot reload. Write order = profile →
 * credentials → .env → manager.config.yaml, and **memory last**: a failure at any step
 * rolls back (the node directory is removed), leaving config and memory as they were.
 * Delete = unmanage (the directory on disk stays) and requires no agent on the node (migration comes later).
 *
 * Debt E3: the docker/process branches share one provisioning pipeline (prepare → DB →
 * truth file → memory → process), with shape differences (url/sandbox base, spawn spec,
 * image vs bin) parameterized; the rollback ledger (H2 order) and the B1 async install flow stay in-branch.
 */

const CONFIG_PATH = 'manager.config.yaml'
const ENV_PATH = '.env'

/** Debt E3: the agent spec a new node carries (the same shape in both branches). */
interface NewAgentSpec {
  id: string
  name: string
  workspace: string
  preset: string | null
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access' | null
}

/** Pipeline step 1: workspace directory + git init (returns a warning message). */
const prepareWorkspace = (agentSpec: NewAgentSpec | null): string | null => {
  if (agentSpec === null) return null
  mkdirSync(agentSpec.workspace, { recursive: true })
  const git = ensureWorkspaceGit(agentSpec.workspace, agentSpec.name)
  return git.warning
}

/**
 * Pipeline step 2: DB bookkeeping first. The mirror itself is done by reconcileAll's
 * mirrorAgents (Debt R9, a single implementation); this only records whether the row
 * exists, for the rollback ledger.
 */
const markDbFirst = (db: Db, agentSpec: NewAgentSpec | null): boolean => {
  if (agentSpec === null) return false
  const row = db.select({ id: schema.agent.id }).from(schema.agent).all().find((a) => a.id === agentSpec.id)
  return row === undefined
}

/**
 * Pipeline step 3: write the truth files (.env secret + yaml; Debt A3 atomic write +
 * comment preservation, Debt R6 the single lock entry). Returns the pre-write snapshot for H2 rollback.
 */
const writeNodeTruth = async (
  paths: { envPath: string; configPath: string },
  spec: {
    keyRef: string
    key: string
    name: string
    url: string
    sandboxBase: string
    agentSpec: NewAgentSpec | null
    /** Shape difference: a docker spec or a process spawn block, written verbatim into yaml's spawn. */
    spawnYaml: unknown
  },
): Promise<{ envSnap: string | null; yamlSnap: string }> => {
  const envSnap = existsSync(paths.envPath) ? readFileSync(paths.envPath, 'utf8') : null
  const yamlSnap = readFileSync(paths.configPath, 'utf8')
  await withConfigLock(() => {
    mergeEnv(paths.envPath, { [spec.keyRef]: spec.key }, [spec.keyRef])
    mutateYamlFile(
      paths.configPath,
      (doc) => {
        doc.setIn(['endpoints', spec.name], {
          url: spec.url,
          driver: 'apiproxy',
          // Debt R10 (proven by the compose-e2e worker live timeout): after 0.1.2 switched to the main
          // path, a new endpoint must go through the facade (/api-gw/v1/proxy + GW_KEY) -- the old 0.1.1
          // wiring of prefix:/api + key_ref:'' gets 401 from host.describe on probe (the same as the
          // container sample config for the brain/personal).
          prefix: '/api-gw/v1/proxy',
          key_ref: spec.keyRef,
          sandbox_base: spec.sandboxBase,
          sandbox_key_ref: spec.keyRef,
          spawn: spec.spawnYaml,
        })
        if (spec.agentSpec !== null) {
          doc.setIn(['agents', spec.agentSpec.id], {
            name: spec.agentSpec.name,
            endpoint: spec.name,
            workspace: spec.agentSpec.workspace,
            public: false,
            preset: spec.agentSpec.preset,
            sandbox_mode: spec.agentSpec.sandboxMode,
          })
        }
      },
    )
  })
  return { envSnap, yamlSnap }
}

/** Pipeline step 4: hot-load the workspace into the in-memory config (byte-identical in both branches). */
const hotLoadAgent = (config: AppConfig, endpointId: string, agentSpec: NewAgentSpec | null): void => {
  if (agentSpec === null) return
  config.agents[agentSpec.id] = {
    id: agentSpec.id,
    name: agentSpec.name,
    endpoint: endpointId,
    workspacePath: agentSpec.workspace,
    public: false,
    preset: agentSpec.preset,
    sandboxMode: agentSpec.sandboxMode,
    gitRemote: null,
    provider: null,
    model: null,
    validate: null,
  }
}

/**
 * Debt B1: node dependency install moved to the background -- the old code ran a synchronous
 * execFileSync(npx pnpm@9 install, whose own comment admitted "usually tens of seconds") inside
 * the request handler, freezing the whole site (SSE relay/cron/probing/login) on Node's single
 * thread. This function uses an async spawn: the request path no longer waits, and the caller
 * wires up install completion/failure. spawnImpl is injectable (tests pass a fake spawn, no network).
 */
export const installNodeDepsAsync = (
  dir: string,
  dshVersion?: string,
  spawnImpl: typeof spawn = spawn,
): Promise<void> => {
  const { cmd, args } = profileInstallCommand(process.platform, dshVersion)
  return new Promise((resolve, reject) => {
    const child = spawnImpl(cmd, [...args, '--prefer-offline'], { cwd: dir, shell: true, stdio: 'inherit' })
    child.on('error', (error: Error) => reject(error))
    child.on('exit', (code: number | null) => {
      if (code === 0) resolve()
      else reject(new Error(`dependency install failed (exit ${code ?? 'unknown'}) in ${dir}`))
    })
  })
}
const nodeNameSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,30}$/, 'a node name may contain lowercase letters, digits, underscore and hyphen only')
const provisionBody = z.object({
  name: nodeNameSchema,
  port: z.number().int().positive().optional(),
  /** Tests and offline environments: skip pnpm install. */
  install: z.boolean().optional(),
  /**
   * Capability one (2026-09-20): explicit node-form selection. Default = auto-detect (a docker
   * runner endpoint in the deployment → container worker; otherwise a host process). Explicit
   * process = a whole-machine-capability host node (yellow-text warning + audit node_create_host).
   */
  runner: z.enum(['docker', 'process']).optional(),
  /**
   * Capability four (Fleet M1-7): build this node onto a named agent (the remote host-process form).
   * Mutually exclusive with runner=docker; when it is given, the agent branch runs (profile/deps are
   * done on the agent side, and the manager does no local profile/install).
   */
  host: z.string().min(1).optional(),
  /** Remote facade address of an agent node (for the manager's probe, e.g. http://10.0.0.7:3081). */
  url: z.string().url().optional(),
  /** Capability two: pin the DSH version per node (must be in the SUPPORTED_DSH matrix; a pending pair warns in yellow text). */
  dsh_version: z.string().min(1).optional(),
  /**
   * The wizard always carries an agent (a node = an agent node, and creating it configures a
   * workspace); every field may be omitted -- the default is id/name = the node name and
   * path ~/.dac/workspaces/<node name>.
   */
  agent: z
    .object({
      id: nodeNameSchema.optional(),
      name: z.string().min(1).max(80).optional(),
      workspace: z.string().optional(),
      preset: z.string().optional(),
      // Fleet M3-1: the third tier for ops nodes (whole-machine capability; the facade backstops the approval card).
      sandboxMode: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
    })
    .optional(),
})

const userHome = (): string => process.env.USERPROFILE ?? process.env.HOME ?? '.'
/** Root of the node directories; tests can override it with DSH_DAC_NODES_HOME. */
const nodesHome = (): string => process.env.DSH_DAC_NODES_HOME ?? `${userHome()}/.dac`

const usedPorts = (config: AppConfig): Set<number> => {
  const ports = new Set<number>([config.listen.port])
  for (const ep of Object.values(config.endpoints)) {
    try {
      ports.add(Number(new URL(ep.url).port))
    } catch {
      // a url that does not parse takes no part in the port-taken check
    }
  }
  return ports
}

const suggestPort = (config: AppConfig): number => {
  const used = usedPorts(config)
  let port = 3090
  while (used.has(port)) port += 1
  return port
}

/** The spawn spec of a new node (one-to-one with the values written into yaml, used for the hot reload). */
const spawnFor = (dshBin: string, name: string, nodeHomePath: string, pins?: { dshVersion?: string; gatewayRef?: string }): ResolvedSpawnSpec => ({
  managed: true,
  command: 'node',
  args: [dshBin, '--profile', name, '--no-open'],
  cwd: null,
  readyTimeoutMs: 30_000,
  detached: false,
  logFile: null,
  env: { DSH_HOME: nodeHomePath },
  restart: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 30_000 },
  runner: 'process',
  host: null,
  docker: null,
  // Capability two: pin the version per node (no explicit pin = the field is not written, following the global default)
  ...(pins?.dshVersion === undefined ? {} : { dshVersion: pins.dshVersion }),
  ...(pins?.gatewayRef === undefined ? {} : { gatewayRef: pins.gatewayRef }),
})

interface ProvisionDeps {
  db: Db
  supervisors: Map<string, NodeSupervisor>
  clients: Map<string, GatewayClient>
  upstreamClients: Map<string, SessionDriver>
  /** Hive plan 2 P6: needed when adding a node in container mode (docker runner wiring). */
  docker?: DockerRunner
  /** Capability four (M1-7): needed when creating an agent node (makeSupervisor's agent runner trio + fleet). */
  agentCommand?: (agentId: string, type: string, payload: unknown) => number
  agentResult?: (commandId: number, cb: (ok: boolean) => void) => () => void
  agentLog?: (agentId: string, nodeId: string) => string
  fleetDoc?: () => string
}

/**
 * Container mode: derive the host workspace prefix from the host_volumes of an existing
 * docker endpoint (install.sh already pins the host path to a real absolute path); new nodes reuse the same prefix.
 */
const deriveHostWorkspacePath = (config: AppConfig, nodeId: string, workspacePath: string | undefined): string => {
  const containerPath = workspacePath ?? `/opt/dac/workspaces/${nodeId}`
  for (const ep of Object.values(config.endpoints)) {
    if (ep.spawn?.runner !== 'docker' || ep.spawn.docker === null) continue
    for (const [host, mounted] of Object.entries(ep.spawn.docker.hostVolumes)) {
      if (mounted.startsWith('/opt/dac/workspaces/')) {
        const tail = mounted.slice(mounted.lastIndexOf('/'))
        if (host.endsWith(tail)) return host.slice(0, -tail.length) + '/' + nodeId
        return host
      }
    }
  }
  // Fallback: the same path string (it may not exist on the host -- workspaceWarning tells the user)
  return containerPath
}

export const registerProvisionRoutes = (
  app: FastifyInstance,
  config: AppConfig,
  requireUser: preHandlerHookHandler,
  deps: ProvisionDeps,
): void => {
  const { db, supervisors, upstreamClients } = deps
  // Debt A5: the truth-source paths come from the loadConfig result (a single source); test literals that omit them fall back to cwd-relative
  const configPath = config.configPath ?? resolve(CONFIG_PATH)
  const envPath = config.envPath ?? resolve(ENV_PATH)

  // Debt R9: derived state (the DB mirror / fleet.md / node lifecycle) all converges through reconcile;
  // provision only changes the truth source (config files) + hot-loads memory. onlyNodes is scoped:
  // - an empty set = touch no node this round (the mirror and fleet still run);
  // - {new node} = bring up the new node only -- never let a hot change drag up other cold nodes the user stopped by hand.
  // removeStaleAgents=false: after a hot delete the agent row survives for the life of the process (billing/audit FK).
  // sweepIdle=false: reclaiming idle outward conversations belongs to the periodic tick, not to a
  // provision action (adding a node must not archive somebody's conversation as a side effect).
  const reconcile = (onlyNodes: Set<string>): Promise<void> =>
    reconcileAll(
      { db, config, supervisors, docker: deps.docker ?? null, log: (line) => app.log.info(line) },
      { onlyNodes, removeStaleAgents: false, sweepIdle: false },
    )

  app.post<{ Body: unknown }>('/api/nodes', { preHandler: requireUser, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const parsed = provisionBody.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', detail: parsed.error.issues.map((i) => i.message) })
    }
    const body = parsed.data

    if (config.endpoints[body.name] !== undefined) {
      return reply.code(409).send({ error: 'duplicate_node', detail: `node ${body.name} already exists` })
    }
    // Normalize the workspace spec: every default is derived from the node name (the same as the wizard shows).
    // Capability one (2026-09-20): form decision = an explicit runner overrides auto-detect (a docker
    // runner endpoint in the deployment → container worker; otherwise a host process). Explicit process = whole-machine capability.
    const dockerMode = Object.values(config.endpoints).some((e) => e.spawn?.runner === 'docker')
    const wantDocker = body.runner === 'docker' || (body.runner === undefined && dockerMode)
    const wantProcess = body.runner === 'process' || (body.runner === undefined && !dockerMode)
    // Explicitly picking docker while the deployment has no docker.sock = a user misconfiguration, refused loudly;
    // the auto-detected docker branch is untouched (the decision semantics of existing deployments do not change).
    if (body.runner === 'docker' && deps.docker === undefined) {
      return reply.code(400).send({ error: 'docker_unavailable', detail: 'this deployment has no docker runner (the manager has no docker.sock mounted) — pick the host-process runtime' })
    }
    // A container-form deployment does not support host-process nodes (measured in production: the manager runs in a
    // container, cannot spawn host processes, and the container image has no global DSH bin -- a user picking
    // process gets the misleading "cannot find bin.js" error). The test is the deployment-form marker baked
    // into the image (images/manager/Dockerfile ENV DAC_DEPLOY_FORM=container); bare-metal deployments
    // (including hybrid ones that mount docker.sock) have no marker, so an explicit process passes as before.
    if (body.runner === 'process' && process.env.DAC_DEPLOY_FORM === 'container') {
      return reply.code(400).send({ error: 'host_process_unavailable', detail: 'a container deployment cannot host a host-process node (the manager runs in a container and cannot spawn host processes) — pick the container runtime' })
    }
    // Capability four (Fleet M1-7): a machine selected = the agent remote host-process form; mutually
    // exclusive with docker, and it must give a facade address the manager can reach (the probe truth source).
    const wantAgent = body.host !== undefined
    if (wantAgent && body.runner === 'docker') {
      return reply.code(400).send({ error: 'host_conflict', detail: 'a machine was selected, so the container runtime is unavailable — agent nodes are remote host processes' })
    }
    if (wantAgent && body.url === undefined) {
      return reply.code(400).send({ error: 'agent_url_required', detail: 'an agent node needs url (a facade address the manager can reach, e.g. http://10.0.0.7:3081)' })
    }
    // Capability two: pin the DSH version per node -- resolve it in the matrix and warn in yellow text when pending; an unknown version is refused loudly.
    const pinnedDsh = body.dsh_version
    const pair = pinnedDsh === undefined ? null : resolvePair(pinnedDsh)
    if (pinnedDsh !== undefined && pair === null) {
      return reply.code(400).send({ error: 'unknown_dsh_version', detail: `DSH version ${pinnedDsh} is not in SUPPORTED_DSH (supported: ${SUPPORTED_DSH.map((p) => p.dsh).join(' / ')})` })
    }
    const dshVersion = pair?.dsh ?? defaultDshVersion()
    const gatewayRef = pair?.gateway ?? GATEWAY_REF
    const versionWarning = pair !== null && pair.status === 'pending'
    const workspaceDefault = wantProcess
      ? join(nodesHome(), 'workspaces', body.name)
      : `/opt/dac/workspaces/${body.name}`
    const agentSpec =
      body.agent === undefined
        ? null
        : {
            id: body.agent.id ?? body.name,
            name: body.agent.name ?? body.name,
            // Fleet M2: a machine selected = a workspace path on the remote machine -- passed through
            // verbatim (on Windows resolve() turns /root/... into C:\root\..., and the facade refuses
            // a non-absolute cwd; a real cross-machine pitfall).
            workspace: wantAgent
              ? body.agent.workspace ?? workspaceDefault
              : resolve(body.agent.workspace ?? workspaceDefault),
            preset: body.agent.preset ?? 'standard',
            sandboxMode: body.agent.sandboxMode ?? 'workspace-write',
          }
    if (agentSpec !== null && config.agents[agentSpec.id] !== undefined) {
      return reply.code(409).send({ error: 'duplicate_agent', detail: `workspace "${agentSpec.id}" already exists` })
    }
    const port = body.port ?? suggestPort(config)
    if (usedPorts(config).has(port)) {
      return reply.code(409).send({ error: 'port_taken', detail: `port ${port} is already taken (by the manager or an existing node)` })
    }

    const nodeHomePath = join(nodesHome(), body.name)
    const keyRef = `GW_KEY_${body.name.toUpperCase()}`
    let createdHome: string | null = null
    // Debt H2: the rollback ledger -- side effects advance in the order prepare → DB → truth file → memory
    // → process, recording one step at a time; on failure they are undone in the reverse order, never leaving
    // a half-provisioned ghost node. envSnap has three states: undefined = mergeEnv never ran (.env was not
    // touched by this request); null = the file did not exist at that point (this request created it, so the
    // rollback removes it); string = the pre-write snapshot.
    let dbRowInserted = false
    let envSnap: string | null | undefined
    let yamlSnap: string | null = null
    let supervisorStarted: NodeSupervisor | null = null
    // Debt B1: after a rollback, a background install that finishes later must not start the node (leak prevention)
    let rolledBack = false

    try {
      // Hive plan 2 P6: the container-mode branch -- a node = a docker runner worker (image + named
      // volume + network alias), with no DSH bin lookup and no profile/pnpm (zero install at runtime).
      // Capability one: wantDocker covers an explicit runner=docker override.
      if (wantDocker) {
        const key = 'apigw-' + randomBytes(24).toString('hex')

        // Pipeline 1: workspace
        const workspaceWarning = prepareWorkspace(agentSpec)

        // Host-side workspace path: derive the prefix from the host_volumes of an existing docker
        // endpoint (install.sh already pins the sample host path to the real one; the same prefix is copied here).
        const hostKey = deriveHostWorkspacePath(config, body.name, agentSpec?.workspace)

        const dockerSpec = {
          // Capability two: an explicit pin = the image tag follows the version convention hellodac/dac-node:<version>; the default follows .env DSH_NODE_IMAGE
          image: pinnedDsh === undefined ? (process.env.DSH_NODE_IMAGE ?? `hellodac/dac-node:${defaultDshVersion()}`) : `hellodac/dac-node:${dshVersion}`,
          network: 'dac-hive',
          port,
          host_volumes: { [hostKey]: agentSpec?.workspace ?? workspaceDefault },
          named_volumes: { [`dac-${body.name}`]: '/data' },
        }

        // Pipeline 2: DB first (Debt H2/R9)
        dbRowInserted = markDbFirst(db, agentSpec)
        recordAudit(db, { actor: request.currentUser?.username ?? 'unknown', kind: 'node_create', detail: `node ${body.name} (docker node, port ${port}, workspace ${agentSpec?.workspace ?? '—'})` })

        // Pipeline 3: the truth file (with a snapshot, restorable on failure; Debt A3 atomic write + R6 lock entry)
        const snaps = await writeNodeTruth(
          { envPath, configPath },
          {
            keyRef,
            key,
            name: body.name,
            url: `http://node-${body.name}:${port}`,
            sandboxBase: `http://node-${body.name}:${port}/api-gw/v1`,
            agentSpec,
            spawnYaml: {
              managed: true,
              runner: 'docker',
              // Incident regression (2026-09-26 compose-e2e red): do not write `host: null`.
              // spawnSchema's host only accepts a string or omission (refine additionally requires
              // host === undefined for docker), and null makes the truth file unreadable -- restart/backup/
              // restore all fail in a chain. The parsed in-memory form already has host = null, so the file
              // only needs the field **omitted**.
              ready_timeout_ms: 30_000,
              docker: dockerSpec,
              // Capability two: only an explicit pin is written to the truth source (the default follows the global default and is not frozen)
              ...(pinnedDsh === undefined ? {} : { dsh_version: dshVersion, gateway_ref: gatewayRef }),
            },
          },
        )
        envSnap = snaps.envSnap
        yamlSnap = snaps.yamlSnap

        const spawn: ResolvedSpawnSpec = {
          managed: true,
          command: '',
          args: [],
          cwd: null,
          readyTimeoutMs: 30_000,
          detached: false,
          logFile: null,
          env: {},
          restart: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 30_000 },
          runner: 'docker',
          host: null,
          docker: {
            image: dockerSpec.image,
            containerName: null,
            network: dockerSpec.network,
            port,
            hostVolumes: dockerSpec.host_volumes,
            namedVolumes: dockerSpec.named_volumes,
          },
          // Capability two: attached only when explicitly pinned (the default follows the global default)
          ...(pinnedDsh === undefined ? {} : { dshVersion, gatewayRef }),
        }
        const endpoint: ResolvedEndpoint = {
          id: body.name,
          url: `http://node-${body.name}:${port}`,
          driver: 'apiproxy',
          // The 0.1.2 facade main path (the same value writeNodeTruth persists above; the old /api + empty key gets 401 on probe)
          prefix: '/api-gw/v1/proxy',
          key,
          sandboxBase: `http://node-${body.name}:${port}/api-gw/v1`,
          sandboxKey: key,
          spawn,
          // Capability three v1: a new node has no tunnel metadata by default (nothing configured in the wizard = no "open native GUI")
          access: null,
        }
        config.endpoints[body.name] = endpoint
        const fresh = buildUpstreamClients({ [body.name]: endpoint })
        const upstream = fresh.get(body.name)
        if (upstream !== undefined) upstreamClients.set(body.name, upstream)
        const supervisor = makeSupervisor(endpoint, {
          upstream: (id) => upstreamClients.get(id),
          gateway: () => deps.clients.get(body.name),
          log: (line) => app.log.info(line),
          ...(deps.docker === undefined ? {} : { docker: deps.docker }),
        })
        supervisors.set(body.name, supervisor)
        // Debt R9: bringing the node up belongs to reconcile (convergeNodes claims/re-pulls the docker
        // runner); here we only record it in the ledger so the rollback can stop it.
        supervisorStarted = supervisor

        // Pipeline 4: hot-load the agent into the in-memory config
        hotLoadAgent(config, body.name, agentSpec)

        // Debt R9: derived state all goes through reconcile -- the mirror/fleet run immediately, and
        // the node comes up through convergeNodes (the docker branch has no install delay).
        await reconcile(new Set([body.name]))
        return reply.code(201).send({
          node: { id: body.name, port, home: `dac-${body.name}` },
          workspace: agentSpec === null ? null : { id: agentSpec.id, path: agentSpec.workspace },
          workspaceWarning,
          ...(versionWarning ? { versionWarning: true } : {}),
        })
      }

      // Capability four (M1-7): the agent remote host-process branch -- no local bin lookup and no local
      // profile/install (the agent side does it with the spawn payload); the truth source writes runner=agent + host.
      if (wantAgent) {
        const key = 'apigw-' + randomBytes(24).toString('hex')
        const agentUrl = (body.url as string).replace(/\/+$/, '')
        // The workspace is remote (on the node's own machine) -- prepareWorkspace does not run locally; the
        // user gives the path (the wizard says "a path on the remote machine"), and the agent uses it as the chat cwd.
        const workspaceWarning = null

        dbRowInserted = markDbFirst(db, agentSpec)
        recordAudit(db, {
          actor: request.currentUser?.username ?? 'unknown',
          kind: 'node_create_host',
          detail: `node ${body.name} (agent remote host process, host=${body.host}, port ${port}, workspace ${agentSpec?.workspace ?? '—'})`,
        })

        const snaps = await writeNodeTruth(
          { envPath, configPath },
          {
            keyRef,
            key,
            name: body.name,
            url: agentUrl,
            sandboxBase: `${agentUrl}/api-gw/v1`,
            agentSpec,
            spawnYaml: {
              managed: true,
              runner: 'agent',
              host: body.host,
              args: ['--profile', body.name, '--port', String(port), '--no-open'],
              // Proven in the M1 pilot: an agent's first remote start = dependency install + a full DSH
              // boot, measured at 40-90s before it listens -- a 30s readiness window kills the restart chain
              // by mistake, so it is relaxed to 120s.
              ready_timeout_ms: 120_000,
              ...(pinnedDsh === undefined ? {} : { dsh_version: dshVersion, gateway_ref: gatewayRef }),
            },
          },
        )
        envSnap = snaps.envSnap
        yamlSnap = snaps.yamlSnap

        const endpoint: ResolvedEndpoint = {
          id: body.name,
          url: agentUrl,
          driver: 'apiproxy',
          prefix: '/api-gw/v1/proxy',
          key,
          sandboxBase: `${agentUrl}/api-gw/v1`,
          sandboxKey: key,
          spawn: {
            managed: true,
            command: '',
            args: ['--profile', body.name, '--port', String(port), '--no-open'],
            cwd: null,
            // Proven in the M1 pilot: an agent's first remote start takes 40-90s, so a 30s readiness window misfires (the same source as yaml)
            readyTimeoutMs: 120_000,
            detached: false,
            logFile: null,
            env: {},
            restart: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 30_000 },
            runner: 'agent',
            host: body.host ?? null,
            docker: null,
            ...(pinnedDsh === undefined ? {} : { dshVersion, gatewayRef }),
          },
          access: null,
        }
        config.endpoints[body.name] = endpoint
        const fresh = buildUpstreamClients({ [body.name]: endpoint })
        const upstream = fresh.get(body.name)
        if (upstream !== undefined) upstreamClients.set(body.name, upstream)
        const supervisor = makeSupervisor(endpoint, {
          upstream: (id) => upstreamClients.get(id),
          gateway: () => deps.clients.get(body.name),
          log: (line) => app.log.info(line),
          ...(deps.docker === undefined ? {} : { docker: deps.docker }),
          ...(deps.agentCommand === undefined ? {} : { agentCommand: deps.agentCommand }),
          ...(deps.agentResult === undefined ? {} : { agentResult: deps.agentResult }),
          ...(deps.agentLog === undefined ? {} : { agentLog: deps.agentLog }),
          ...(deps.fleetDoc === undefined ? {} : { fleetDoc: deps.fleetDoc }),
          // Fleet M3: an ops node (danger-full-access) → the spawn payload carries the unlock signal
          ...(body.agent?.sandboxMode === 'danger-full-access' ? { agentFullAccess: true } : {}),
        })
        supervisors.set(body.name, supervisor)
        supervisorStarted = supervisor
        hotLoadAgent(config, body.name, agentSpec)
        await reconcile(new Set([body.name]))
        return reply.code(201).send({
          node: { id: body.name, port, home: `<agentDir>/nodes/${body.name}` },
          workspace: agentSpec === null ? null : { id: agentSpec.id, path: agentSpec.workspace },
          workspaceWarning,
          ...(versionWarning ? { versionWarning: true } : {}),
        })
      }

      const dshBin = detectDshBin(join(userHome(), '.dsh'), null)

      // 1. The node trio: profile → credentials → gateway secret (the file layer)
      // Capability two: the profile is generated per node pin (dshVersion/gatewayRef come from the matrix pair).
      ensureNodeProfiles(nodesHome(), [{ name: body.name, port }], gatewayRef, dshVersion)
      createdHome = nodeHomePath
      ensureNodeCredentials(join(userHome(), '.dsh'), nodeHomePath)
      // 0.2.0 corridor (dsh-facts §18.5): the placement is version-gated -- the new lines materialize
      // the key in the profile's cordis.patch.yml (settings.yaml is a one-shot import there).
      const key = resolveGatewayKey(nodeHomePath, null, { dshVersion, profileName: body.name })

      // 2. Dependency install (Debt B1: backgrounded -- the tens-of-seconds synchronous pnpm no longer
      // freezes the whole site). The 201 returns first and the node is started only once install finishes;
      // failure = an audit trail + start anyway (a node without deps crashes, the supervisor state machine
      // goes visibly offline, and the error stays visible).
      const installDir = join(nodeHomePath, 'profiles', body.name)
      const installPromise: Promise<void> = body.install !== false ? installNodeDepsAsync(installDir, dshVersion) : Promise.resolve()

      // Pipeline 1: workspace (directory + git init + the generic AGENTS.md; files are the truth, and only running leaves an audit trail)
      const workspaceWarning = prepareWorkspace(agentSpec)

      // Pipeline 2: DB first (Debt H2/R9)
      dbRowInserted = markDbFirst(db, agentSpec)
      // Hive plan 2 P3: the audit trail (node creation). Capability one: the explicit host-process form
      // uses node_create_host (a whole-machine-capability risk surface, the same-source trail as the yellow-text warning).
      recordAudit(db, {
        actor: request.currentUser?.username ?? 'unknown',
        kind: body.runner === 'process' ? 'node_create_host' : 'node_create',
        detail: `node ${body.name} (${body.runner === 'process' ? 'host process' : 'process'}, port ${port}, workspace ${agentSpec?.workspace ?? '—'})`,
      })

      // Pipeline 3: the truth file (with a snapshot, restorable on failure; Debt A3 atomic write + R6 lock entry)
      const snaps = await writeNodeTruth(
        { envPath, configPath },
        {
          keyRef,
          key,
          name: body.name,
          url: `http://127.0.0.1:${port}`,
          sandboxBase: `http://127.0.0.1:${port}/api-gw/v1`,
          agentSpec,
          spawnYaml: {
            managed: true,
            command: 'node',
            args: [dshBin, '--profile', body.name, '--no-open'],
            ready_timeout_ms: 30_000,
            env: { DSH_HOME: nodeHomePath },
            // Capability two: only an explicit pin is written into the truth source (the default follows the global default and is not frozen)
            ...(pinnedDsh === undefined ? {} : { dsh_version: dshVersion, gateway_ref: gatewayRef }),
          },
        },
      )
      envSnap = snaps.envSnap
      yamlSnap = snaps.yamlSnap

      // Hot reload: the endpoint + workspace go into the in-memory config, and the supervisor is registered and started
      const endpoint: ResolvedEndpoint = {
        id: body.name,
        url: `http://127.0.0.1:${port}`,
        driver: 'apiproxy',
        // The 0.1.2 facade main path (the same value writeNodeTruth persists; the old /api + empty key gets 401 on probe)
        prefix: '/api-gw/v1/proxy',
        key,
        sandboxBase: `http://127.0.0.1:${port}/api-gw/v1`,
        sandboxKey: key,
        spawn: spawnFor(dshBin, body.name, nodeHomePath, pinnedDsh === undefined ? undefined : { dshVersion, gatewayRef }),
        // Capability three v1: a new node has no tunnel metadata by default
        access: null,
      }
      config.endpoints[body.name] = endpoint
      const fresh = buildUpstreamClients({ [body.name]: endpoint })
      const upstream = fresh.get(body.name)
      if (upstream !== undefined) upstreamClients.set(body.name, upstream)

      const supervisor = makeSupervisor(endpoint, {
        upstream: (id) => upstreamClients.get(id),
        gateway: () => deps.clients.get(body.name),
        log: (line) => app.log.info(line),
      })
      supervisors.set(body.name, supervisor)
      // Debt B1: starting is deferred until the dependency install finishes (the 201 returns first, so the
      // request path no longer waits for install). A late install completion after a rollback must never
      // start the node (rolledBack prevents the leak).
      // Capability one: after install, prefer the dsh bin installed in isolation inside the profile (no
      // dependency on a global one); if it did not install (offline/failure), fall back to the global bin (the legacy-compatible path).
      const startAfterInstall = (): void => {
        if (rolledBack) return
        const isolatedBin = dshBinInProfile(installDir)
        if (isolatedBin !== null) {
          endpoint.spawn = spawnFor(isolatedBin, body.name, nodeHomePath, pinnedDsh === undefined ? undefined : { dshVersion, gatewayRef })
        }
        supervisorStarted = supervisor
        // Debt R9: starting a node goes through reconcile too (the single entry point), not supervisor.start directly.
        void reconcile(new Set([body.name])).catch((error: unknown) => {
          app.log.error(`node ${body.name}: reconcile after install failed: ${error instanceof Error ? error.message : String(error)}`)
        })
      }
      installPromise.then(startAfterInstall).catch((installError: unknown) => {
        if (rolledBack) return
        const message = installError instanceof Error ? installError.message : String(installError)
        recordAudit(db, { actor: request.currentUser?.username ?? 'unknown', kind: 'node_create', detail: `failed: dependency install for node ${body.name} failed: ${message}` })
        app.log.error(`node ${body.name}: dependency install failed: ${message}`)
        startAfterInstall() // still start: a node without deps crashes, and the supervisor state machine goes visibly offline
      })

      // Pipeline 4: hot-load the agent into the in-memory config
      hotLoadAgent(config, body.name, agentSpec)

      // Debt R9: derived state all goes through reconcile -- the mirror/fleet run immediately; starting
      // the node is deferred until the dependency install finishes (the reconcile inside startAfterInstall, see above).
      await reconcile(new Set())
      return reply.code(201).send({
        node: { id: body.name, port, home: nodeHomePath, state: supervisor.current.state },
        workspace: agentSpec === null ? null : { id: agentSpec.id, path: agentSpec.workspace },
        workspaceWarning,
        ...(versionWarning ? { versionWarning: true } : {}),
      })
    } catch (error) {
      // Debt H2: full rollback -- undo the completed steps in reverse, never leaving a half-provisioned ghost node.
      rolledBack = true
      if (supervisorStarted !== null) {
        try {
          supervisorStarted.stop()
        } catch {
          // a failed process/container stop does not block the remaining rollback steps
        }
        supervisors.delete(body.name)
      }
      if (config.endpoints[body.name] !== undefined) {
        delete config.endpoints[body.name]
        upstreamClients.delete(body.name)
      }
      if (agentSpec !== null && config.agents[agentSpec.id] !== undefined) delete config.agents[agentSpec.id]
      if (dbRowInserted && agentSpec !== null) {
        try {
          removeAgentRow(db, agentSpec.id)
        } catch {
          // the DB itself may already be unavailable -- this does not block the rest of the rollback
        }
      }
      if (yamlSnap !== null) {
        try {
          writeFileAtomic(configPath, yamlSnap)
        } catch (rollbackError) {
          app.log.warn(`provision rollback: restore config failed: ${(rollbackError as Error).message}`)
        }
      }
      if (envSnap !== undefined) {
        if (envSnap === null) {
          // .env did not exist before this request: mergeEnv created it with only this node's key, so remove it outright.
          try {
            rmSync(envPath, { force: true })
          } catch {
            // failing to delete it affects housekeeping only, never correctness
          }
        } else {
          try {
            writeFileAtomic(envPath, envSnap, 0o600)
          } catch (rollbackError) {
            app.log.warn(`provision rollback: restore .env failed: ${(rollbackError as Error).message}`)
          }
        }
      }
      if (createdHome !== null) {
        try {
          rmSync(createdHome, { recursive: true, force: true })
        } catch {
          // a leftover directory is converged by the next boot's reconcile
        }
      }
      // Debt R9: re-run convergence after the rollback -- re-mirror and re-sync the fleet from the restored
      // truth source (fleet.md keeps no entry for the failed node; the agent row returns to its old value).
      try {
        await reconcile(new Set())
      } catch (rollbackError) {
        app.log.warn(`provision rollback: reconcile failed: ${(rollbackError as Error).message}`)
      }
      try {
        recordAudit(db, { actor: request.currentUser?.username ?? 'unknown', kind: 'node_create', detail: `failed: ${(error as Error).message}` })
      } catch {
        // a failed audit does not affect the rollback result
      }
      app.log.error(`provision node ${body.name} failed (rolled back): ${(error as Error).message}`)
      return reply.code(500).send({ error: 'provision_failed', detail: (error as Error).message })
    }
  })

  /**
   * Decided 2026-09-05: deleting a node = stop the process + delete the two config lines (the node +
   * the workspace bound to it), keeping every directory on disk. The front-end confirm box spells out the semantics.
   */
  app.delete<{ Params: { id: string } }>('/api/nodes/:id', { preHandler: requireUser, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const endpoint = config.endpoints[request.params.id]
    if (endpoint === undefined) return reply.code(404).send({ error: 'unknown_node' })
    if (endpoint.spawn === null || !supervisors.has(request.params.id)) {
      return reply.code(409).send({ error: 'not_managed', detail: `node ${request.params.id} is managed outside the manager, so it cannot be deleted here` })
    }

    const bound = Object.values(config.agents).filter((a) => a.endpoint === request.params.id)

    // Debt E10: line 569 already checks supervisors.has, so this narrows explicitly instead of using `!`
    const supervisor = supervisors.get(request.params.id)
    if (supervisor === undefined) return reply.code(409).send({ error: 'not_managed' })
    supervisor.stop()
    supervisors.delete(request.params.id)
    delete config.endpoints[request.params.id]
    for (const a of bound) delete config.agents[a.id]

    // Debt A3: deletion also goes through an atomic write (syntax validation, against on-disk corruption); Debt R6: the single lock entry
    await withConfigLock(() =>
      mutateYamlFile(
        configPath,
        (doc) => {
          doc.deleteIn(['endpoints', request.params.id])
          for (const a of bound) doc.deleteIn(['agents', a.id])
        },
      ),
    )

    app.log.info(
      `node ${request.params.id}: unmanaged (${bound.length} workspace binding(s) removed from config; files on disk kept)`,
    )
    // Hive plan 2 P3: the audit trail (node deletion)
    recordAudit(db, { actor: request.currentUser?.username ?? 'unknown', kind: 'node_delete', detail: `node ${request.params.id} deleted (files on disk are kept)` })
    // Debt R9: mirror and fleet convergence all go through reconcile (an empty node set = the node
    // lifecycle is untouched; removeStaleAgents=false = the agent row survives the process, so billing/audit is not lost).
    await reconcile(new Set())
    return reply.send({ ok: true, removedWorkspaces: bound.map((a) => a.id) })
  })
}
