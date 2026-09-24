/**
 * NodeSupervisor — process lifecycle for one managed DSH node (蜂群 P1).
 *
 * State machine:
 *
 *   cold ──start()──▶ starting ──probe ok──▶ live
 *     ▲                │  │                    │
 *     │                │  └─exit (crash)─▶ restarting ──backoff──▶ starting
 *     │                └─probe timeout→kill─▶ (exit path, counts as one attempt)
 *     │                                             │ attempts ≥ maxAttempts
 *     └────────────stop() ◀─────────────────────────┴──▶ offline（连续失败自动停用）
 *
 * Pure decisions (`backoffDelayMs` / `decideAfterExit`) are extracted so the
 * retry policy is directly unit-testable; the class itself is thin plumbing.
 *
 * Design notes:
 * - The probe is injected by the wiring layer (endpoint health check), so this
 *   module has no HTTP knowledge and no config knowledge.
 * - Child stdout/stderr are captured into a bounded ring of lines so `logs`
 *   works without a log-file convention.
 * - On Windows the tree is killed with taskkill /T /F; elsewhere SIGTERM then
 *   SIGKILL. The stop() path is marked manual so the exit handler settles to
 *   `cold` instead of restarting.
 */

import { spawn, spawnSync, type ChildProcess, type StdioOptions } from 'node:child_process'
import { openSync, rmSync, writeFileSync } from 'node:fs'
import type { ResolvedSpawnSpec } from '../config.js'
import type { DockerRunner } from './docker-runner.js'
import { profileFiles, profileSeed } from '../host-node/profile.js'
import { GATEWAY_REF, defaultDshVersion } from '../dsh-matrix.js'

export type NodeState = 'cold' | 'starting' | 'live' | 'restarting' | 'offline'

export interface NodeProbeResult {
  ok: boolean
  detail: string
}

export interface NodeStatus {
  id: string
  state: NodeState
  pid: number | null
  /** Consecutive failed starts/crashes since the last time the node was live. */
  attempts: number
  lastError: string | null
  startedAt: number | null
  stateSince: number
}

/** spawn 的可注入面:缺省 = node:child_process 的 spawn。 */
export type SpawnFn = typeof spawn

export interface SupervisorDeps {
  /** Endpoint health probe; must resolve quickly and never throw. */
  probe: (id: string) => Promise<NodeProbeResult>
  log?: (line: string) => void
  /** 蜂群2计划 P2b：docker runner（runner=docker 的节点用）；缺 = 该模式不可用。 */
  docker?: DockerRunner
  /** docker 容器的附加环境（GW_KEY / DEEPSEEK_API_KEY 等，由 wiring 层按 endpoint 提供）。 */
  dockerEnv?: () => Record<string, string>
  /** 债务 C3:spawn 注入(测试传假 ChildProcess,不真起进程);缺省 = 真实 spawn。 */
  spawn?: SpawnFn
  /**
   * 债务 C3:killTree 注入——win32 真实现走 taskkill,假子进程收不到 exit;
   * 测试注入此函数直接 emit exit 走 onExit 落 cold。缺省 = 平台原生 killTree。
   */
  killTree?: (child: ChildProcess) => void
  /**
   * 能力四（舰队 M1-4）：agent runner 的指令入队（返回指令 id）；
   * 缺 = agent 模式不可用（fail-loud offline）。
   */
  agentCommand?: (agentId: string, type: string, payload: unknown) => number
  /** 能力四：订阅指令结果（ok 布尔）；返回退订函数。 */
  agentResult?: (commandId: number, cb: (ok: boolean) => void) => () => void
  /** 能力四：agent 节点的回传日志（manager 侧环形缓冲）。 */
  agentLog?: (agentId: string, nodeId: string) => string
  /** 能力四（M1-6）：spawn 载荷的附加环境（GW_KEY 等，wiring 按 endpoint 提供）。 */
  agentEnv?: () => Record<string, string>
  /** 能力四（M1-6）：fleet.md 内容（派生下发，wiring 供 renderFleetDoc）。 */
  fleetDoc?: () => string
}

/** Exponential backoff, capped: attempt 1 → base, 2 → 2×base, … never above max. */
export const backoffDelayMs = (attempt: number, baseDelayMs: number, maxDelayMs: number): number =>
  Math.min(baseDelayMs * 2 ** Math.max(0, attempt - 1), maxDelayMs)

