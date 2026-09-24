import { readFileSync, existsSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { loadConfig } from '../config.js'
import { buildClients } from '../gateway/client.js'
import { buildUpstreamClients } from '../upstream/client.js'
import { buildNodeSupervisors } from '../nodes/registry.js'
import type { NodeSupervisor } from '../nodes/supervisor.js'

/**
 * `npm run nodes -- <up|down|list|logs> [endpoint-id]`
 *
 * 蜂群 P1：管理配置里 spawn.managed 的节点进程。
 * - list          列出所有被托管节点的状态（未托管端点不显示）
 * - up [id]       拉起节点并等待 live/offline（幂等：已在跑则直接报状态）
 * - down [id]     停止节点（幂等）
 * - logs [id]     打印该节点捕获的 stdout/stderr 缓冲
 *
 * 债务 C2:纯函数导出供测试;main 只在直接执行时运行(与 setup 同模式)。
 */

type Command = 'up' | 'down' | 'list' | 'logs'

const usage = (): void => {
  console.error('usage: npm run nodes -- <list|up|down|logs> [endpoint-id]')
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export const pidFileOf = (logFile: string | null): string | null => (logFile === null ? null : logFile + '.pid')

/** Kill a detached node by its pidfile (the CLI has no in-memory child handle). */
const killByPidFile = (pidFile: string): boolean => {
  const pid = readFileSync(pidFile, 'utf8').trim()
  if (pid === '') return false
  const result = spawnSync('taskkill', ['/pid', pid, '/T', '/F'], { windowsHide: true })
  if (result.error !== undefined) return false
  try {
    rmSync(pidFile, { force: true })
  } catch {
    // stale pidfile is harmless: `up` will refuse until it is gone
  }
  return true
}

export const waitSettled = async (node: NodeSupervisor, what: string, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = node.current.state
    if (what === 'up' && (state === 'live' || state === 'offline')) return state === 'live'
    if (what === 'down' && state === 'cold') return true
    await sleep(250)
  }
  return false
}

const printStatus = (node: NodeSupervisor): void => {
  const s = node.current
  const line = [
    s.id.padEnd(12),
    s.state.padEnd(10),
    `pid=${s.pid === null ? '-' : String(s.pid)}`.padEnd(12),
    `attempts=${s.attempts}`.padEnd(12),
    s.lastError ?? '',
  ].join(' ')
  console.log(line)
}

const main = (): void => {
  const argv = process.argv.slice(2)
  const command = argv[0] as Command | undefined
  const target = argv[1] ?? null
  if (command === undefined || !['list', 'up', 'down', 'logs'].includes(command)) {
    usage()
    process.exit(2)
  }

  const config = loadConfig()
  const clients = buildClients(config.endpoints)
  const upstreamClients = buildUpstreamClients(config.endpoints)
  const supervisors = buildNodeSupervisors(config, {
    gateway: (id) => clients.get(id),
    upstream: (id) => upstreamClients.get(id),
    log: (line) => console.log(line),
  })

  if (command === 'list') {
    if (supervisors.size === 0) {
      console.log('(no managed nodes: set spawn.managed: true on an endpoint and restart the manager)')
      return
    }
    for (const [id, node] of supervisors) {
      // 跨进程推断：本 CLI 进程没拉过这个节点，但 pidfile 说明上次 detached
      // 启动的进程可能还活着。
      const spec = config.endpoints[id]?.spawn
      const pidFile = pidFileOf(spec?.logFile ?? null)
      if (node.current.state === 'cold' && pidFile !== null && existsSync(pidFile)) {
        const pid = readFileSync(pidFile, 'utf8').trim()
        console.log(`${id.padEnd(12)} detached   pid=${pid === '' ? '-' : pid}`.padEnd(36) + '(inferred from pidfile)')
        continue
      }
      printStatus(node)
    }
    return
  }

  if (target === null) {
    usage()
    process.exit(2)
  }
  const node = supervisors.get(target)
  if (node === undefined) {
    console.error(`endpoint "${target}" does not exist or is not managed (no spawn.managed: true in the config).`)
    process.exit(2)
  }
  const endpoint = config.endpoints[target]
  if (endpoint === undefined || endpoint.spawn === null) {
    console.error(`endpoint "${target}" has no spawn config.`)
    process.exit(2)
  }
  const spec = endpoint.spawn

  void (async (): Promise<void> => {
    if (command === 'up') {
      const pidFile = pidFileOf(spec.logFile)
      if (pidFile !== null && existsSync(pidFile)) {
        console.error(`node "${target}" looks like it is already running (pidfile: ${pidFile}). Run down before up.`)
        process.exit(2)
      }
      // managed 且无 logFile 的节点是「manager 常驻托管」形态：CLI 拉起的子进程
      // 随本进程退出变孤儿，manager 进程的状态机也不知情（侧栏仍是 offline）。
      // 正确姿势是重启 manager 由其拉起；CLI 只适合 detached + log_file 的独立节点。
      if (spec.logFile === null) {
        console.log(`note: ${target} is managed by the manager (no log_file). A process started from the CLI is not tracked by the manager,`)
        console.log('     so the sidebar will not reflect it — restart the manager and let it start the node; this command is for temporary debugging.')
      }
      node.start(spec)
      const ok = await waitSettled(node, 'up', spec.readyTimeoutMs + 15_000)
      printStatus(node)
      process.exit(ok ? 0 : 1)
    } else if (command === 'down') {
      const pidFile = pidFileOf(spec.logFile)
      // 跨进程路径：该 CLI 进程没拉过这个节点，但 pidfile 里有上次 detached
      // 启动的 pid。
      if (node.current.state === 'cold' && pidFile !== null && existsSync(pidFile)) {
        if (killByPidFile(pidFile)) {
          console.log(`node ${target}: killed (pidfile ${pidFile})`)
        } else {
          console.error(`node ${target}: could not kill the process from its pidfile`)
          process.exit(1)
        }
      } else {
        node.stop()
        await waitSettled(node, 'down', 15_000)
        printStatus(node)
      }
    } else {
      // logs：内存缓冲（manager 常驻/刚 up 的节点）优先；没有则回退读日志文件。
      const buffered = node.logs()
      if (buffered !== '') process.stdout.write(buffered)
      else if (spec.logFile !== null && existsSync(spec.logFile)) process.stdout.write(readFileSync(spec.logFile, 'utf8'))
      else console.log('(no logs: the node is not running, or has no log_file configured)')
    }
  })()
}

const isDirect = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirect) main()
