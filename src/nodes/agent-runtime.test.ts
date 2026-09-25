import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AgentRuntime, type RuntimeFs, type RuntimeProc } from '../../public/assets/agent/runtime.mjs'

/**
 * 事故回归（2026-09-25 ubuntu-focal 失联）：`runtime.mjs` 是部署到远端工作机的
 * node-agent 运行时。它有两个与那次事故直接相关的缺陷：
 *
 *  1. execSpawn 不幂等——manager 每轮对账都会重新入队 node.spawn，agent 每次都
 *     照单全收再拉一个 DSH；两个进程抢同一端口 → `EADDRINUSE 0.0.0.0:3197`。
 *  2. 重启后不自恢复——节点是 agent 的子进程，主机重启后全灭，恢复完全依赖
 *     manager「发现→入队→下发」，于是要等整个对账周期。
 *
 * 测试用注入的 fs/proc 桩，不碰真实文件系统与进程。
 */

interface FakeFs extends RuntimeFs {
  files: Map<string, string>
  dirs: Set<string>
}

const fakeFs = (seed: Record<string, string> = {}): FakeFs => {
  const files = new Map<string, string>(Object.entries(seed))
  const dirs = new Set<string>()
  return {
    files,
    dirs,
    readFile: (p) => files.get(p) ?? null,
    writeFile: (p, c) => {
      files.set(p, c)
    },
    mkdir: (p) => {
      dirs.add(p)
    },
    exists: (p) => files.has(p) || dirs.has(p),
    stat: (p) => (files.has(p) ? (files.get(p) as string).length : null),
    rename: (from, to) => {
      const v = files.get(from)
      if (v !== undefined) {
        files.delete(from)
        files.set(to, v)
      }
    },
    remove: (p) => {
      files.delete(p)
    },
    // 目录列举是重启后自恢复的发现入口：桩按已落盘文件推断目录名
    listDir: (p) => {
      const prefix = `${p}/`
      const names = new Set<string>()
      for (const path of files.keys()) {
        if (!path.startsWith(prefix)) continue
        const rest = path.slice(prefix.length)
        const slash = rest.indexOf('/')
        if (slash > 0) names.add(rest.slice(0, slash))
      }
      return names.size > 0 ? [...names] : null
    },
  }
}

interface FakeProc extends RuntimeProc {
  spawned: Array<{ bin: string; args: string[]; pid: number }>
  killed: number[]
  installed: number
}

/**
 * 假 PID 必须跨 fakeProc 实例全局唯一：否则「重启后」新建的桩会恰好复用一个
 * 旧 pid，被幂等闸门误判为「进程还活着」（真实的 PID 空间不会这样重叠）。
 */
let nextFakePid = 10_000

const fakeProc = (alivePids: Set<number> = new Set()): FakeProc => {
  const spawned: Array<{ bin: string; args: string[]; pid: number }> = []
  const killed: number[] = []
  let installed = 0
  return {
    spawned,
    killed,
    get installed() {
      return installed
    },
    install: async () => {
      installed += 1
      return '/prefix/node_modules/@deepseek-ai/dsh/lib/bin.js'
    },
    installProfile: async () => {},
    spawn: async (bin, args) => {
      const pid = nextFakePid++
      spawned.push({ bin, args, pid })
      alivePids.add(pid)
      return { pid }
    },
    kill: async (pid) => {
      killed.push(pid)
      alivePids.delete(pid)
    },
    alive: async (pid) => alivePids.has(pid),
  }
}

const AGENT_DIR = '/agent'

/** 一条 node.spawn 指令（payload 形状与 manager 侧 supervisor.startAgent 同构）。 */
const spawnCommand = (nodeId: string): { type: string; payload: Record<string, unknown> } => ({
  type: 'node.spawn',
  payload: {
    nodeId,
    args: ['--profile', nodeId, '--port', '3197', '--no-open'],
    env: { DSH_HOME: `${AGENT_DIR}/nodes/${nodeId}`, GW_KEY: 'apigw-x' },
    dshVersion: '0.1.5-rc.2',
    profile: {
      dir: `profiles/${nodeId}`,
      files: { 'package.json': '{"name":"p"}' },
    },
  },
})

const makeRuntime = (
  fs: FakeFs,
  proc: FakeProc,
): AgentRuntime =>
  new AgentRuntime({ managerUrl: 'http://127.0.0.1:8080', joinToken: 't', agentDir: AGENT_DIR, fs, proc, log: () => {} })

// ---- 缺陷 2：幂等 spawn（EADDRINUSE 的源头）----