/** What happens after the child exits, given how many failures this streak has. */
export const decideAfterExit = (attempts: number, maxAttempts: number, manual: boolean): 'cold' | 'restart' | 'offline' => {
  if (manual) return 'cold'
  return attempts >= maxAttempts ? 'offline' : 'restart'
}

const PROBE_POLL_MS = 1_000
/** A node's captured output is kept as lines, bounded to roughly this many bytes. */
const LOG_BUFFER_BYTES = 64 * 1024
/** 修路 A3：live 态探活连续失败多少次转 offline（交给周期对账自愈）。 */
export const LIVE_PROBE_THRESHOLD = 3

export class NodeSupervisor {
  readonly id: string
  private readonly deps: SupervisorDeps
  private child: ChildProcess | null = null
  /** 蜂群2计划 P2b：docker runner 模式下当前容器 id（process 模式恒为 null）。 */
  private containerId: string | null = null
  /** 最近一次 start/restart 的规格：stop/restart 的 docker 分支要用。 */
  private lastSpec: ResolvedSpawnSpec | null = null
  /** 启动代号：每次 start/stop/adopt 递增，过期异步链直接弃用（发布前评审 B3）。 */
  private launchGen = 0
  private readyTimer: NodeJS.Timeout | null = null
  private restartTimer: NodeJS.Timeout | null = null
  private manualStop = false
  /** 蜂群 P5.1：主动重启标记——stop 后进程消失时再拉起，而不是进入冷态。 */
  private restartRequested = false
  private lastError: string | null = null
  private pidFile: string | null = null
  private logLines: string[] = []
  private logBytes = 0
  /** 修路 A3：live 态探活连续失败计数（非 live 态归零）。 */
  private liveProbeFailures = 0
  private status: NodeStatus

  constructor(id: string, deps: SupervisorDeps) {
    this.id = id
    this.deps = deps
    this.status = {
      id,
      state: 'cold',
      pid: null,
      attempts: 0,
      lastError: null,
      startedAt: null,
      stateSince: Date.now(),
    }
  }

  get current(): NodeStatus {
    return { ...this.status }
  }

  /** Start the node (no-op unless cold/offline-restart). */
  start(spec: ResolvedSpawnSpec): void {
    this.lastSpec = spec
    if (spec.runner === 'docker') {
      if (this.containerId !== null || this.restartTimer !== null || this.status.state === 'starting') return
      this.manualStop = false
      this.startDocker(spec)
      return
    }
    if (spec.runner === 'agent') {
      if (this.restartTimer !== null || this.status.state === 'starting') return
      this.manualStop = false
      this.startAgent(spec)
      return
    }
    if (this.child !== null || this.restartTimer !== null || this.status.state === 'starting') return
    this.manualStop = false
    this.spawnOnce(spec)
  }

  /** Stop the node; settles to cold when the process is actually gone. */
  stop(): void {
    this.manualStop = true
    this.launchGen += 1 // 蜂群2计划 P6 评审 B3：作废所有在途启动链
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    if (this.readyTimer !== null) {
      clearTimeout(this.readyTimer)
      this.readyTimer = null
    }
    // 蜂群2计划 P2b：docker 模式 —— 停容器即停节点（状态都在卷里）
    const spec = this.lastSpec
    if (spec !== null && spec.runner === 'agent') {
      // 能力四：远端进程无本地 exit 事件——停 = 入队 node.stop（best-effort），
      // 状态即刻落冷（探活自会反映远端真相）。
      this.enqueueAgent('node.stop')
      if (this.restartRequested) {
        this.restartRequested = false
        this.manualStop = false
        this.status = { ...this.status, state: 'cold', pid: null, attempts: 0, stateSince: Date.now() }
        this.deps.log?.(`node ${this.id}: restarting (agent)`)
        this.startAgent(spec)
        return
      }
      this.status = { ...this.status, state: 'cold', pid: null, stateSince: Date.now() }
      this.deps.log?.(`node ${this.id}: stopped (agent)`)
      return
    }
    if (spec !== null && spec.runner === 'docker') {
      const cid = this.containerId
      this.containerId = null
      const runner = this.deps.docker
      if (cid === null || runner === undefined) {
        this.status = { ...this.status, state: 'cold', pid: null, stateSince: Date.now() }
        return
      }
      void runner
        .stop(cid)
        .then(() => {
          if (this.restartRequested) {
            this.restartRequested = false
            this.manualStop = false
            this.status = { ...this.status, state: 'cold', pid: null, attempts: 0, stateSince: Date.now() }
            this.deps.log?.(`node ${this.id}: restarting (docker)`)
            this.startDocker(spec)
            return
          }
          this.status = { ...this.status, state: 'cold', pid: null, stateSince: Date.now() }
          this.deps.log?.(`node ${this.id}: stopped (docker)`)
        })
        .catch((error: unknown) => {
          this.deps.log?.(`node ${this.id}: docker stop failed: ${error instanceof Error ? error.message : String(error)}`)
        })
      return
    }
    if (this.child === null) {
      this.clearPidFile()
      this.status = { ...this.status, state: 'cold', pid: null, stateSince: Date.now() }
      return
    }
    this.killTree()
  }

