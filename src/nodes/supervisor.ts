/**
 * NodeSupervisor — process lifecycle for one managed DSH node (Hive P1).
 *
 * State machine:
 *
 *   cold ──start()──▶ starting ──probe ok──▶ live
 *     ▲                │  │                    │
 *     │                │  └─exit (crash)─▶ restarting ──backoff──▶ starting
 *     │                └─probe timeout→kill─▶ (exit path, counts as one attempt)
 *     │                                             │ attempts ≥ maxAttempts
 *     └────────────stop() ◀─────────────────────────┴──▶ offline (auto-disabled after repeated failures)
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
import { GATEWAY_REF, defaultDshVersion, resolvePair } from '../dsh-matrix.js'

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

/** The injectable spawn surface: defaults to node:child_process spawn. */
export type SpawnFn = typeof spawn

export interface SupervisorDeps {
  /** Endpoint health probe; must resolve quickly and never throw. */
  probe: (id: string) => Promise<NodeProbeResult>
  log?: (line: string) => void
  /** Hive plan 2 P2b: the docker runner (used by nodes with runner=docker); missing = that mode is unavailable. */
  docker?: DockerRunner
  /** Extra environment for the docker container (GW_KEY / DEEPSEEK_API_KEY and friends, supplied by the wiring layer per endpoint). */
  dockerEnv?: () => Record<string, string>
  /** Debt C3: an injected spawn (tests pass a fake ChildProcess rather than starting a real process); defaults to the real spawn. */
  spawn?: SpawnFn
  /**
   * Debt C3: an injected killTree -- the real win32 implementation goes through taskkill, and a fake child process
   * never receives exit; the test injects this function to emit exit directly and drive onExit into cold. Defaults to the platform's native killTree.
   */
  killTree?: (child: ChildProcess) => void
  /**
   * Capability four (Fleet M1-4): command queuing for the agent runner (returns the command id);
   * missing = agent mode is unavailable (fail-loud offline).
   */
  agentCommand?: (agentId: string, type: string, payload: unknown) => number
  /** Capability four: subscribe to command results (an ok boolean); returns the unsubscribe function. */
  agentResult?: (commandId: number, cb: (ok: boolean) => void) => () => void
  /** Capability four: the log sent back by an agent node (a ring buffer on the manager side). */
  agentLog?: (agentId: string, nodeId: string) => string
  /** Capability four (M1-6): extra environment for the spawn payload (GW_KEY and friends, supplied by wiring per endpoint). */
  agentEnv?: () => Record<string, string>
  /** Capability four (M1-6): the fleet.md content (a derived hand-out, wired from renderFleetDoc). */
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
/** Road-building A3: how many consecutive failed liveness probes in live state flip the node to offline (the periodic reconcile then heals it). */
export const LIVE_PROBE_THRESHOLD = 3

export class NodeSupervisor {
  readonly id: string
  private readonly deps: SupervisorDeps
  private child: ChildProcess | null = null
  /** Hive plan 2 P2b: the current container id in docker runner mode (always null in process mode). */
  private containerId: string | null = null
  /** The spec of the last start/restart: the docker branch of stop/restart needs it. */
  private lastSpec: ResolvedSpawnSpec | null = null
  /** Launch generation: incremented by every start/stop/adopt, so a stale async chain is discarded outright (pre-release review B3). */
  private launchGen = 0
  private readyTimer: NodeJS.Timeout | null = null
  private restartTimer: NodeJS.Timeout | null = null
  private manualStop = false
  /** Hive P5.1: an intentional-restart flag -- bring the process back once it disappears after a stop instead of going cold. */
  private restartRequested = false
  private lastError: string | null = null
  private pidFile: string | null = null
  private logLines: string[] = []
  private logBytes = 0
  /** Road-building A3: consecutive failed liveness probes in live state (reset to zero outside live). */
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
    this.launchGen += 1 // Hive plan 2 P6 review B3: invalidate every launch chain in flight
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    if (this.readyTimer !== null) {
      clearTimeout(this.readyTimer)
      this.readyTimer = null
    }
    // Hive plan 2 P2b: docker mode -- stopping the container stops the node (all state lives in the volume)
    const spec = this.lastSpec
    if (spec !== null && spec.runner === 'agent') {
      // Capability four: a remote process has no local exit event -- stopping means enqueuing node.stop (best-effort)
      // and going cold immediately (the liveness probe will report the remote truth on its own).
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

  /** Hive P5.1: intentional restart. Once the process disappears after a stop it is brought back automatically and the retry count is cleared. */
  restart(spec: ResolvedSpawnSpec): void {
    this.lastSpec = spec
    // Capability four: an agent node has no local process to observe -- a restart always runs the stop->start chain
    // (enqueue node.stop + node.spawn); otherwise live state would be short-circuited into a plain start by "no child".
    if (spec.runner === 'agent') {
      this.restartRequested = true
      this.stop()
      return
    }
    // No process running = start right away; otherwise wait for the process to disappear before bringing it back, so no stale flag is left behind.
    if (this.child === null && this.containerId === null && this.restartTimer === null) {
      this.start(spec)
      return
    }
    this.restartRequested = true
    this.stop()
  }

  /**
   * Incident regression (2026-09-25, ubuntu-focal lost): a node resumes running after its host comes back online.
   *
   * The difference from a healOnly reconcile is the cold state: healOnly deliberately skips cold (protecting the
   * nodes a human stopped by hand, Debt R9), but after a machine reboot the node **is** cold -- skipping it means it
   * never comes up. This path is dedicated to the "agent dropped and came back online" edge: bring cold up and
   * leave live alone (KillMode=process means the node can survive an agent self-update, and a duplicate spawn would
   * fight for the same port and report EADDRINUSE), while a stop marked with `manualStop` is still left untouched.
   */
  resume(spec: ResolvedSpawnSpec): void {
    this.lastSpec = spec
    if (this.manualStop) return
    if (this.status.state === 'live') return
    if (this.restartTimer !== null || this.status.state === 'starting' || this.status.state === 'restarting') return
    if (spec.runner === 'agent') {
      this.startAgent(spec)
      return
    }
    if (this.status.state === 'offline') {
      this.restart(spec)
      return
    }
    if (spec.runner === 'docker') {
      this.startDocker(spec)
      return
    }
    if (this.child !== null) return
    this.spawnOnce(spec)
  }

  /** Buffered stdout/stderr of the current (or last) child, as text. */
  logs(): string {
    return this.logLines.join('')
  }
  /**
   * Road-building A3: a health probe for live state (called by the periodic reconcile). It probes only while
   * state==='live'; LIVE_PROBE_THRESHOLD consecutive failures -> flip to offline and let the reconcile heal it.
   * The docker branch also clears containerId -- when the container was killed externally, stop(with the old id)
   * fails and wedges the restart chain, so clearing it makes a restart rebuild by starting directly.
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

  /** Hive plan 2 P2b: docker-mode logs go through docker logs; null when unavailable (the caller falls back to the buffer). */
  async dockerLogs(): Promise<string | null> {
    if (this.deps.docker === undefined || this.containerId === null) return null
    try {
      return await this.deps.docker.logs(this.containerId, 500)
    } catch (error) {
      this.deps.log?.(`node ${this.id}: docker logs failed: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  /** The image tag the node container currently uses (e.g. hellodac/dac-node:0.1.5-rc.2); null for a non-docker shape or when it cannot be found. */
  async containerImage(): Promise<string | null> {
    if (this.deps.docker === undefined || this.containerId === null) return null
    return this.deps.docker.containerImage(this.containerId)
  }

  /** Hive plan 2 P2b: startup reconcile -- adopt a managed container that is already running (never start a second one). */
  adopt(spec: ResolvedSpawnSpec, containerId: string): void {
    this.lastSpec = spec
    this.containerId = containerId
    this.manualStop = false
    this.launchGen += 1 // invalidate launch chains in flight (review B3)
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
            // Capability four: a remote process has no local handle -- enqueue node.stop and then run the failure decision chain
            this.enqueueAgent('node.stop')
            this.afterAgentFailure(spec)
          } else if (spec.runner === 'docker') {
            // Review B3: docker mode has no child process to kill -- stop the container and then run the failure decision chain
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
    const gen = ++this.launchGen // Hive plan 2 P6 review B3: the chain is discarded once it goes stale
    void runner
      .ensureImage(spec.docker.image)
      .then(() => runner.start(spec, this.id, env))
      .then((containerId) => {
        if (gen !== this.launchGen || this.status.state !== 'starting') {
          // A stop/restart/adopt during the wait: the container just started is orphaned, so finish it off
          void runner.stop(containerId).catch(() => undefined)
          return
        }
        this.containerId = containerId
        this.deps.log?.(`node ${this.id}: container ${containerId} (${spec.docker?.image ?? '?'})`)
        this.armReadyProbe(spec)
      })
      .catch((error: unknown) => {
        if (gen !== this.launchGen) return // a failure from a stale chain is not a failure
        this.lastError = error instanceof Error ? error.message : String(error)
        this.deps.log?.(`node ${this.id}: docker start failed: ${this.lastError}`)
        if (this.status.state !== 'starting') return
        this.afterDockerFailure(spec)
      })
  }

  /** Retry/disable decision after a failed docker start (reuses the same policy function as process mode). */
  private afterDockerFailure(spec: ResolvedSpawnSpec): void {
    this.failAndRetry(spec, 'docker start failed', () => this.startDocker(spec))
  }

  /** Capability four: retry/disable decision after a failed agent start (the same policy as docker; a retry goes through startAgent). */
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

  /** Capability four: the launch chain for an agent node -- enqueue node.spawn, signalled by both the result and readiness. */
  private startAgent(spec: ResolvedSpawnSpec): void {
    const enqueue = this.deps.agentCommand
    if (enqueue === undefined || spec.host === null) {
      this.lastError = 'agent runner is not wired up (no agentCommand injected, or spawn.host is empty)'
      this.deps.log?.(`node ${this.id}: ${this.lastError}`)
      this.status = { ...this.status, state: 'offline', lastError: this.lastError, stateSince: Date.now() }
      return
    }
    this.status = { ...this.status, state: 'starting', lastError: null, stateSince: Date.now() }
    const gen = ++this.launchGen // Hive plan 2 P6 review B3: the chain is discarded once it goes stale
    // M1-6: the derived hand-out payload -- profile file + seed + fleet.md delivered with the spawn in one go
    const argAfter = (flag: string): string | null => {
      const i = spec.args.indexOf(flag)
      const raw = i >= 0 ? spec.args[i + 1] : undefined
      return typeof raw === 'string' ? raw : null
    }
    const profileName = argAfter('--profile') ?? this.id
    const port = Number(argAfter('--port') ?? 3080)
    const dshVersion = spec.dshVersion ?? defaultDshVersion()
    // 0.2.0 corridor: an explicit pin wins; otherwise the ref resolves through the MATRIX ROW of the
    // effective version -- falling straight back to the GATEWAY_REF constant would hand a 0.2.0 node
    // the pre-corridor facade, whose answerer pump dies silently (dsh-facts §18.2).
    const gatewayRef = spec.gatewayRef ?? resolvePair(dshVersion)?.gateway ?? GATEWAY_REF
    // An agent node on a remote server: the webserver binds 0.0.0.0 so the manager can probe it across machines
    // (the security surface = the Q5 firewall allowlist + the 0.1.5 token; the GUI still goes through the user-side tunnel).
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
      // M2 regression: the readiness probe only starts after the spawn result -- a remote cold install can take
      // minutes, and probing immediately would burn through the window during the install (a mistaken stop + a retry storm).
      this.deps.log?.(`node ${this.id}: the agent reported a finished spawn (command #${commandId}) — probing readiness`)
      this.armReadyProbe(spec)
    })
  }

  /** Capability four: enqueue one agent command (the shared entry point for stop semantics; unwired = leave a trace silently). */
  private enqueueAgent(type: 'node.stop'): void {
    const spec = this.lastSpec
    const enqueue = this.deps.agentCommand
    if (spec === null || spec.host === null || enqueue === undefined) return
    enqueue(spec.host, type, { nodeId: this.id })
  }

  /** Capability four: the log sent back by an agent node (event channel -> ring buffer on the manager side). */
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
      // Hive P5.1: intentional restart -- bring the process back as soon as it disappears instead of leaving it cold.
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
