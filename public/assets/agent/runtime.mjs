// @ts-check
/**
 * Capability four (Fleet M1-5): the node-agent runtime -- zero native dependencies (Node >=20),
 * dials out to the manager (long-poll commands + event reporting) and manages the local DSH node processes.
 *
 * Discipline:
 * - a fixed command set, never a general-purpose shell;
 * - identity and state live only in <agentDir>/agent.json (0600, the plaintext token appears only on the first registration);
 * - when the manager is unreachable the nodes keep running and it reconnects with exponential backoff; command execution and reporting both close the loop locally.
 *
 * Injection surface (for tests): transport / proc / fs / install / backoff.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { hostname, totalmem, freemem, cpus, uptime } from 'node:os'
import { currentAgentVersion } from './update.mjs'

/** Kept in sync with needsLegacyPeerDeps in src/dsh-matrix.ts (a standing assertion in check-docs.mjs). */
export const LEGACY_PEER_DEPS_VERSIONS = ['0.1.5-rc.2', '0.2.0-rc.2']

/**
 * The 0.2.0 corridor version gate (dsh-facts §18.5/§18.10, upgrade card J1-04): legacy 0.1.2/0.1.5
 * lines take the facade key through $DSH_HOME/settings.yaml; from the 0.1.7 corridor on, settings.yaml
 * is a one-shot import and ctx.settings.register is gone host-side -- the durable key path is the
 * profile's cordis.patch.yml composition row. NOTE the prerelease dash: "0.1.5-rc.2" never matches a
 * `0.1.5.*` pattern (§18.10 crash-loop); the ($|-|\.) triple form is required. Kept in sync with
 * isLegacyDshLine in src/dsh-matrix.ts (a standing assertion in check-docs.mjs).
 */
export const LEGACY_DSH_LINE_RE = /^0\.1\.(2|5)($|-|\.)/

const RING_BYTES = 64 * 1024
const DSH_PACKAGE = '@deepseek-ai/dsh'