  /** 蜂群 P5.1：主动重启。stop 之后进程消失时自动重新拉起，清零重试计数。 */
  restart(spec: ResolvedSpawnSpec): void {
    this.lastSpec = spec
    // 能力四：agent 节点无本地进程可观察——重启恒走 stop→start 链（入队
    // node.stop + node.spawn），否则 live 态会被「无 child」短路成直接 start。
    if (spec.runner === 'agent') {
      this.restartRequested = true
      this.stop()
      return
    }
    // 没有进程在跑 = 直接启动；否则等进程消失后再拉起，避免残留标记。
    if (this.child === null && this.containerId === null && this.restartTimer === null) {
      this.start(spec)
      return
    }
    this.restartRequested = true
    this.stop()
  }

  /** Buffered stdout/stderr of the current (or last) child, as text. */
  logs(): string {
    return this.logLines.join('')
  }

  /**
   * 修路 A3：live 态健康探活（周期对账调用）。只在 state==='live' 时探测；
   * 连续 LIVE_PROBE_THRESHOLD 次失败 → 转 offline 交给对账自愈。
   * docker 分支同时清 containerId——容器已被外部杀掉时 stop(旧 id) 会失败
   * 而卡死 restart 链，清掉后 restart 走「直接 start」重建。
   */
  async probeLive(): Promise<void> {
    if (this.status.state !== 'live') {
      this.liveProbeFailures = 0
      return
    }
    const result = await this.deps.probe(this.id)
    if (result.ok) {
      this.liveProbeFailures = 0
      return
    }
    this.liveProbeFailures += 1
    this.lastError = `live probe failed (${this.liveProbeFailures}/${LIVE_PROBE_THRESHOLD}): ${result.detail}`
    if (this.liveProbeFailures < LIVE_PROBE_THRESHOLD) return
    if (this.lastSpec?.runner === 'docker') this.containerId = null
    this.status = { ...this.status, state: 'offline', pid: null, attempts: 1, lastError: this.lastError, stateSince: Date.now() }
    this.deps.log?.(`node ${this.id}: offline after ${this.liveProbeFailures} consecutive live probe failures`)
  }