test('事故回归: execSpawn 幂等——节点已活着时复用，绝不再拉一个抢同一端口', async () => {
  const fs = fakeFs()
  const proc = fakeProc()
  const rt = makeRuntime(fs, proc)

  const first = await rt.execSpawn(spawnCommand('spike02'))
  assert.equal(first.ok, true)
  const firstPid = first.result.pid as number
  assert.equal(proc.spawned.length, 1, '首次 spawn 真的拉起进程')

  // manager 下一轮对账又入队同一条 node.spawn——这正是 EADDRINUSE 的现场
  const second = await rt.execSpawn(spawnCommand('spike02'))
  assert.equal(second.ok, true)
  assert.equal(second.result.pid, firstPid, '复用既有 pid')
  assert.equal(second.result.alreadyRunning, true, '结果里标明是复用而非新拉')
  assert.equal(proc.spawned.length, 1, '绝不第二次 spawn')
})

test('事故回归: 节点进程已死时 execSpawn 正常重拉（幂等不能变成永不重启）', async () => {
  const fs = fakeFs()
  const alivePids = new Set<number>()
  const proc = fakeProc(alivePids)
  const rt = makeRuntime(fs, proc)

  const first = await rt.execSpawn(spawnCommand('spike02'))
  const firstPid = first.result.pid as number

  // 进程崩了（但 pid 文件还在——现场就是这样）
  alivePids.delete(firstPid)
  assert.equal(fs.readFile(`${AGENT_DIR}/nodes/spike02/node.pid`), String(firstPid), 'pid 文件仍在')

  const again = await rt.execSpawn(spawnCommand('spike02'))
  assert.equal(again.ok, true)
  assert.notEqual(again.result.pid, firstPid, '必须拉起新进程')
  assert.equal(proc.spawned.length, 2, '死进程不阻塞重启')
})

test('事故回归: 每个节点各自幂等——一个节点活着不影响另一个节点拉起', async () => {
  const fs = fakeFs()
  const proc = fakeProc()
  const rt = makeRuntime(fs, proc)

  await rt.execSpawn(spawnCommand('spike02'))
  await rt.execSpawn(spawnCommand('ops33'))
  assert.equal(proc.spawned.length, 2, '两个节点各拉一个')

  await rt.execSpawn(spawnCommand('spike02'))
  await rt.execSpawn(spawnCommand('ops33'))
  assert.equal(proc.spawned.length, 2, '再各来一次都不重复')
})

// ---- 缺陷 1：重启后自恢复 ----

test('事故回归: resumeNodes 把落盘的节点重新拉起（主机重启后的自恢复）', async () => {
  const fs = fakeFs()
  const proc = fakeProc()
  const rt = makeRuntime(fs, proc)

  // 上一个生命周期：节点起过，payload 已落盘
  await rt.execSpawn(spawnCommand('spike02'))
  await rt.execSpawn(spawnCommand('ops33'))
  assert.equal(proc.spawned.length, 2)

  // 模拟主机重启：所有进程消失，agent 重新构造（内存里的 nodes 表是空的）
  const freshProc = fakeProc()
  const freshRt = makeRuntime(fs, freshProc)
  assert.equal(freshRt.nodes.size, 0, '新 agent 内存里没有任何节点')

  const resumed = await freshRt.resumeNodes()
  assert.deepEqual(resumed.sort(), ['ops33', 'spike02'], '两个节点都从磁盘恢复')
  assert.equal(freshProc.spawned.length, 2, '重启后节点自动回到运行态，无需 manager 下发')
})

test('事故回归: resumeNodes 不复活被 node.stop 停掉的节点', async () => {
  const fs = fakeFs()
  const proc = fakeProc()
  const rt = makeRuntime(fs, proc)

  await rt.execSpawn(spawnCommand('spike02'))
  await rt.execSpawn(spawnCommand('ops33'))
  await rt.execStop({ payload: { nodeId: 'spike02' } })

  const freshProc = fakeProc()
  const freshRt = makeRuntime(fs, freshProc)
  const resumed = await freshRt.resumeNodes()
  assert.deepEqual(resumed, ['ops33'], '只有仍在运行的节点会自恢复')
  assert.equal(freshProc.spawned.length, 1, '人停掉的节点保持停')
})

test('事故回归: resumeNodes 对未启过的节点是空操作（全新机器）', async () => {
  const fs = fakeFs()
  const proc = fakeProc()
  const rt = makeRuntime(fs, proc)
  const resumed = await rt.resumeNodes()
  assert.deepEqual(resumed, [])
  assert.equal(proc.spawned.length, 0, '没有落盘状态就什么都不做')
})

test('事故回归: resumeNodes 对坏 payload 容错——一个坏文件不拖垮其余节点', async () => {
  const fs = fakeFs()
  const proc = fakeProc()
  const rt = makeRuntime(fs, proc)
  await rt.execSpawn(spawnCommand('spike02'))
  await rt.execSpawn(spawnCommand('ops33'))

  // 一个节点的 payload 被写坏
  fs.files.set(`${AGENT_DIR}/nodes/spike02/spawn.json`, '{ not json')

  const freshProc = fakeProc()
  const freshRt = makeRuntime(fs, freshProc)
  const resumed = await freshRt.resumeNodes()
  assert.deepEqual(resumed, ['ops33'], '坏 payload 只丢自己')
  assert.equal(freshProc.spawned.length, 1)
})
