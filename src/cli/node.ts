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
 * Hive P1: node processes from spawn.managed in the manager config.
 * - list          list every managed node's state (unmanaged endpoints are not shown)
 * - up [id]       start a node and wait for live/offline (idempotent: an already running node just reports its state)
 * - down [id]     stop a node (idempotent)
 * - logs [id]     print the node's captured stdout/stderr buffer
 *
 * Debt C2: pure functions are exported for tests; main runs only when executed directly (the same pattern as setup).
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
      // Inferred across processes: this CLI process never started this node, but the pidfile says
      // the process from an earlier detached start may still be alive.
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
      // A managed node with no logFile is the "the manager keeps it running" shape: a child started by the CLI
      // turns into an orphan once this process exits, and the manager's state machine knows nothing about it (the sidebar stays offline).
      // The right move is to restart the manager and let it start the node; the CLI suits only a standalone detached + log_file node.
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
      // The across-process path: this CLI process never started this node, but the pidfile holds
      // the pid from an earlier detached start.
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
      // logs: the in-memory buffer comes first (a node kept by the manager, or one just brought up); otherwise fall back to reading the log file.
      const buffered = node.logs()
      if (buffered !== '') process.stdout.write(buffered)
      else if (spec.logFile !== null && existsSync(spec.logFile)) process.stdout.write(readFileSync(spec.logFile, 'utf8'))
      else console.log('(no logs: the node is not running, or has no log_file configured)')
    }
  })()
}

const isDirect = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirect) main()