  /** 蜂群2计划 P2b：docker 模式的日志走 docker logs；不可用返回 null（调用方回退缓冲）。 */
  async dockerLogs(): Promise<string | null> {
    if (this.deps.docker === undefined || this.containerId === null) return null
    try {
      return await this.deps.docker.logs(this.containerId, 500)
    } catch (error) {
      this.deps.log?.(`node ${this.id}: docker logs failed: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  /** 节点容器当前使用的镜像标签（如 hellodac/dac-node:0.1.2-rc.1）；非 docker 形态或查不到返回 null。 */
  async containerImage(): Promise<string | null> {
    if (this.deps.docker === undefined || this.containerId === null) return null
    return this.deps.docker.containerImage(this.containerId)
  }

  /** 蜂群2计划 P2b：启动对账——认领已在跑的托管容器（不重复拉起）。 */
  adopt(spec: ResolvedSpawnSpec, containerId: string): void {
    this.lastSpec = spec
    this.containerId = containerId
    this.manualStop = false
    this.launchGen += 1 // 作废在途启动链（评审 B3）
    this.status = { ...this.status, state: 'starting', lastError: null, stateSince: Date.now() }
    this.deps.log?.(`node ${this.id}: adopting container ${containerId}`)
    this.armReadyProbe(spec)
  }

  private spawnOnce(spec: ResolvedSpawnSpec): void {
    this.status = { ...this.status, state: 'starting', lastError: null, stateSince: Date.now() }
    // Detached nodes outlive the launcher: output goes to the log file (and a
    // pidfile next to it), never to pipes that die with the parent.
    let outputFd: number | null = null
    let stdio: StdioOptions
    if (spec.logFile !== null) {
      outputFd = openSync(spec.logFile, 'a')
      stdio = ['ignore', outputFd, outputFd]
    } else if (spec.detached) {
      stdio = ['ignore', 'ignore', 'ignore']
    } else {
      stdio = ['ignore', 'pipe', 'pipe']
    }
    const spawnNow = this.deps.spawn ?? spawn
    const child = spawnNow(spec.command, spec.args, {
      cwd: spec.cwd ?? undefined,
      env: { ...process.env, ...spec.env },
      stdio,
      windowsHide: true,
      detached: spec.detached,
    })
    if (spec.detached) child.unref()
    this.child = child
    this.status = { ...this.status, pid: child.pid ?? null, startedAt: Date.now() }
    if (spec.logFile !== null && child.pid !== undefined) {
      this.pidFile = spec.logFile + '.pid'
      writeFileSync(this.pidFile, String(child.pid))
    }
    this.deps.log?.(`node ${this.id}: spawning ${spec.command} ${spec.args.join(' ')} (pid ${child.pid ?? '?'})`)

    if (outputFd !== null) {
      child.stdout = null
      child.stderr = null
    } else {
      child.stdout?.on('data', (chunk: Buffer) => this.pushLog(String(chunk)))
      child.stderr?.on('data', (chunk: Buffer) => this.pushLog(String(chunk)))
    }
    child.once('error', (error) => {
      // spawn itself failed (ENOENT etc.): no process, no exit event on some
      // platforms — settle through the same exit path.
      this.lastError = error.message
      this.deps.log?.(`node ${this.id}: spawn failed: ${error.message}`)
      if (this.child === child) this.onExit(spec, null, null)
    })
    child.once('exit', (code, signal) => {
      if (this.child === child) this.onExit(spec, code, signal)
    })

    this.armReadyProbe(spec)
  }

  private armReadyProbe(spec: ResolvedSpawnSpec): void {
    const deadline = Date.now() + spec.readyTimeoutMs
    const poll = (): void => {
      if (this.status.state !== 'starting') return
      void this.deps.probe(this.id).then((result) => {
        if (this.status.state !== 'starting') return
        if (result.ok) {
          this.status = { ...this.status, state: 'live', attempts: 0, lastError: null, stateSince: Date.now() }
          this.deps.log?.(`node ${this.id}: live`)
          return
        }
        if (Date.now() >= deadline) {
          this.lastError = `not ready within ${spec.readyTimeoutMs}ms: ${result.detail}`
          this.deps.log?.(`node ${this.id}: ${this.lastError}`)
          if (spec.runner === 'agent') {
            // 能力四：远端进程无本地句柄——入队 node.stop 后走失败决策链
            this.enqueueAgent('node.stop')
            this.afterAgentFailure(spec)
          } else if (spec.runner === 'docker') {
            // 评审 B3：docker 模式没有子进程可杀——停容器后走失败决策链
            const cid = this.containerId
            this.containerId = null
            if (cid !== null && this.deps.docker !== undefined) {
              void this.deps.docker.stop(cid).catch(() => undefined)
            }
            this.afterDockerFailure(spec)
          } else {
            this.killTree()
          }
          return
        }
        this.readyTimer = setTimeout(poll, PROBE_POLL_MS)
      })
    }
    poll()
  }

  private startDocker(spec: ResolvedSpawnSpec): void {
    const runner = this.deps.docker
    if (runner === undefined || spec.docker === null) {
      this.lastError = 'docker runner is not wired up (is docker.sock mounted into the manager?)'
      this.deps.log?.(`node ${this.id}: ${this.lastError}`)
      this.status = { ...this.status, state: 'offline', lastError: this.lastError, stateSince: Date.now() }
      return
    }
    this.status = { ...this.status, state: 'starting', lastError: null, stateSince: Date.now() }
    const env = { ...(this.deps.dockerEnv?.() ?? {}), ...spec.env }
    const gen = ++this.launchGen // 蜂群2计划 P6 评审 B3：过期链弃用
    void runner
      .ensureImage(spec.docker.image)
      .then(() => runner.start(spec, this.id, env))
      .then((containerId) => {
        if (gen !== this.launchGen || this.status.state !== 'starting') {
          // 等待期间被 stop/重启/认领：刚拉起的容器成为孤儿，补刀清掉
          void runner.stop(containerId).catch(() => undefined)
          return
        }
        this.containerId = containerId
        this.deps.log?.(`node ${this.id}: container ${containerId} (${spec.docker?.image ?? '?'})`)
        this.armReadyProbe(spec)
      })
      .catch((error: unknown) => {
        if (gen !== this.launchGen) return // 过期链的失败不是失败
        this.lastError = error instanceof Error ? error.message : String(error)
        this.deps.log?.(`node ${this.id}: docker start failed: ${this.lastError}`)
        if (this.status.state !== 'starting') return
        this.afterDockerFailure(spec)
      })
  }

  /** docker 启动失败后的重试/停用决策（复用 process 模式的同一策略函数）。 */
  private afterDockerFailure(spec: ResolvedSpawnSpec): void {
    this.failAndRetry(spec, 'docker start failed', () => this.startDocker(spec))
  }

  /** 能力四：agent 启动失败后的重试/停用决策（与 docker 同策略，重试走 startAgent）。 */
  private afterAgentFailure(spec: ResolvedSpawnSpec): void {
    this.failAndRetry(spec, 'agent start failed', () => this.startAgent(spec))
  }

  private failAndRetry(spec: ResolvedSpawnSpec, defaultError: string, retry: () => void): void {
    if (this.manualStop) {
      this.status = { ...this.status, state: 'cold', pid: null, stateSince: Date.now() }
      return
    }
    const attempts = this.status.attempts + 1
    const decision = decideAfterExit(attempts, spec.restart.maxAttempts, false)
    this.status = {
      ...this.status,
      pid: null,
      attempts,
      lastError: this.lastError ?? defaultError,
      startedAt: null,
      stateSince: Date.now(),
    }
    if (decision === 'offline') {
      this.status = { ...this.status, state: 'offline' }
      this.deps.log?.(`node ${this.id}: offline after ${attempts} consecutive failures`)
      return
    }
    const delay = backoffDelayMs(attempts, spec.restart.baseDelayMs, spec.restart.maxDelayMs)
    this.status = { ...this.status, state: 'restarting' }
    this.deps.log?.(`node ${this.id}: restart in ${delay}ms (attempt ${attempts})`)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      retry()
    }, delay)
  }

  /** 能力四：agent 节点的启动链——入队 node.spawn，结果与就绪双信号。 */
  private startAgent(spec: ResolvedSpawnSpec): void {
    const enqueue = this.deps.agentCommand
    if (enqueue === undefined || spec.host === null) {
      this.lastError = 'agent runner is not wired up (no agentCommand injected, or spawn.host is empty)'
      this.deps.log?.(`node ${this.id}: ${this.lastError}`)
      this.status = { ...this.status, state: 'offline', lastError: this.lastError, stateSince: Date.now() }
      return
    }
    this.status = { ...this.status, state: 'starting', lastError: null, stateSince: Date.now() }
    const gen = ++this.launchGen // 蜂群2计划 P6 评审 B3：过期链弃用
    // M1-6：派生下发载荷——profile 文件 + 种子 + fleet.md 随 spawn 一次送达
    const argAfter = (flag: string): string | null => {
      const i = spec.args.indexOf(flag)
      const raw = i >= 0 ? spec.args[i + 1] : undefined
      return typeof raw === 'string' ? raw : null
    }
    const profileName = argAfter('--profile') ?? this.id
    const port = Number(argAfter('--port') ?? 3080)
    const dshVersion = spec.dshVersion ?? defaultDshVersion()
    const gatewayRef = spec.gatewayRef ?? GATEWAY_REF
    // agent 节点在远端服务器：webserver 绑 0.0.0.0 供 manager 跨机探活
    // （安全面 = Q5 防火墙白名单 + 0.1.5 token；GUI 走用户侧隧道不变）。
    const profileFilesPayload = profileFiles({ name: profileName, port }, gatewayRef, dshVersion, '0.0.0.0')
    profileFilesPayload['.seed-version'] = profileSeed(dshVersion, gatewayRef) + '\n'
    const fleetMd = this.deps.fleetDoc?.() ?? null
    const commandId = enqueue(spec.host, 'node.spawn', {
      nodeId: this.id,
      args: spec.args,
      env: { ...(this.deps.agentEnv?.() ?? {}), ...spec.env },
      dshVersion,
      gatewayRef,
      profile: { dir: `profiles/${profileName}`, files: profileFilesPayload },
      ...(fleetMd === null ? {} : { fleetMd }),
    })
    this.deps.log?.(`node ${this.id}: spawn command #${commandId} queued for agent ${spec.host} (profile and keys travel with the payload)`)
    this.deps.agentResult?.(commandId, (ok: boolean) => {
      if (gen !== this.launchGen || this.status.state !== 'starting') return
      if (!ok) {
        this.lastError = `the agent reported a failed spawn (command #${commandId})`
        this.deps.log?.(`node ${this.id}: ${this.lastError}`)
        this.afterAgentFailure(spec)
        return
      }
      // M2 回归：就绪探活从 spawn 结果后才开始——远端冷安装可能几分钟，
      // 立即探活会在安装期间把窗口烧穿（误杀 stop + 重试风暴）。
      this.deps.log?.(`node ${this.id}: the agent reported a finished spawn (command #${commandId}) — probing readiness`)
      this.armReadyProbe(spec)
    })
  }

  /** 能力四：入队一条 agent 指令（stop 语义的共用入口；未接线 = 静默留痕）。 */
  private enqueueAgent(type: 'node.stop'): void {
    const spec = this.lastSpec
    const enqueue = this.deps.agentCommand
    if (spec === null || spec.host === null || enqueue === undefined) return
    enqueue(spec.host, type, { nodeId: this.id })
  }

  /** 能力四：agent 节点的回传日志（事件通道 → manager 侧环形缓冲）。 */
  agentLogs(): string {
    const spec = this.lastSpec
    if (spec === null || spec.runner !== 'agent' || spec.host === null) return ''
    return this.deps.agentLog?.(spec.host, this.id) ?? ''
  }

  private onExit(spec: ResolvedSpawnSpec, code: number | null, signal: NodeJS.Signals | null): void {
    this.child = null
    if (this.readyTimer !== null) {
      clearTimeout(this.readyTimer)
      this.readyTimer = null
    }
    const exitNote = `exited code=${String(code)} signal=${String(signal)}`
    if (this.manualStop) {
      this.clearPidFile()
      // 蜂群 P5.1：主动重启——进程消失即重新拉起，而不是停在冷态。
      if (this.restartRequested) {
        this.restartRequested = false
        this.manualStop = false
        this.status = { ...this.status, state: 'cold', pid: null, attempts: 0, stateSince: Date.now() }
        this.deps.log?.(`node ${this.id}: restarting (${exitNote})`)
        this.spawnOnce(spec)
        return
      }
      this.status = { ...this.status, state: 'cold', pid: null, stateSince: Date.now() }
      this.deps.log?.(`node ${this.id}: stopped (${exitNote})`)
      return
    }
    const attempts = this.status.attempts + 1
    const decision = decideAfterExit(attempts, spec.restart.maxAttempts, false)
    this.status = {
      ...this.status,
      pid: null,
      attempts,
      lastError: this.lastError ?? exitNote,
      startedAt: null,
      stateSince: Date.now(),
    }
    if (decision === 'offline') {
      this.clearPidFile()
      this.status = { ...this.status, state: 'offline' }
      this.deps.log?.(`node ${this.id}: offline after ${attempts} consecutive failures`)
      return
    }
    const delay = backoffDelayMs(attempts, spec.restart.baseDelayMs, spec.restart.maxDelayMs)
    this.status = { ...this.status, state: 'restarting' }
    this.deps.log?.(`node ${this.id}: restart in ${delay}ms (attempt ${attempts})`)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.spawnOnce(spec)
    }, delay)
  }

