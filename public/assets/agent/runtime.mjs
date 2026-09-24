// @ts-check
/**
 * 能力四（舰队 M1-5）：node-agent 运行时——零原生依赖（Node ≥20），
 * 出站拨号 manager（长轮询指令 + 事件回报），管理本机 DSH 节点进程。
 *
 * 纪律：
 * - 固定指令集，绝不提供通用 shell；
 * - 身份与状态只落 <agentDir>/agent.json（0600，token 明文只在首次注册出现）；
 * - manager 失联：节点照跑，指数退避重连；指令执行与回报都在本地闭环。
 *
 * 注入面（测试用）：transport / proc / fs / install / backoff。
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { hostname, totalmem, freemem, cpus, uptime } from 'node:os'
import { currentAgentVersion } from './update.mjs'

/** 与 src/dsh-matrix.ts 的 needsLegacyPeerDeps 保持一致（check-docs.mjs 常驻断言）。 */
export const LEGACY_PEER_DEPS_VERSIONS = ['0.1.5-rc.2']

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
 * npm 调用契约（M1 试点 Windows 实证回归）：npm 是 .cmd 垫片，node ≥20
 * 无 shell 直接 execFile 会 ENOENT/EINVAL（CVE-2024-27980，manager 侧
 * setup.ts L543 同款坑）——恒 shell:true 交给系统 shell 解析；安装目录只走
 * cwd，绝不进参数（路径带空格会被 shell 连接时拆断）。
 */
export const npmInvocation = (args, cwd) => ({
  cmd: 'npm',
  args,
  options: { cwd, shell: true, stdio: ['ignore', 'inherit', 'inherit'] },
})

/**
 * spawn 调用契约（M1 试点 Windows 实证回归）：bin.js 在 Windows 上没有可执行
 * 语义（CreateProcess 无 shebang → EFTYPE）——win32 必须以 node 为命令、bin
 * 转第一个参数（manager 侧 supervisor 同款「command: node」接线）；posix 直接
 * spawn（shebang）。
 */
export const spawnInvocation = (platform, bin, args) =>
  platform === 'win32'
    ? { cmd: process.execPath, args: [bin, ...args] }
    : { cmd: bin, args }

/** 能力四（M4-2）：node.log 单代上限——spawn 前超限即轮转（保留一代）。 */
export const NODE_LOG_MAX_BYTES = 50 * 1024 * 1024

