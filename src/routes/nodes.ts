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
import { dshBinInProfile, profileDrift, reseedProfile } from '../host-node/profile.js'
import { COMPAT_DSH_VERSION, GATEWAY_REF, resolvePair, SUPPORTED_DSH } from '../dsh-matrix.js'
import { installNodeDepsAsync } from './provision.js'
import { probeEndpoint } from './status.js'

/**
 * 蜂群 P3：节点（fleet）视图数据源。
 *
 * 一个节点 = 一个 endpoint 的实体。托管节点（spawn.managed）的真相是监督器
 * 状态机（cold/starting/live/restarting/offline）；未托管节点的真相是探活
 * 结果（live/offline）。侧栏节点区与未来的 /nodes 页共用这一份。
 */
export const registerNodesRoutes = (
  app: FastifyInstance,
  config: AppConfig,
  supervisors: Map<string, NodeSupervisor>,
  clients: Map<string, GatewayClient>,
  upstreamClients: Map<string, SessionDriver>,
  requireUser: preHandlerHookHandler,
  /** 蜂群2计划 P3：节点操作审计回调（wiring 层注入，测试可不传）。 */
  audit?: (actor: string, kind: AuditKind, detail: string) => void,
  /** 能力二：对齐路由的依赖安装器（测试注入假实现；缺省 = 真实 npm install）。 */
  installDeps: (dir: string, dshVersion?: string) => Promise<void> = (dir, version) => installNodeDepsAsync(dir, version),
): void => {
  /**
   * 能力二：进程节点的配置钉版（显式值 > 矩阵默认）与 profile 目录。
   * 容器节点返回 null（换版本 = 改镜像 tag，不在本路由范围）。
   */
  const pinnedOf = (ep: ResolvedEndpoint): { version: string; gatewayRef: string; profileDir: string | null } => {
    const version = ep.spawn?.dshVersion ?? COMPAT_DSH_VERSION
    const gatewayRef = ep.spawn?.gatewayRef ?? (resolvePair(version)?.gateway ?? GATEWAY_REF)
    const dshHome = ep.spawn?.env['DSH_HOME']
    // profile 目录名 = spawn.args 里 --profile 指定的名字（端点 id 只是配置键，
    // 线上实踩：端点 id 'personal' 而 profile 名 'dac-personal'，按 id 拼目录
    // 会重播种进幽灵目录、真节点纹丝不动）；无 --profile 才回退端点 id。
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
    // 能力三 v1：按节点从日志即时捕获 GUI token 并拼装打开 URL——每次请求
    // 重新读日志,节点重启轮换 token 后自动跟随,无需任何缓存/失效机制。
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
          // 日志文件读失败 = 视为尚未捕获
        }
      } else if (supervisor !== undefined) {
        if (ep.spawn?.runner === 'docker') {
          const dockerLogs = await supervisor.dockerLogs()
          if (dockerLogs !== null) logs = dockerLogs
        } else if (ep.spawn?.runner === 'agent') {
          // 能力四：agent 节点日志经事件通道回传（manager 侧环形缓冲）
          logs = supervisor.agentLogs()
        } else {
          logs = supervisor.logs()
        }
      }
      const capture = captureGuiToken(logs)
      // 已配置 access = 用户选了隧道形态（本机映射口打开）
      if (ep.access !== null) return guiOpenUrl(ep.access.localPort, capture)
      // 体验优化：本机 loopback 节点无需隧道——浏览器即 loopback，直接用启动行
      // 里的真实 GUI 端口直连（非 loopback 且无 access = 无打开能力）
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
          // 容器形态：镜像标签就是节点 DSH 版本的真相（镜像 tag 即 DSH 版本）。
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
            // 能力二：配置钉版（null = 跟随全局默认）；漂移 = profile 种子与钉版不符
            configuredDshVersion: ep?.spawn?.dshVersion ?? null,
            dshDrift: ep === undefined ? false : driftOf(ep),
            // 能力四（M1-7）：该节点的执行 agent（null = 本机/容器）
            host: ep?.spawn?.host ?? null,
            ...(image === null ? {} : { image }),
            // 能力三 v1：隧道元数据 + 拼好的打开 URL（未配置/未捕获 = null）
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
    // 蜂群2计划 P6：向导需要知道部署形态（docker runner 节点默认工作区路径不同）
    const dockerMode = Object.values(config.endpoints).some((e) => e.spawn?.runner === 'docker')
    // 能力二：向导版本下拉的数据源（矩阵是唯一真相源，前端不硬编码版本清单）
    const supportedDsh = SUPPORTED_DSH.map((p) => ({ dsh: p.dsh, status: p.status }))
    // 部署形态标记（镜像 ENV DAC_DEPLOY_FORM）：容器形态前端禁用「宿主机进程」
    const containerForm = process.env.DAC_DEPLOY_FORM === 'container'
    // UI 收尾 C-P1.5：本机信息（拓扑「本机卡」+ 机器列表「本机行」数据源；
    // manager 宿主不经 node-agent，机器目录里没有它，这里显式给出）。
    const hostOs = process.platform
    const hostArch = process.arch
    const hostName = hostname()
    const hostNodeVersion = process.version
    return { nodes, dockerMode, supportedDsh, containerForm, hostOs, hostArch, hostName, hostNodeVersion }
  })

  /**
   * 蜂群 P5.1：节点管控。只有托管节点（有 spawn 配置 + 监督器在册）能操作；
   * 外部管理的节点友好拒绝——manager 的手伸不到的地方，按钮就不该出现。
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

      // 日志文件（detached + log_file 的节点）从文件读；否则读监督器内存缓冲。
      if (ep.spawn?.logFile !== undefined && ep.spawn.logFile !== null) {
        try {
          return reply.send({ logs: tail(readFileSync(ep.spawn.logFile, 'utf8')), source: 'file' })
        } catch (error) {
          // 债务 E11:读失败不再静默返回空串(用户会把「无日志」当成节点没跑,
          // 而真相是权限/IO 错误)——记日志并把原因带回给前端展示。
          const message = error instanceof Error ? error.message : String(error)
          app.log.warn(`node ${request.params.id}: reading log file failed: ${message}`)
          return reply.send({ logs: '', source: 'file', error: `could not read the log: ${message}` })
        }
      }
      const supervisor = supervisors.get(request.params.id)
      if (supervisor === undefined) {
        return reply.code(409).send({ error: 'not_managed', detail: 'a node managed outside the manager has no log to read' })
      }
      // 蜂群2计划 P2b：docker runner 的节点日志走 docker logs（缓冲里没有进程输出）
      if (ep.spawn?.runner === 'docker') {
        const dockerLogs = await supervisor.dockerLogs()
        if (dockerLogs !== null) return reply.send({ logs: tail(dockerLogs), source: 'docker' })
      }
      // 能力四：agent runner 的日志走事件通道回传缓冲
      if (ep.spawn?.runner === 'agent') {
        return reply.send({ logs: tail(supervisor.agentLogs()), source: 'agent' })
      }
      return reply.send({ logs: tail(supervisor.logs()), source: 'buffer' })
    },
  )

  /**
   * 能力三 v1：节点原生 GUI 的 SSH 隧道元数据（真相源 = endpoints.<id>.access）。
   * clear=true 移除该段；否则 ssh_user/ssh_host/local_port 必填，ssh_port/gui_port
   * 缺省 22/3080。写真相源（锁 + 原子写）后热加载进内存配置。
   * 红线：ssh 私钥不进本接口——manager 只记「怎么连」，不记「凭什么连」。
   */
  const accessBody = z.object({
    clear: z.boolean().optional(),
    ssh_user: z.string().min(1).optional(),
    ssh_host: z.string().min(1).optional(),
    ssh_port: z.number().int().positive().optional(),
    gui_port: z.number().int().positive().optional(),
    local_port: z.number().int().positive().optional(),
    /** 体验优化：用户本机私钥路径（非密钥内容），命令带 -i；缺省用 ssh 默认密钥。 */
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
   * P1（hive/plan-config-version-switch）：进程节点「改钉版 → 重播种 → 后台重装
   * → 隔离 bin 重启」的共享实现——align-version（对齐到配置钉版）与 version
   * （显式切换）共用，不复制逻辑。ep.spawn.dshVersion 由调用方先改好。
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
      audit?.(actor, opts.auditKind, opts.auditDetail)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return reply.code(500).send({ error: 'reseed_failed', detail: message })
    }

    // 后台重装依赖 → 完成/失败都重启（缺依赖崩溃 → offline 显性，同 provision 口径）
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
   * 能力二：版本对齐——把进程节点的 profile 重播种到配置钉版（重写依赖清单 +
   * .seed-version）→ 后台重装依赖 → 用 profile 内隔离 bin 重启节点（幂等）。
   * 容器节点 409（换版本 = 改镜像 tag，用 /version 路由）。审计 node_align_version。
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
   * P1（hive/plan-config-version-switch）：节点切换 DSH 版本——升级零 sed。
   * 双分支：容器 = 改 spawn.docker.image tag + 立即重建（镜像 ID 比对触发）；
   * 进程 = 改钉版后委托对齐链（重播种→重装→重启）。矩阵校验 + 审计
   * node_version_change + 显式切版才写真相源（口径同 provision）。
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
      // 真相源落盘：显式切版才写 dsh_version 钉版（默认跟随矩阵的节点不落盘）
      try {
        await withConfigLock(() => mutateYamlFile(configPath, (doc) => doc.setIn(['endpoints', id, 'spawn', 'dsh_version'], target)))
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
        const next = { ...spawn, dshVersion: target, docker: { ...dockerSpec, image } }
        ep.spawn = next
        audit?.(actor, 'node_version_change', `node ${id} switched DSH → ${target} (container image ${oldImage} → ${image})`)
        // 立即重建：停旧容器 → ensureImage → 起新镜像（不等对账周期）
        supervisor.restart(next)
        return reply.code(202).send({ ok: true, switching: true, version: target, image })
      }

      ep.spawn = { ...spawn, dshVersion: target }
      return alignProcessNode(id, actor, reply, ep, supervisor, {
        version: target,
        gatewayRef: pair.gateway,
        auditKind: 'node_version_change',
        auditDetail: `node ${id} switched DSH → ${target} (facade ${pair.gateway})`,
      })
    },
  )
}