  private clearPidFile(): void {
    if (this.pidFile === null) return
    try {
      rmSync(this.pidFile, { force: true })
    } catch {
      // best effort: a stale pidfile misleads `nodes down` but never hurts data
    }
    this.pidFile = null
  }

  private killTree(): void {
    const child = this.child
    if (child === null || child.pid === undefined) return
    if (this.deps.killTree !== undefined) {
      this.deps.killTree(child)
      return
    }
    if (process.platform === 'win32') {
      // taskkill /T /F is the reliable way to take a console-app tree down on
      // Windows; child.kill() only signals the outer shell. spawnSync so the
      // kill is issued before a fast shutdown can exit the process and orphan
      // the node.
      const result = spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      if (result.error !== undefined) this.deps.log?.(`node ${this.id}: taskkill failed: ${result.error.message}`)
      return
    }
    child.kill('SIGTERM')
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, 5_000).unref()
  }

  private pushLog(chunk: string): void {
    const lines = chunk.split(/\r?\n/)
    for (const line of lines) {
      if (line === '') continue
      this.logLines.push(line + '\n')
      this.logBytes += line.length + 1
    }
    while (this.logBytes > LOG_BUFFER_BYTES && this.logLines.length > 0) {
      const dropped = this.logLines.shift()
      if (dropped !== undefined) this.logBytes -= dropped.length
    }
  }
}