const defaultProc = {
  /** 安装 DSH 到 agent 自有 prefix（不碰用户全局 npm）。 */
  install: async (agentDir, version, legacyPeerDeps) => {
    const { execFileSync } = await import('node:child_process')
    const prefix = `${agentDir}/dsh/${version}`
    const args = ['install', `${DSH_PACKAGE}@${version}`, '--no-audit', '--no-fund']
    if (legacyPeerDeps) args.push('--legacy-peer-deps')
    const inv = npmInvocation(args, prefix)
    execFileSync(inv.cmd, inv.args, inv.options)
    return `${prefix}/node_modules/${DSH_PACKAGE}/lib/bin.js`
  },
  /** 派生下发（M1-6）：profile 依赖安装（cwd = profile 目录，钉版全在文件里）。 */
  installProfile: async (profileDir, legacyPeerDeps) => {
    const { execFileSync } = await import('node:child_process')
    const args = ['install', '--no-audit', '--no-fund']
    if (legacyPeerDeps) args.push('--legacy-peer-deps')
    const inv = npmInvocation(args, profileDir)
    execFileSync(inv.cmd, inv.args, inv.options)
  },
  /** 拉起节点进程（detached + 文件流），返回 pid。 */
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
  /** 停节点：先 TERM 等 5s 再 KILL（Windows 走 taskkill /T /F）。 */
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
      } catch { /* 已退出 */ }
    } catch { /* 已不在 */ }
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
    // M4-3：自更新版本协商 + 换装后退出交给服务管理器重启
    this.agentVersion = currentAgentVersion(this.agentDir)
    this.pendingExit = false
    this.versionReportedAt = null
    // M4-4：主机指标采样（CPU 用两次采样间忙占比；60s 节流）
    this.lastMetricsAt = null
    this.lastCpuTotal = null
    this.lastCpuIdle = null
  }

  /** M4-4：主机指标快照（CPU/内存/磁盘/运行时长）。失败字段为 null，绝不抛。 */
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
      } catch { /* 磁盘信息拿不到不强求 */ }
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

  /** 读/恢复身份（agent.json 0600）。 */
  loadIdentity() {
    const raw = this.fs.readFile(`${this.agentDir}/agent.json`)
    if (raw === null) return
    try {
      const parsed = JSON.parse(raw)
      if (typeof parsed.agentId === 'string' && typeof parsed.agentToken === 'string') {
        this.agentId = parsed.agentId
        this.agentToken = parsed.agentToken
      }
    } catch { /* 坏文件 = 重新注册 */ }
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

  /** 确保 DSH 钉版装在 agent 自有 prefix，返回 bin.js 绝对路径。 */
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
    const home = this.nodeHome(nodeId)
    const dshHome = payload.env?.DSH_HOME ?? home
    this.fs.mkdir(home)
    this.fs.mkdir(dshHome)
    // 钥匙：spawn 载荷 env 里的 GW_KEY → DSH_HOME/settings.yaml（facade 只读
    // settings；容器 entrypoint 同款派生，单向下发）。
    // 舰队 M3：ALLOW_FULL_ACCESS=true（ops 节点）→ facade allowFullAccess 开锁
    // （危险操作仍需 approval 卡片放行，facade 侧风险告警日志）。
    if (typeof payload.env?.GW_KEY === 'string' && payload.env.GW_KEY !== '') {
      const fullAccess = payload.env.ALLOW_FULL_ACCESS === 'true' ? '\n  allowFullAccess: true' : ''
      this.fs.writeFile(`${dshHome}/settings.yaml`, `ohdsh-api-facade:\n  apiKeys: ['${payload.env.GW_KEY}']${fullAccess}\n`)
    }
    try {
      const version = typeof payload.dshVersion === 'string' && payload.dshVersion !== '' ? payload.dshVersion : '0.1.2-rc.1'
      const legacy = LEGACY_PEER_DEPS_VERSIONS.includes(version)
      // 派生下发（M1-6）：profile 文件落盘（幂等，内容不变不重写）+ 依赖安装。
      // M2 回归：慢盘上 warm npm install 仍以分钟计——文件未变 + 上次安装
      // 完成标记存在 = 跳过重装（.installed-ok 由安装成功后写入，中断的
      // 半装态无标记 → 重装兜底）。
      let profileDir = null
      if (payload.profile !== null && payload.profile !== undefined) {
        profileDir = `${dshHome}/${payload.profile.dir}`
        this.fs.mkdir(profileDir)
        const files = payload.profile.files ?? {}
        let changed = false
        for (const [name, content] of Object.entries(files)) {
          if (this.fs.readFile(`${profileDir}/${name}`) !== String(content)) {
            this.fs.writeFile(`${profileDir}/${name}`, String(content))
            changed = true
          }
        }
        const installedMarker = `${profileDir}/.installed-ok`
        if (changed || !this.fs.exists(installedMarker)) {
          await this.proc.installProfile?.(profileDir, legacy)
          this.fs.writeFile(installedMarker, String(Date.now()))
        }
      }
      // fleet.md 派生下发（A 清单：节点只读 manager 下发的 fleet.md）
      if (typeof payload.fleetMd === 'string' && payload.fleetMd !== '') {
        if (this.fs.readFile(`${dshHome}/fleet.md`) !== payload.fleetMd) {
          this.fs.writeFile(`${dshHome}/fleet.md`, payload.fleetMd)
        }
      }
      // M1 试点实证：profile-local bin 优先——profile 依赖安装带锁文件与显式
      // peer（manager 侧 profileFiles 生成），而 prefix 独立装树缺 legacy 跳过的
      // peer，启动即崩（ERR_MODULE_NOT_FOUND）。有 profile-local bin 绝不用 prefix。
      const profileBin = profileDir === null ? null : `${profileDir}/node_modules/${DSH_PACKAGE}/lib/bin.js`
      const bin = profileBin !== null && this.fs.exists(profileBin) ? profileBin : await this.ensureDsh(payload.dshVersion)
      // M4-2：旧日志超限在 spawn 前轮转（此刻旧 fd 已关闭，Windows 也能 rename）；
      // 保留一代 .1 供崩溃排障，新日志从零开始。
      const logPath = `${home}/node.log`
      const logSize = this.fs.stat(logPath)
      if (logSize !== null && logSize > NODE_LOG_MAX_BYTES) {
        try {
          this.fs.remove(`${logPath}.1`)
        } catch { /* .1 不存在或不可删——不阻断 */ }
        this.fs.rename(logPath, `${logPath}.1`)
        this.log(`node ${nodeId}: node.log 超限（${logSize} 字节）已轮转到 .1`)
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

  /** M4-1：config.deliver——身份轮换（新 token 落盘并立即生效）。 */
  async execDeliver(command) {
    const payload = command.payload ?? {}
    if (payload.kind !== 'identity' || typeof payload.agentToken !== 'string' || payload.agentToken === '') {
      return { ok: false, result: { message: `unsupported config.deliver kind: ${String(payload.kind)}` } }
    }
    this.agentToken = payload.agentToken
    this.saveIdentity()
    this.log('身份已轮换（新 agentToken 已落盘）')
    return { ok: true, result: { rotated: true } }
  }

  /** M4-3：agent.update——校验 → staging 到 .next → 回报后退出交给服务管理器重启。 */
  async execUpdate(command) {
    const payload = command.payload ?? {}
    const files = payload.files ?? {}
    const runtimeContent = files['runtime.mjs']
    const entryContent = files['agent.mjs']
    if (typeof runtimeContent !== 'string' || typeof entryContent !== 'string' || runtimeContent === '' || entryContent === '') {
      return { ok: false, result: { message: 'agent.update payload missing files (agent.mjs/runtime.mjs)' } }
    }
    const { createHash } = await import('node:crypto')
    // 摘要 = 按文件名排序的「文件名 + 内容」拼接（与 manager 侧同构）
    const digest = createHash('sha256')
      .update(Object.keys(files).sort().map((name) => `${name}:${files[name]}`).join('\n'))
      .digest('hex')
    if (payload.sha256 !== digest) {
      return { ok: false, result: { message: 'sha256 mismatch — 更新包校验失败，拒绝换装' } }
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
    this.log(`agent.update 校验通过（→ ${String(payload.managerVersion ?? '?')}），回报后将退出交给服务管理器重启`)
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

  /** 每个轮询周期的日志增量（分块回传，manager 侧环形缓冲）。 */
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

  /** 一轮：领指令 → 执行 → 回报结果 + 日志增量。返回本轮是否有过失败。 */
  async loopOnce() {
    if (this.agentId === null || this.agentToken === null) throw new Error('not registered')
    const commands = await this.transport.commands(this.managerUrl, this.agentId, this.agentToken, this.maxWaitMs)
    const events = []
    for (const command of commands) {
      const outcome = await this.execute(command)
      events.push({ type: 'command_result', commandId: command.id, ok: outcome.ok, result: outcome.result })
    }
    events.push(...this.collectLogChunks())
    // M4-3/M4-4：版本协商（首循环 + 每 10 分钟）与主机指标（60s 采样）合并进心跳
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
   * 常驻循环：注册 → 轮询；网络失败指数退避（1s→30s），永不退出。
   * 可传 AbortSignal 干净退出（测试/停机用）。
   * 每轮迭代后 `sleep(0)` 让出事件循环——瞬时 resolve 的传输在测试/故障
   * 场景下会微任务饥饿，定时器（信号/心跳）永远得不到执行。
   * M4-3：换装 staging 完成后本轮回报即退出（服务管理器重启加载新代码）。
   * 注意：以非零码退出——Windows 计划任务按失败重启（RestartOnFailure），
   * systemd Restart=always 不受影响；换装后的重启是设计内行为。
   */
  async run(opts = {}) {
    await this.registerOnce()
    for (;;) {
      if (opts?.signal?.aborted === true) return
      try {
        await this.loopOnce()
        this.retryAttempt = 0
        if (this.pendingExit === true) {
          this.log('agent.update 已回报——以非零码退出，交给服务管理器重启加载新代码')
          process.exit(1)
        }
      } catch (error) {
        if (error instanceof Error && error.message === 'unauthorized') {
          this.log('身份被拒（吊销/失效）——清身份后重新注册')
          this.agentId = null
          this.agentToken = null
          this.fs.writeFile(`${this.agentDir}/agent.json`, '')
          await this.registerOnce()
        } else {
          this.retryAttempt += 1
          const delay = Math.min(1_000 * 2 ** Math.max(0, this.retryAttempt - 1), 30_000)
          this.log(`manager 不可达（第 ${this.retryAttempt} 次），${delay}ms 后重试`)
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
        } catch { /* Windows 空操作 */ }
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
  }
}
