import { readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import type { AppConfig, ResolvedEndpoint } from '../config.js'
import type { GatewayClient } from '../gateway/client.js'
import type { SessionDriver } from '../session-driver/port.js'
import type { NodeSupervisor } from '../nodes/supervisor.js'
import type { AuditKind } from '../audit.js'
import { mutateYamlFile, withConfigLock } from '../config-store.js'
import { captureGuiToken, guiDirectUrl, guiOpenUrl } from '../gui-token.js'
import { dshBinInProfile, profileDrift, reseedProfile, writeGatewayKeyToPatch } from '../host-node/profile.js'
import { COMPAT_DSH_VERSION, GATEWAY_REF, isLegacyDshLine, resolvePair, SUPPORTED_DSH } from '../dsh-matrix.js'
import { installNodeDepsAsync } from './provision.js'
import { probeEndpoint } from './status.js'

/**
 * Hive P3: the data source for the node (fleet) view.
 *
 * One node = the entity of one endpoint. For a managed node (spawn.managed) the truth is the
 * supervisor state machine (cold/starting/live/restarting/offline); for an unmanaged node it is
 * the probe result (live/offline). The sidebar node section and the future /nodes page share it.
 */
export const registerNodesRoutes = (
  app: FastifyInstance,
  config: AppConfig,
  supervisors: Map<string, NodeSupervisor>,
  clients: Map<string, GatewayClient>,
  upstreamClients: Map<string, SessionDriver>,
  requireUser: preHandlerHookHandler,
  /** Hive plan 2 P3: audit callback for node actions (injected by the wiring layer, optional in tests). */
  audit?: (actor: string, kind: AuditKind, detail: string) => void,
  /** Capability two: the dependency installer for the align route (a fake in tests; default = a real npm install). */
  installDeps: (dir: string, dshVersion?: string) => Promise<void> = (dir, version) => installNodeDepsAsync(dir, version),
): void => {
  /**
   * Capability two: a process node's configured pin (explicit value beats the matrix default) and
   * its profile directory. A container node returns null (a version change = a new image tag, out of scope here).
   */
  const pinnedOf = (ep: ResolvedEndpoint): { version: string; gatewayRef: string; profileDir: string | null } => {
    const version = ep.spawn?.dshVersion ?? COMPAT_DSH_VERSION
    const gatewayRef = ep.spawn?.gatewayRef ?? (resolvePair(version)?.gateway ?? GATEWAY_REF)
    const dshHome = ep.spawn?.env['DSH_HOME']
    // The profile directory name is the one --profile names in spawn.args (the endpoint id is only
    // a config key; in production id 'personal' met profile 'dac-personal', so building the path from
    // the id re-seeded a ghost directory and the real node never moved); no --profile = the endpoint id.
    const args = ep.spawn?.args ?? []
    const profileIdx = args.indexOf('--profile')
    const rawProfile = profileIdx >= 0 ? args[profileIdx + 1] : undefined
    const profileName = typeof rawProfile === 'string' ? rawProfile : ep.id
    const profileDir = dshHome === undefined || dshHome === '' ? null : join(dshHome, 'profiles', profileName)
    return { version, gatewayRef, profileDir }
  }
  const driftOf = (ep: ResolvedEndpoint): boolean => {
    if (ep.spawn === null || ep.spawn.runner !== 'process') return false
    const { version, gatewayRef, profileDir } = pinnedOf(ep)
    return profileDir !== null && profileDrift(profileDir, version, gatewayRef)
  }
  app.get('/api/nodes', { preHandler: requireUser }, async () => {
    // Capability three v1: capture the GUI token from the log per node and build the open URL --
    // the log is read on every request, so a restart that rotates the token is followed for free.
    const isLoopbackBase = (urlStr: string): boolean => {
      try {
        const host = new URL(urlStr).hostname
        return host === '127.0.0.1' || host === 'localhost' || host === '::1'
      } catch {
        return false
      }
    }
    const guiUrlOf = async (ep: ResolvedEndpoint, supervisor: NodeSupervisor | undefined): Promise<string | null> => {
      let logs = ''
      if (ep.spawn?.logFile !== undefined && ep.spawn.logFile !== null) {
        try {
          logs = readFileSync(ep.spawn.logFile, 'utf8')
        } catch {
          // A failed log read counts as not captured yet
        }
      } else if (supervisor !== undefined) {
        if (ep.spawn?.runner === 'docker') {
          const dockerLogs = await supervisor.dockerLogs()
          if (dockerLogs !== null) logs = dockerLogs
        } else if (ep.spawn?.runner === 'agent') {
          // Capability four: an agent node's log comes back over the event channel (a ring buffer on the manager)
          logs = supervisor.agentLogs()
        } else {
          logs = supervisor.logs()
        }
      }
      const capture = captureGuiToken(logs)
      // access configured = the user chose the tunnel form (open through the local mapped port)
      if (ep.access !== null) return guiOpenUrl(ep.access.localPort, capture)
      // UX nicety: a loopback node needs no tunnel -- the browser is already on loopback, so the real
      // GUI port from the start line works directly (non-loopback without access = no open ability)
      if (isLoopbackBase(ep.url)) return guiDirectUrl(capture)
      return null
    }
    const nodes = await Promise.all(
      Object.keys(config.endpoints).map(async (id) => {
        const agentIds = Object.values(config.agents)
          .filter((a) => a.endpoint === id)
          .map((a) => a.id)
        const ep = config.endpoints[id]
        const supervisor = supervisors.get(id)
        const probe = await probeEndpoint(config, clients, upstreamClients, id)
        const guiUrl = ep === undefined ? null : await guiUrlOf(ep, supervisor)
        if (supervisor !== undefined) {
          const s = supervisor.current
          // Container form: the image tag is the truth of the node's DSH version (tag = version).
          const image = await supervisor.containerImage()
          return {
            id,
            managed: true,
            state: s.state,
            pid: s.pid,
            attempts: s.attempts,
            lastError: s.lastError,
            agents: agentIds,
            dshVersion: probe.dshVersion,
            dshCompatible: probe.dshCompatible,
            // Capability two: the configured pin (null = follow the global default); drift = the profile seed disagrees
            configuredDshVersion: ep?.spawn?.dshVersion ?? null,
            dshDrift: ep === undefined ? false : driftOf(ep),
            // Capability four (M1-7): the agent running this node (null = this machine / a container)
            host: ep?.spawn?.host ?? null,
            ...(image === null ? {} : { image }),
            // Capability three v1: tunnel metadata plus the assembled open URL (unset/not captured = null)
            access: ep?.access ?? null,
            guiUrl,
          }
        }
        return {
          id,
          managed: false,
          state: probe.reachable ? 'live' : 'offline',
          pid: null,
          attempts: 0,
          lastError: probe.reachable ? null : probe.error,
          sessions: probe.sessions,
          agents: agentIds,
          dshVersion: probe.dshVersion,
          dshCompatible: probe.dshCompatible,
          configuredDshVersion: ep?.spawn?.dshVersion ?? null,
          dshDrift: ep === undefined ? false : driftOf(ep),
          host: ep?.spawn?.host ?? null,
          access: ep?.access ?? null,
          guiUrl,
        }
      }),
    )
    // Hive plan 2 P6: the wizard needs the deployment form (a docker runner node has a different default workspace path)
    const dockerMode = Object.values(config.endpoints).some((e) => e.spawn?.runner === 'docker')
    // Capability two: the data source for the wizard's version dropdown (the matrix is the only truth; no version list in the frontend)
    const supportedDsh = SUPPORTED_DSH.map((p) => ({ dsh: p.dsh, status: p.status }))
    // Deployment form marker (image ENV DAC_DEPLOY_FORM): in container form the frontend disables 'host process'
    const containerForm = process.env.DAC_DEPLOY_FORM === 'container'
    // UI wrap-up C-P1.5: local machine info (the data source of the topology's local card and the
    // machine list's local row; the manager host has no node-agent, so the directory lacks it).
    const hostOs = process.platform
    const hostArch = process.arch
    const hostName = hostname()
    const hostNodeVersion = process.version
    return { nodes, dockerMode, supportedDsh, containerForm, hostOs, hostArch, hostName, hostNodeVersion }
  })

  /**
   * Hive P5.1: node control. Only managed nodes (spawn config plus a supervisor entry) can be
   * acted on; an externally managed node is refused politely -- no button where the manager cannot reach.
   */
  type Managed =
    | { kind: 'ok'; supervisor: NodeSupervisor; spawn: NonNullable<AppConfig['endpoints'][string]['spawn']> }
    | { kind: 'unknown' }
    | { kind: 'unmanaged' }

  const managed = (request: { params: { id: string } }): Managed => {
    const ep = config.endpoints[request.params.id]
    if (ep === undefined) return { kind: 'unknown' }
    if (ep.spawn === null) return { kind: 'unmanaged' }
    const supervisor = supervisors.get(request.params.id)
    if (supervisor === undefined) return { kind: 'unmanaged' }
    return { kind: 'ok', supervisor, spawn: ep.spawn }
  }

  app.post<{ Params: { id: string } }>('/api/nodes/:id/up', { preHandler: requireUser, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const target = managed(request)
    if (target.kind === 'unknown') return reply.code(404).send({ error: 'unknown_node' })
    if (target.kind === 'unmanaged') {
      return reply
        .code(409)
        .send({ error: 'not_managed', detail: `node ${request.params.id} is managed outside the manager, so it cannot be started here` })
    }
    target.supervisor.start(target.spawn)
    audit?.(request.currentUser?.username ?? 'unknown', 'node_up', `node ${request.params.id} started`)
    return reply.send({ ok: true, state: target.supervisor.current.state })
  })

  app.post<{ Params: { id: string } }>('/api/nodes/:id/down', { preHandler: requireUser, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const target = managed(request)
    if (target.kind === 'unknown') return reply.code(404).send({ error: 'unknown_node' })
    if (target.kind === 'unmanaged') {
      return reply
        .code(409)
        .send({ error: 'not_managed', detail: `node ${request.params.id} is managed outside the manager, so it cannot be stopped here` })
    }
    target.supervisor.stop()
    audit?.(request.currentUser?.username ?? 'unknown', 'node_down', `node ${request.params.id} stopped`)
    return reply.send({ ok: true, state: target.supervisor.current.state })
  })

  app.post<{ Params: { id: string } }>('/api/nodes/:id/restart', { preHandler: requireUser, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const target = managed(request)
    if (target.kind === 'unknown') return reply.code(404).send({ error: 'unknown_node' })
    if (target.kind === 'unmanaged') {
      return reply
        .code(409)
        .send({ error: 'not_managed', detail: `node ${request.params.id} is managed outside the manager, so it cannot be restarted here` })
    }
    target.supervisor.restart(target.spawn)
    audit?.(request.currentUser?.username ?? 'unknown', 'node_restart', `node ${request.params.id} restarted`)
    return reply.send({ ok: true, state: target.supervisor.current.state })
  })

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/api/nodes/:id/logs',
    { preHandler: requireUser },
    async (request, reply) => {
      const ep = config.endpoints[request.params.id]
      if (ep === undefined) return reply.code(404).send({ error: 'unknown_node' })
      const limit = Math.min(Math.max(Number(request.query.limit ?? 200) || 200, 1), 2000)
      const tail = (text: string): string => text.split(/\r?\n/).slice(-limit).join('\n')

      // A log file (a detached node with log_file) is read from disk; otherwise the supervisor's memory buffer.
      if (ep.spawn?.logFile !== undefined && ep.spawn.logFile !== null) {
        try {
          return reply.send({ logs: tail(readFileSync(ep.spawn.logFile, 'utf8')), source: 'file' })
        } catch (error) {
          // Debt E11: a failed read no longer returns an empty string silently (users read 'no log' as
          // 'the node is not running' when the truth is a permission/IO error) -- log it and return the reason.
          const message = error instanceof Error ? error.message : String(error)
          app.log.warn(`node ${request.params.id}: reading log file failed: ${message}`)
          return reply.send({ logs: '', source: 'file', error: `could not read the log: ${message}` })
        }
      }
      const supervisor = supervisors.get(request.params.id)
      if (supervisor === undefined) {
        return reply.code(409).send({ error: 'not_managed', detail: 'a node managed outside the manager has no log to read' })
      }
      // Hive plan 2 P2b: a docker runner node's log comes from docker logs (the buffer has no process output)
      if (ep.spawn?.runner === 'docker') {
        const dockerLogs = await supervisor.dockerLogs()
        if (dockerLogs !== null) return reply.send({ logs: tail(dockerLogs), source: 'docker' })
      }
      // Capability four: an agent runner's log comes back through the event channel's buffer
      if (ep.spawn?.runner === 'agent') {
        return reply.send({ logs: tail(supervisor.agentLogs()), source: 'agent' })
      }
      return reply.send({ logs: tail(supervisor.logs()), source: 'buffer' })
    },
  )

  /**
   * Capability three v1: SSH tunnel metadata for a node's native GUI (truth = endpoints.<id>.access).
   * clear=true removes the section; otherwise ssh_user/ssh_host/local_port are required and
   * ssh_port/gui_port default to 22/3080. It writes the source of truth (lock + atomic write) and
   * hot-reloads the in-memory config. Red line: the ssh private key never comes through this API.
   */
  const accessBody = z.object({
    clear: z.boolean().optional(),
    ssh_user: z.string().min(1).optional(),
    ssh_host: z.string().min(1).optional(),
    ssh_port: z.number().int().positive().optional(),
    gui_port: z.number().int().positive().optional(),
    local_port: z.number().int().positive().optional(),
    /** UX nicety: private key path on the user's machine (not the key); the command carries -i; default = ssh's own key. */
    ssh_key: z.string().min(1).optional(),
  })

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/nodes/:id/access',
    { preHandler: requireUser, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const ep = config.endpoints[request.params.id]
      if (ep === undefined) return reply.code(404).send({ error: 'unknown_node' })
      const parsed = accessBody.safeParse(request.body)
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', detail: parsed.error.issues.map((i) => i.message) })
      const body = parsed.data
      const configPath = config.configPath ?? resolve('manager.config.yaml')

      try {
        if (body.clear === true) {
          await withConfigLock(() => mutateYamlFile(configPath, (doc) => doc.deleteIn(['endpoints', request.params.id, 'access'])))
          ep.access = null
          audit?.(request.currentUser?.username ?? 'unknown', 'node_access_update', `node ${request.params.id}: native access config removed`)
          return reply.send({ ok: true, access: null })
        }
        const sshUser = body.ssh_user
        const sshHost = body.ssh_host
        const localPort = body.local_port
        if (sshUser === undefined || sshHost === undefined || localPort === undefined) {
          return reply.code(400).send({ error: 'missing_fields', detail: 'ssh_user / ssh_host / local_port are required (clear=true removes the config)' })
        }
        const access = {
          ssh_user: sshUser,
          ssh_host: sshHost,
          ssh_port: body.ssh_port ?? 22,
          gui_port: body.gui_port ?? 3080,
          local_port: localPort,
          ...(body.ssh_key === undefined ? {} : { ssh_key: body.ssh_key }),
        }
        await withConfigLock(() => mutateYamlFile(configPath, (doc) => doc.setIn(['endpoints', request.params.id, 'access'], access)))
        ep.access = {
          sshUser: access.ssh_user,
          sshHost: access.ssh_host,
          sshPort: access.ssh_port,
          guiPort: access.gui_port,
          localPort: access.local_port,
          sshKey: body.ssh_key ?? null,
        }
        audit?.(request.currentUser?.username ?? 'unknown', 'node_access_update', `node ${request.params.id} native access → ${access.ssh_user}@${access.ssh_host}:${access.ssh_port} gui=${access.gui_port} local=${access.local_port}`)
        return reply.send({ ok: true, access: ep.access })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        app.log.error(`node ${request.params.id}: access update failed: ${message}`)
        return reply.code(500).send({ error: 'config_write_failed', detail: message })
      }
    },
  )

  /**
   * P1 (hive/plan-config-version-switch): the shared implementation of a process node's 'change the
   * pin -> re-seed -> reinstall in the background -> restart on the isolated bin' -- used by both
   * align-version (align to the configured pin) and version (explicit switch). The caller sets ep.spawn.dshVersion.
   */
  const alignProcessNode = (
    id: string,
    actor: string,
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
    ep: ResolvedEndpoint,
    supervisor: NodeSupervisor,
    opts: { version: string; gatewayRef: string; auditKind: AuditKind; auditDetail: string },
  ): unknown => {
    const spawn = ep.spawn
    if (spawn === null) return reply.code(409).send({ error: 'not_managed', detail: 'a node managed outside the manager cannot be aligned' })
    const { profileDir } = pinnedOf(ep)
    if (profileDir === null) return reply.code(400).send({ error: 'no_dsh_home', detail: "the node's spawn.env has no DSH_HOME, so its profile directory cannot be located" })

    const port = Number(new URL(ep.url).port || 3080)
    try {
      reseedProfile(profileDir, { name: id, port }, opts.gatewayRef, opts.version)
      // 0.2.0 corridor (dsh-facts §18.5): the reseed rewrote cordis.patch.yml from the generated
      // baseline, so on the new lines (where the patch row IS the durable key path) the facade key
      // must be re-injected here -- an aligned node would otherwise boot with a keyless facade and
      // every manager call would 401. Legacy lines keep their settings.yaml (untouched by the reseed).
      if (!isLegacyDshLine(opts.version)) {
        const key = ep.sandboxKey !== '' ? ep.sandboxKey : ep.key
        if (key !== '') writeGatewayKeyToPatch(profileDir, key)
      }
      audit?.(actor, opts.auditKind, opts.auditDetail)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return reply.code(500).send({ error: 'reseed_failed', detail: message })
    }

    // Reinstall dependencies in the background -> restart either way (a missing dependency crashes to a visible offline, as in provision)
    void installDeps(profileDir, opts.version)
      .then(() => {
        const isolatedBin = dshBinInProfile(profileDir)
        if (isolatedBin !== null) {
          const next = { ...spawn, args: [isolatedBin, ...spawn.args.slice(1)] }
          ep.spawn = next
          supervisor.restart(next)
          return
        }
        supervisor.restart(spawn)
      })
      .catch((error: unknown) => {
        app.log.warn(`node ${id}: align install failed: ${error instanceof Error ? error.message : String(error)}`)
        supervisor.restart(spawn)
      })
    return reply.code(202).send({ ok: true, aligning: true, version: opts.version, gatewayRef: opts.gatewayRef })
  }

  /**
   * Capability two: version alignment -- re-seed a process node's profile to the configured pin
   * (rewrite the dependency list + .seed-version) -> reinstall in the background -> restart on the
   * profile's isolated bin (idempotent). Container node = 409, use /version. Audits node_align_version.
   */
  app.post<{ Params: { id: string } }>(
    '/api/nodes/:id/align-version',
    { preHandler: requireUser, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const ep = config.endpoints[request.params.id]
      if (ep === undefined) return reply.code(404).send({ error: 'unknown_node' })
      const spawn = ep.spawn
      if (spawn === null || spawn.runner !== 'process') {
        return reply.code(409).send({ error: 'not_host_process', detail: 'only host-process nodes support version alignment; for a container node use "switch version" (POST /api/nodes/:id/version)' })
      }
      const supervisor = supervisors.get(request.params.id)
      if (supervisor === undefined) return reply.code(409).send({ error: 'not_managed', detail: 'a node managed outside the manager cannot be aligned' })
      const { version, gatewayRef } = pinnedOf(ep)
      return alignProcessNode(request.params.id, request.currentUser?.username ?? 'unknown', reply, ep, supervisor, {
        version,
        gatewayRef,
        auditKind: 'node_align_version',
        auditDetail: `node ${request.params.id} aligned to DSH ${version} (facade ${gatewayRef})`,
      })
    },
  )

  /**
   * P1 (hive/plan-config-version-switch): switch a node's DSH version -- upgrades with no sed.
   * Two branches: a container rewrites the spawn.docker.image tag and rebuilds at once (triggered by
   * the image id); a process changes the pin and delegates to the align chain (re-seed -> reinstall ->
   * restart). Matrix check, node_version_change audit, and the truth written only on an explicit switch.
   */
  const versionBody = z.object({ dsh_version: z.string().min(1) })
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/nodes/:id/version',
    { preHandler: requireUser, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const id = request.params.id
      const ep = config.endpoints[id]
      if (ep === undefined) return reply.code(404).send({ error: 'unknown_node' })
      const parsed = versionBody.safeParse(request.body)
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', detail: 'dsh_version is required (a version from the support matrix)' })
      const pair = resolvePair(parsed.data.dsh_version)
      if (pair === null) {
        return reply.code(400).send({ error: 'unknown_dsh_version', detail: `DSH version ${parsed.data.dsh_version} is not in the support matrix (supported: ${SUPPORTED_DSH.map((p) => p.dsh).join(' / ')})` })
      }
      const target = pair.dsh
      const spawn = ep.spawn
      if (spawn === null) return reply.code(409).send({ error: 'not_managed', detail: 'a node managed outside the manager cannot switch versions' })
      const supervisor = supervisors.get(id)
      if (supervisor === undefined) return reply.code(409).send({ error: 'not_managed', detail: 'a node managed outside the manager cannot switch versions' })

      const configPath = config.configPath ?? resolve('manager.config.yaml')
      const actor = request.currentUser?.username ?? 'unknown'
      // Source of truth on disk: only an explicit switch writes the dsh_version pin (a node following the matrix writes nothing)
      try {
        await withConfigLock(() => mutateYamlFile(configPath, (doc) => {
          doc.setIn(['endpoints', id, 'spawn', 'dsh_version'], target)
          // 0.2.0 corridor: the paired facade ref is written ALONG the version -- writing the version
          // alone leaves a stale gateway_ref (e.g. the pre-corridor pin) in charge through pinnedOf,
          // and a 0.2.0 node would boot a facade whose answerer pump dies silently (dsh-facts §18.2).
          doc.setIn(['endpoints', id, 'spawn', 'gateway_ref'], pair.gateway)
        }))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return reply.code(500).send({ error: 'config_write_failed', detail: message })
      }

      if (spawn.runner === 'docker') {
        const dockerSpec = spawn.docker
        if (dockerSpec === null) return reply.code(409).send({ error: 'invalid_spawn', detail: 'this docker runner has no docker section, so its image cannot be switched' })
        const image = `hellodac/dac-node:${target}`
        try {
          await withConfigLock(() => mutateYamlFile(configPath, (doc) => doc.setIn(['endpoints', id, 'spawn', 'docker', 'image'], image)))
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return reply.code(500).send({ error: 'config_write_failed', detail: message })
        }
        const oldImage = dockerSpec.image
        const next = { ...spawn, dshVersion: target, gatewayRef: pair.gateway, docker: { ...dockerSpec, image } }
        ep.spawn = next
        audit?.(actor, 'node_version_change', `node ${id} switched DSH → ${target} (container image ${oldImage} → ${image})`)
        // Rebuild at once: stop the old container -> ensureImage -> start the new image (no waiting for reconcile)
        supervisor.restart(next)
        return reply.code(202).send({ ok: true, switching: true, version: target, image })
      }

      ep.spawn = { ...spawn, dshVersion: target, gatewayRef: pair.gateway }
      return alignProcessNode(id, actor, reply, ep, supervisor, {
        version: target,
        gatewayRef: pair.gateway,
        auditKind: 'node_version_change',
        auditDetail: `node ${id} switched DSH → ${target} (facade ${pair.gateway})`,
      })
    },
  )
}