const defaultTransport = {
  register: async (managerUrl, body) => {
    const res = await fetch(`${managerUrl}/api/internal/agents/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`register failed: HTTP ${res.status} ${JSON.stringify(json)}`)
    return json
  },
  commands: async (managerUrl, agentId, token, waitMs) => {
    const res = await fetch(`${managerUrl}/api/internal/agents/${agentId}/commands?wait=${waitMs}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    if (res.status === 401) throw new Error('unauthorized')
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`commands failed: HTTP ${res.status}`)
    return json.commands ?? []
  },
  events: async (managerUrl, agentId, token, events) => {
    const res = await fetch(`${managerUrl}/api/internal/agents/${agentId}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ events }),
    })
    if (!res.ok) throw new Error(`events failed: HTTP ${res.status}`)
  },
}

/**
 * The npm invocation contract (an M1 pilot regression proven on Windows): npm is a .cmd shim, so on node >=20
 * execFile without a shell gives ENOENT/EINVAL (CVE-2024-27980, the same trap as setup.ts L543 on the manager
 * side) -- always shell:true and let the system shell resolve it; the install directory only ever goes through
 * cwd, never into the arguments (a path with spaces is split apart when the shell joins it).
 */
export const npmInvocation = (args, cwd) => ({
  cmd: 'npm',
  args,
  options: { cwd, shell: true, stdio: ['ignore', 'inherit', 'inherit'] },
})

/**
 * The spawn invocation contract (an M1 pilot regression proven on Windows): bin.js has no executable
 * meaning on Windows (CreateProcess has no shebang -> EFTYPE) -- on win32 the command must be node and bin
 * becomes the first argument (the same "command: node" wiring as the supervisor on the manager side); posix
 * spawns it directly (shebang).
 */
export const spawnInvocation = (platform, bin, args) =>
  platform === 'win32'
    ? { cmd: process.execPath, args: [bin, ...args] }
    : { cmd: bin, args }

/** Capability four (M4-2): the per-generation cap on node.log -- rotate before spawning once it is exceeded (one generation kept). */
export const NODE_LOG_MAX_BYTES = 50 * 1024 * 1024

const defaultProc = {
  /** Install DSH into the agent's own prefix (never touching the user's global npm). */
  install: async (agentDir, version, legacyPeerDeps) => {
    const { execFileSync } = await import('node:child_process')
    const prefix = `${agentDir}/dsh/${version}`
    const args = ['install', `${DSH_PACKAGE}@${version}`, '--no-audit', '--no-fund']
    if (legacyPeerDeps) args.push('--legacy-peer-deps')
    const inv = npmInvocation(args, prefix)
    execFileSync(inv.cmd, inv.args, inv.options)
    return `${prefix}/node_modules/${DSH_PACKAGE}/lib/bin.js`
  },
  /** Derived delivery (M1-6): install the profile dependencies (cwd = the profile directory, every pinned version lives in the files). */
  installProfile: async (profileDir, legacyPeerDeps) => {
    const { execFileSync } = await import('node:child_process')
    const args = ['install', '--no-audit', '--no-fund']
    if (legacyPeerDeps) args.push('--legacy-peer-deps')
    const inv = npmInvocation(args, profileDir)
    execFileSync(inv.cmd, inv.args, inv.options)
  },
  /** Launch a node process (detached + file streams) and return its pid. */
  spawn: async (bin, args, env, outPath) => {
    const { spawn } = await import('node:child_process')
    const { openSync } = await import('node:fs')
    const fd = openSync(outPath, 'a')
    const inv = spawnInvocation(process.platform, bin, args)
    const child = spawn(inv.cmd, inv.args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', fd, fd],
      detached: true,
      windowsHide: true,
    })
    child.unref()
    return { pid: child.pid }
  },
  /** Stop a node: TERM first, wait 5s, then KILL (on Windows it goes through taskkill /T /F). */
  kill: async (pid) => {
    const { execFileSync } = await import('node:child_process')
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
      return
    }
    try {
      process.kill(pid, 'SIGTERM')
      await sleep(5_000)
      try {
        process.kill(pid, 0)
        process.kill(pid, 'SIGKILL')
      } catch { /* already exited */ }
    } catch { /* no longer there */ }
  },
  alive: async (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  },
}

export class AgentRuntime {
  /**
   * @param {object} opts
   * @param {string} opts.managerUrl
   * @param {string} opts.joinToken
   * @param {string} opts.agentDir
   * @param {typeof defaultTransport} [opts.transport]
   * @param {typeof defaultProc} [opts.proc]
   * @param {{ readFile: (p:string)=>string|null, writeFile: (p:string, c:string)=>void, mkdir: (p:string)=>void, exists: (p:string)=>boolean, stat: (p:string)=>number|null }} [opts.fs]
   * @param {number} [opts.maxWaitMs]
   * @param {(ms:number)=>Promise<void>} [opts.backoff]
   * @param {(line:string)=>void} [opts.log]
   */
  constructor(opts) {
    this.managerUrl = opts.managerUrl.replace(/\/+$/, '')
    this.joinToken = opts.joinToken
    this.agentDir = opts.agentDir
    this.transport = opts.transport ?? defaultTransport
    this.proc = opts.proc ?? defaultProc
    this.fs = opts.fs ?? defaultFs()
    this.maxWaitMs = opts.maxWaitMs ?? 25_000
    this.backoff = opts.backoff ?? ((ms) => sleep(ms))
    this.log = opts.log ?? ((line) => console.log(`[node-agent] ${line}`))
    this.agentId = null
    this.agentToken = null
    /** @type {Map<string, { pid:number|null, startedAt:number|null, logOffset:number }>} */
    this.nodes = new Map()
    this.retryAttempt = 0
    // M4-3: self-update version negotiation, plus exiting after the swap so the service manager restarts it
    this.agentVersion = currentAgentVersion(this.agentDir)
    this.pendingExit = false
    this.versionReportedAt = null
    // M4-4: host metric sampling (CPU = the busy share between two samples; throttled to 60s)
    this.lastMetricsAt = null
    this.lastCpuTotal = null
    this.lastCpuIdle = null
  }

  /** M4-4: a host metrics snapshot (CPU/memory/disk/uptime). A failed field is null, and it never throws. */
  collectMetrics() {
    try {
      const cpuInfo = cpus()
      const total = cpuInfo.reduce((a, c) => a + c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq, 0)
      const idle = cpuInfo.reduce((a, c) => a + c.times.idle, 0)
      let cpuPercentTenths = null
      if (this.lastCpuTotal !== null && this.lastCpuIdle !== null && total > this.lastCpuTotal) {
        const dTotal = total - this.lastCpuTotal
        const dIdle = idle - this.lastCpuIdle
        cpuPercentTenths = dTotal > 0 ? Math.round((1 - dIdle / dTotal) * 1000) : 0
      }
      this.lastCpuTotal = total
      this.lastCpuIdle = idle
      let diskTotal = null
      let diskFree = null
      try {
        const s = statfsSync(this.agentDir)
        diskTotal = Number(s.blocks) * Number(s.bsize)
        diskFree = Number(s.bavail) * Number(s.bsize)
      } catch { /* disk info is best-effort, not required */ }
      return {
        cpuPercentTenths,
        memTotal: totalmem(),
        memUsed: totalmem() - freemem(),
        diskTotal,
        diskFree,
        uptime: Math.round(uptime()),
        platform: process.platform,
      }
    } catch {
      return { cpuPercentTenths: null, memTotal: null, memUsed: null, diskTotal: null, diskFree: null, uptime: null, platform: process.platform }
    }
  }

  /** Read/restore the identity (agent.json 0600). */
  loadIdentity() {
    const raw = this.fs.readFile(`${this.agentDir}/agent.json`)
    if (raw === null) return
    try {
      const parsed = JSON.parse(raw)
      if (typeof parsed.agentId === 'string' && typeof parsed.agentToken === 'string') {
        this.agentId = parsed.agentId
        this.agentToken = parsed.agentToken
      }
    } catch { /* bad file means register again */ }
  }

  saveIdentity() {
    this.fs.mkdir(this.agentDir)
    this.fs.writeFile(`${this.agentDir}/agent.json`, JSON.stringify({ agentId: this.agentId, agentToken: this.agentToken }, null, 2))
  }

  async registerOnce() {
    this.loadIdentity()
    if (this.agentId !== null && this.agentToken !== null) return true
    const body = {
      joinToken: this.joinToken,
      hostname: hostname(),
      os: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      ...(this.agentVersion === null ? {} : { agentVersion: this.agentVersion }),
    }
    const res = await this.transport.register(this.managerUrl, body)
    this.agentId = res.agentId
    this.agentToken = res.agentToken
    this.saveIdentity()
    this.log(`registered as ${this.agentId}`)
    return true
  }

  nodeHome(nodeId) {
    return `${this.agentDir}/nodes/${nodeId}`
  }

  /**
   * Incident regression (2026-09-25): nodeId always comes from the manager, but once persisted it is
   * reassembled into a path by resumeNodes -- a separator or `..` in it would write outside nodes/ with the
   * agent process's permissions. The path character set is tightened to /^[A-Za-z0-9._-]+$/ and pure dots are
   * rejected, which closes the traversal.
   */
  static isSafeNodeId(nodeId) {
    return typeof nodeId === 'string' && /^[A-Za-z0-9._-]+$/.test(nodeId) && !/^\.+$/.test(nodeId)
  }

  /** Read node.pid (no file / an illegal value -> null). */
  readNodePid(nodeId) {
    if (!AgentRuntime.isSafeNodeId(nodeId)) return null
    const raw = this.fs.readFile(`${this.nodeHome(nodeId)}/node.pid`)
    if (raw === null) return null
    const pid = Number(raw.trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  }

  /**
   * Incident regression (2026-09-25): persist the spawn payload as the source of truth for "which nodes this
   * machine should have". After a host reboot memory is all gone and only the disk still knows what to launch;
   * without this payload the agent could only wait for the manager to deliver the commands again (reconciliation
   * defaults to 10 minutes).
   */
  persistSpawnPayload(nodeId, payload) {
    if (!AgentRuntime.isSafeNodeId(nodeId)) {
      this.log(`refusing to persist an illegal nodeId: ${String(nodeId)}`)
      return
    }
    try {
      this.fs.mkdir(this.nodeHome(nodeId))
      this.fs.writeFile(`${this.nodeHome(nodeId)}/spawn.json`, JSON.stringify(payload))
    } catch (error) {
      this.log(`node ${nodeId}: could not persist the spawn payload (self-recovery will be unavailable): ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Incident regression (2026-09-25): self-recovery at startup.
   *
   * Nodes are child processes of the agent -- a host reboot wipes them all. The old behavior was "wait for the
   * manager to notice a node died and deliver it again", so recovery time = a whole reconciliation cycle (10
   * minutes by default). Here the agent brings the nodes back itself from the persisted spawn.json: the nodes
   * are back the moment the process starts, and the manager merely confirms liveness afterwards, playing no part
   * in the recovery path.
   *
   * It works just as well while the manager is unreachable -- recovery depends on no network round-trip.
   * `node.stop` deletes spawn.json, so a node stopped by hand is never resurrected.
   */
  async resumeNodes() {
    const resumed = []
    // List directly instead of checking exists(nodes/) first: whether the directory exists is answered by
    // listDir along with everything else, one less "directory semantics" dependency (no readdir means there is none).
    for (const nodeId of this.listNodeIds()) {
      let payload = null
      try {
        const raw = this.fs.readFile(`${this.nodeHome(nodeId)}/spawn.json`)
        if (raw === null || raw === '') continue
        const parsed = JSON.parse(raw)
        // The nodeId in the payload must match the directory it lives in: otherwise a corrupt or tampered
        // file would turn recovery into "launch a process into an arbitrary home".
        if (parsed === null || typeof parsed !== 'object' || parsed.nodeId !== nodeId) {
          this.log(`node ${nodeId}: spawn.json does not match the directory, skipping self-recovery`)
          continue
        }
        payload = parsed
      } catch (error) {
        this.log(`node ${nodeId}: spawn.json is not parseable, skipping self-recovery (${error instanceof Error ? error.message : String(error)})`)
        continue
      }
      try {
        const outcome = await this.dispatchSpawn(payload)
        if (outcome.ok) {
          resumed.push(nodeId)
          this.log(`node ${nodeId}: recovered from the persisted payload (pid ${String(outcome.result?.pid ?? '?')})`)
        } else {
          this.log(`node ${nodeId}: self-recovery failed -- ${String(outcome.result?.message ?? 'unknown')}`)
        }
      } catch (error) {
        // One node blowing up must not drag down the recovery of the others
        this.log(`node ${nodeId}: self-recovery threw -- ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return resumed
  }

  /** The node directory names under nodes/ (an unreadable directory = empty). */
  listNodeIds() {
    const dir = `${this.agentDir}/nodes`
    const entries = this.fs.listDir?.(dir)
    if (!Array.isArray(entries)) {
      // Degraded: when the fs stub provides no listDir, only the nodes this process already knows are visible
      // (the real defaultFs always has listDir, so self-recovery is unaffected)
      return [...this.nodes.keys()].filter((name) => AgentRuntime.isSafeNodeId(name)).sort()
    }
    return entries.filter((name) => AgentRuntime.isSafeNodeId(name)).sort()
  }

  /** Make sure the pinned DSH version is installed in the agent's own prefix and return the absolute bin.js path. */
  async ensureDsh(dshVersion) {
    const version = typeof dshVersion === 'string' && dshVersion !== '' ? dshVersion : '0.1.2-rc.1'
    const bin = `${this.agentDir}/dsh/${version}/node_modules/${DSH_PACKAGE}/lib/bin.js`
    if (this.fs.exists(bin)) return bin
    this.fs.mkdir(`${this.agentDir}/dsh/${version}`)
    const legacy = LEGACY_PEER_DEPS_VERSIONS.includes(version)
    this.log(`installing ${DSH_PACKAGE}@${version} into agent prefix${legacy ? ' (--legacy-peer-deps)' : ''}`)
    return this.proc.install(this.agentDir, version, legacy)
  }

  async execSpawn(command) {
    const payload = command.payload ?? {}
    const nodeId = payload.nodeId
    this.persistSpawnPayload(nodeId, payload)
    return this.dispatchSpawn(payload)
  }

  /**
   * Incident regression (2026-09-25 EADDRINUSE): one spawn carried all the way through.
   *
   * The idempotency gate comes first -- the manager re-queues node.spawn on every reconciliation round, and only
   * the agent itself knows whether this node is already running locally. Without that gate every reconciliation
   * round launched another DSH process, and the two fought over the same port = `EADDRINUSE 0.0.0.0:3197`.
   * The gate sits at the very front: when it is already alive, not even the profile install has to be redone.
   */
  async dispatchSpawn(payload) {
    const nodeId = payload.nodeId
    const home = this.nodeHome(nodeId)
    const dshHome = payload.env?.DSH_HOME ?? home
    this.fs.mkdir(home)
    this.fs.mkdir(dshHome)

    const runningPid = this.readNodePid(nodeId)
    if (runningPid !== null && (await this.proc.alive(runningPid))) {
      this.nodes.set(nodeId, {
        pid: runningPid,
        startedAt: this.nodes.get(nodeId)?.startedAt ?? Date.now(),
        logOffset: this.nodes.get(nodeId)?.logOffset ?? 0,
      })
      this.log(`node ${nodeId} is already running (pid ${runningPid}) -- skipping a duplicate spawn`)
      return { ok: true, result: { pid: runningPid, alreadyRunning: true } }
    }
    // The key: GW_KEY in the spawn payload's env, materialized VERSION-GATED (0.2.0 corridor,
    // dsh-facts §18.5 / upgrade card J1-04; the container entrypoint gates the same way -- one
    // derived delivery, three landing ends):
    //   - legacy lines (0.1.2/0.1.5): DSH_HOME/settings.yaml (the facade settings namespace);
    //   - 0.1.7+/0.2.x: settings.yaml is a one-shot import and ctx.settings.register is gone
    //     host-side -- the key rides the profile's cordis.patch.yml composition row instead
    //     (appended to the delivered profile files below, never baked by the manager).
    // Fleet M3: ALLOW_FULL_ACCESS=true (an ops node) -> the facade's allowFullAccess is unlocked
    // (dangerous operations still need an approval card, and the facade logs a risk warning).
    const version = typeof payload.dshVersion === 'string' && payload.dshVersion !== '' ? payload.dshVersion : '0.1.2-rc.1'
    const legacyLine = LEGACY_DSH_LINE_RE.test(version)
    const gwKey = typeof payload.env?.GW_KEY === 'string' && payload.env.GW_KEY !== '' ? payload.env.GW_KEY : null
    const gwFullAccess = payload.env?.ALLOW_FULL_ACCESS === 'true'
    if (gwKey !== null && legacyLine) {
      const fullAccess = gwFullAccess ? '\n  allowFullAccess: true' : ''
      this.fs.writeFile(`${dshHome}/settings.yaml`, `ohdsh-api-facade:\n  apiKeys: ['${gwKey}']${fullAccess}\n`)
    }
    try {
      const legacy = LEGACY_PEER_DEPS_VERSIONS.includes(version)
      // Derived delivery (M1-6): write the profile files (idempotent, rewritten only when the content changed) + install the dependencies.
      // M2 regression: a warm npm install still takes minutes on a slow disk -- unchanged files + the completion
      // marker from the last install = skip the reinstall (.installed-ok is written after a successful install, so an
      // interrupted half-install has no marker and falls back to reinstalling).
      let profileDir = null
      if (payload.profile !== null && payload.profile !== undefined) {
        profileDir = `${dshHome}/${payload.profile.dir}`
        this.fs.mkdir(profileDir)
        const files = { ...(payload.profile.files ?? {}) }
        // 0.2.0 corridor: append the facade key row to the delivered patch baseline on the new lines.
        // The manager never bakes keys into payload files, so the baseline carries no facade row --
        // appending to the freshly built content keeps exactly one row per spawn (idempotent by
        // construction: the file is rewritten from the payload baseline first).
        if (gwKey !== null && !legacyLine && typeof files['cordis.patch.yml'] === 'string') {
          files['cordis.patch.yml'] += `- id: ohdsh-api-facade\n  config:\n    apiKeys: ['${gwKey}']\n${gwFullAccess ? '    allowFullAccess: true\n' : ''}`
        }
        let changed = false
        for (const [name, content] of Object.entries(files)) {
          if (this.fs.readFile(`${profileDir}/${name}`) !== String(content)) {
            this.fs.writeFile(`${profileDir}/${name}`, String(content))
            // The patch file carries no dependencies: a key rotation (or a bind tweak) must not
            // trigger the minutes-long reinstall (the patch applies at boot on every line).
            if (name !== 'cordis.patch.yml') changed = true
          }
        }
        const installedMarker = `${profileDir}/.installed-ok`
        if (changed || !this.fs.exists(installedMarker)) {
          await this.proc.installProfile?.(profileDir, legacy)
          this.fs.writeFile(installedMarker, String(Date.now()))
        }
      }
      // fleet.md derived delivery (checklist A: a node only reads the fleet.md delivered by the manager)
      if (typeof payload.fleetMd === 'string' && payload.fleetMd !== '') {
        if (this.fs.readFile(`${dshHome}/fleet.md`) !== payload.fleetMd) {
          this.fs.writeFile(`${dshHome}/fleet.md`, payload.fleetMd)
        }
      }
      // Proven in the M1 pilot: a profile-local bin wins -- a profile dependency install carries a lock file and
      // explicit peers (profileFiles generates them on the manager side), whereas the standalone prefix tree is
      // missing the peers that legacy skipped and crashes on startup (ERR_MODULE_NOT_FOUND). With a profile-local bin, never use the prefix.
      const profileBin = profileDir === null ? null : `${profileDir}/node_modules/${DSH_PACKAGE}/lib/bin.js`
      const bin = profileBin !== null && this.fs.exists(profileBin) ? profileBin : await this.ensureDsh(payload.dshVersion)
      // M4-2: an oversized old log is rotated before the spawn (the old fd is closed by now, so the rename works on Windows too);
      // one generation is kept as .1 for crash triage, and the new log starts from zero.
      const logPath = `${home}/node.log`
      const logSize = this.fs.stat(logPath)
      if (logSize !== null && logSize > NODE_LOG_MAX_BYTES) {
        try {
          this.fs.remove(`${logPath}.1`)
        } catch { /* .1 is missing or cannot be removed -- not fatal */ }
        this.fs.rename(logPath, `${logPath}.1`)
        this.log(`node ${nodeId}: node.log exceeded its limit (${logSize} bytes) and was rotated to .1`)
      }
      const env = { ...(payload.env ?? {}), DSH_HOME: dshHome }
      const { pid } = await this.proc.spawn(bin, payload.args ?? [], env, logPath)
      this.fs.writeFile(`${home}/node.pid`, String(pid))
      this.nodes.set(nodeId, { pid, startedAt: Date.now(), logOffset: 0 })
      this.log(`node ${nodeId} spawned (pid ${pid})`)
      return { ok: true, result: { pid } }
    } catch (error) {
      return { ok: false, result: { message: error instanceof Error ? error.message : String(error) } }
    }
  }

  async execStop(command) {
    const payload = command.payload ?? {}
    const nodeId = payload.nodeId
    const node = this.nodes.get(nodeId)
    const home = this.nodeHome(nodeId)
    const pidRaw = node?.pid ?? (this.fs.readFile(`${home}/node.pid`) ?? null)
    const pid = pidRaw === null ? null : Number(pidRaw)
    if (pid !== null && Number.isInteger(pid) && pid > 0) {
      try {
        await this.proc.kill(pid)
        this.log(`node ${nodeId} stopped (pid ${pid})`)
      } catch (error) {
        return { ok: false, result: { message: error instanceof Error ? error.message : String(error) } }
      }
    }
    this.nodes.set(nodeId, { pid: null, startedAt: null, logOffset: node?.logOffset ?? 0 })
    // Incident regression (2026-09-25): stop = intent, not just the action of the moment. Delete the persisted payload,
    // otherwise the agent would pull back the node the human explicitly stopped from spawn.json as soon as it restarts.
    // (node.restart goes stop->spawn, and the spawn right after it persists the payload again, so it is unaffected.)
    if (AgentRuntime.isSafeNodeId(nodeId)) {
      try {
        this.fs.remove(`${home}/spawn.json`)
      } catch { /* nothing there to begin with -- fine */ }
    }
    return { ok: true, result: { pid: pid ?? null } }
  }

  async execRestart(command) {
    const stop = await this.execStop(command)
    if (!stop.ok) return stop
    const spawnCommand = { payload: command.payload }
    return this.execSpawn(spawnCommand)
  }

  async execLogs(command) {
    const payload = command.payload ?? {}
    const home = this.nodeHome(payload.nodeId)
    const lines = this.fs.readFile(`${home}/node.log`) ?? ''
    const tail = lines.length > 16_000 ? lines.slice(lines.length - 16_000) : lines
    return { ok: true, result: { logs: tail } }
  }

  async execStatus() {
    const status = []
    for (const [nodeId, node] of this.nodes) {
      const alive = node.pid === null ? false : await this.proc.alive(node.pid)
      status.push({ nodeId, pid: node.pid, running: alive, startedAt: node.startedAt })
    }
    return { ok: true, result: { nodes: status } }
  }

  /** M4-1: config.deliver -- identity rotation (the new token is persisted and takes effect immediately). */
  async execDeliver(command) {
    const payload = command.payload ?? {}
    if (payload.kind !== 'identity' || typeof payload.agentToken !== 'string' || payload.agentToken === '') {
      return { ok: false, result: { message: `unsupported config.deliver kind: ${String(payload.kind)}` } }
    }
    this.agentToken = payload.agentToken
    this.saveIdentity()
    this.log('identity rotated (the new agentToken is on disk)')
    return { ok: true, result: { rotated: true } }
  }

  /** M4-3: agent.update -- verify -> stage into .next -> report, then exit so the service manager restarts it. */
  async execUpdate(command) {
    const payload = command.payload ?? {}
    const files = payload.files ?? {}
    const runtimeContent = files['runtime.mjs']
    const entryContent = files['agent.mjs']
    if (typeof runtimeContent !== 'string' || typeof entryContent !== 'string' || runtimeContent === '' || entryContent === '') {
      return { ok: false, result: { message: 'agent.update payload missing files (agent.mjs/runtime.mjs)' } }
    }
    const { createHash } = await import('node:crypto')
    // The digest = "file name + content" joined in file-name order (isomorphic to the manager side)
    const digest = createHash('sha256')
      .update(Object.keys(files).sort().map((name) => `${name}:${files[name]}`).join('\n'))
      .digest('hex')
    if (payload.sha256 !== digest) {
      return { ok: false, result: { message: 'sha256 mismatch -- the update package failed verification and was rejected' } }
    }
    const nextDir = `${this.agentDir}/.next`
    this.fs.mkdir(nextDir)
    for (const [name, content] of Object.entries(files)) {
      if (typeof content === 'string') this.fs.writeFile(`${nextDir}/${name}`, content)
    }
    if (typeof payload.managerVersion === 'string' && payload.managerVersion !== '') {
      this.fs.writeFile(`${nextDir}/.version`, payload.managerVersion)
    }
    this.pendingExit = true
    this.log(`agent.update verified (-> ${String(payload.managerVersion ?? '?')}); after reporting, exiting so the service manager reloads the new code`)
    return { ok: true, result: { staged: true } }
  }

  async execute(command) {
    if (command.type === 'node.spawn') return this.execSpawn(command)
    if (command.type === 'node.stop') return this.execStop(command)
    if (command.type === 'node.restart') return this.execRestart(command)
    if (command.type === 'node.logs') return this.execLogs(command)
    if (command.type === 'node.status') return this.execStatus(command)
    if (command.type === 'config.deliver') return this.execDeliver(command)
    if (command.type === 'agent.update') return this.execUpdate(command)
    return { ok: false, result: { message: `command type ${command.type} not implemented in this agent version` } }
  }

  /** The log growth per polling cycle (sent back in chunks, into the manager's ring buffer). */
  collectLogChunks() {
    const events = []
    for (const [nodeId, node] of this.nodes) {
      const lines = this.fs.readFile(`${this.nodeHome(nodeId)}/node.log`) ?? ''
      if (node.logOffset >= lines.length) continue
      const chunk = lines.slice(node.logOffset)
      events.push({ type: 'log_chunk', nodeId, chunk: chunk.slice(0, 32_000) })
      node.logOffset = lines.length
    }
    return events
  }

  /** One round: take commands -> execute -> report the results plus the log growth. Returns whether anything failed this round. */
  async loopOnce() {
    if (this.agentId === null || this.agentToken === null) throw new Error('not registered')
    const commands = await this.transport.commands(this.managerUrl, this.agentId, this.agentToken, this.maxWaitMs)
    const events = []
    for (const command of commands) {
      const outcome = await this.execute(command)
      events.push({ type: 'command_result', commandId: command.id, ok: outcome.ok, result: outcome.result })
    }
    events.push(...this.collectLogChunks())
    // M4-3/M4-4: version negotiation (first loop + every 10 minutes) and host metrics (sampled every 60s) merged into the heartbeat
    const now = Date.now()
    const versionDue = this.versionReportedAt === null || now - this.versionReportedAt > 10 * 60_000
    const metricsDue = this.lastMetricsAt === null || now - this.lastMetricsAt > 60_000
    if (versionDue || metricsDue) {
      const detail = {}
      if (versionDue) {
        detail.agentVersion = this.agentVersion
        this.versionReportedAt = now
      }
      if (metricsDue) {
        detail.metrics = this.collectMetrics()
        this.lastMetricsAt = now
      }
      events.push({ type: 'heartbeat', detail })
    }
    if (events.length > 0) {
      await this.transport.events(this.managerUrl, this.agentId, this.agentToken, events)
    }
    return commands.length
  }

  /**
   * The resident loop: register -> poll; network failures back off exponentially (1s->30s) and it never exits.
   * An AbortSignal can be passed for a clean exit (for tests and shutdown).
   * Every iteration ends with `sleep(0)` to yield the event loop -- an instantly resolving transport starves
   * microtasks in tests and failure scenarios, so the timers (signal/heartbeat) would never run.
   * M4-3: once the swap is staged, the report in this round is followed by an exit (the service manager restarts
   * it to load the new code).
   * Note: it exits with a non-zero code -- the Windows scheduled task restarts on failure (RestartOnFailure),
   * while systemd Restart=always is unaffected; restarting after a swap is designed behavior.
   */
  async run(opts = {}) {
    // Incident regression (2026-09-25): self-recovery deliberately runs before registration -- after a host reboot
    // the nodes should come back at once instead of waiting for the manager to be reachable. Recovery is purely local
    // (read spawn.json + spawn the processes), it depends on no network round-trip; the manager confirms liveness later.
    try {
      const resumed = await this.resumeNodes()
      if (resumed.length > 0) this.log(`startup recovery: resumed ${resumed.join(', ')}`)
    } catch (error) {
      this.log(`startup recovery failed (agent startup continues): ${error instanceof Error ? error.message : String(error)}`)
    }
    await this.registerOnce()
    for (;;) {
      if (opts?.signal?.aborted === true) return
      try {
        await this.loopOnce()
        this.retryAttempt = 0
        if (this.pendingExit === true) {
          this.log('agent.update reported -- exiting non-zero so the service manager reloads the new code')
          process.exit(1)
        }
      } catch (error) {
        if (error instanceof Error && error.message === 'unauthorized') {
          this.log('identity rejected (revoked or invalid) -- clearing it and registering again')
          this.agentId = null
          this.agentToken = null
          this.fs.writeFile(`${this.agentDir}/agent.json`, '')
          await this.registerOnce()
        } else {
          this.retryAttempt += 1
          const delay = Math.min(1_000 * 2 ** Math.max(0, this.retryAttempt - 1), 30_000)
          this.log(`manager unreachable (attempt ${this.retryAttempt}), retrying in ${delay}ms`)
          await this.backoff(delay)
          if (opts?.signal?.aborted === true) return
        }
      }
      await sleep(0)
    }
  }
}

function defaultFs() {
  return {
    readFile: (p) => {
      try {
        return readFileSync(p, 'utf8')
      } catch {
        return null
      }
    },
    writeFile: (p, c) => {
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, c, 'utf8')
      if (p.endsWith('agent.json') || p.endsWith('settings.yaml')) {
        try {
          chmodSync(p, 0o600)
        } catch { /* no-op on Windows */ }
      }
    },
    mkdir: (p) => mkdirSync(p, { recursive: true }),
    exists: (p) => existsSync(p),
    stat: (p) => {
      try {
        return statSync(p).size
      } catch {
        return null
      }
    },
    rename: (from, to) => renameSync(from, to),
    remove: (p) => rmSync(p, { force: true }),
    /** Incident regression (2026-09-25): listing the nodes/ directory -- the discovery entry point for self-recovery after a restart. */
    listDir: (p) => {
      try {
        return readdirSync(p)
      } catch {
        return null
      }
    },
  }
}
