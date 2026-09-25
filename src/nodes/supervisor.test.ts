import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeSupervisor, backoffDelayMs, decideAfterExit, LIVE_PROBE_THRESHOLD, type SpawnFn } from './supervisor.js'
import type { DockerRunner } from './docker-runner.js'
import type { ResolvedSpawnSpec } from '../config.js'

const spec = (over: Partial<ResolvedSpawnSpec> = {}): ResolvedSpawnSpec => ({
  managed: true,
  command: process.execPath,
  args: ['-e', 'setInterval(() => {}, 1000)'],
  cwd: null,
  readyTimeoutMs: 5_000,
  detached: false,
  logFile: null,
  env: {},
  restart: { maxAttempts: 3, baseDelayMs: 20, maxDelayMs: 100 },
  runner: 'process',
  host: null,
  docker: null,
  ...over,
})

/** 蜂群2计划 P2b：docker runner 节点规格（快速退避，测试友好）。 */
const dockerSpec = (): ResolvedSpawnSpec =>
  spec({
    command: '',
    runner: 'docker',
    host: null,
    readyTimeoutMs: 2_000,
    restart: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 20 },
    docker: { image: 'hellodac/dac-node:0.1.1-rc.2', containerName: null, network: 'hive', port: 3081, hostVolumes: {}, namedVolumes: {} },
  })

const stubDocker = (startFails = false): { runner: DockerRunner; calls: { ensureImage: number; start: number; stop: number; logs: number } } => {
  const calls = { ensureImage: 0, start: 0, stop: 0, logs: 0 }
  const runner = {
    ensureImage: async () => {
      calls.ensureImage += 1
    },
    start: async () => {
      calls.start += 1
      if (startFails) throw new Error('no docker')
      return 'cid-1'
    },
    stop: async () => {
      calls.stop += 1
    },
    logs: async () => {
      calls.logs += 1
      return 'docker-logs\n'
    },
    listManaged: async () => [],
  } as unknown as DockerRunner
  return { runner, calls }
}

const okProbe = async (): Promise<{ ok: true; detail: string }> => ({ ok: true, detail: '' })
const badProbe = async (): Promise<{ ok: false; detail: string }> => ({ ok: false, detail: 'down' })

const waitFor = async (fn: () => boolean, timeoutMs: number, what: string): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('timeout waiting for ' + what)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const keepAliveScript = 'console.log("hello-node"); setInterval(() => {}, 1000)'

/**
 * 债务 C3:假子进程——EventEmitter + 假 stdout/stderr 流;kill 或注入的
 * killTree 手动 emit exit。与假 spawn/killTree 搭配,supervisor 测试全程
 * 不起真进程(win32 taskkill 对假 pid 无效,必须经 killTree 注入落 exit)。
 */
const fakeChild = () =>
  Object.assign(new EventEmitter(), {
    pid: 9999,
    unref: () => {},
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: () => true,
  }) as unknown as import('node:child_process').ChildProcess

/** 假 spawn:每次调用返回同一个假子进程(重启循环复用,可重复 emit exit)。 */
const fakeSpawnFor = (child: import('node:child_process').ChildProcess): SpawnFn => (() => child) as SpawnFn

/** 假 killTree:直接 emit exit 走 onExit(与 win32 taskkill 真路径同落点)。 */
const fakeKillTree = (child: import('node:child_process').ChildProcess): void => {
  child.emit('exit', 0, null)
}

test('修路 A3: probeLive——live 态连续失败转 offline（进程仍在 = 僵节点场景），成功归零', async () => {
  let probeOk = true
  const child = fakeChild()
  const node = new NodeSupervisor('E', {
    probe: async () => ({ ok: probeOk, detail: 'down' }),
    spawn: fakeSpawnFor(child),
    killTree: fakeKillTree,
  })
  node.start(spec())
  await waitFor(() => node.current.state === 'live', 5_000, 'node live')
  assert.equal(node.current.state, 'live')

  probeOk = false
  await node.probeLive()
  assert.equal(node.current.state, 'live', '1 次失败不转')
  await node.probeLive()
  assert.equal(node.current.state, 'live', `${LIVE_PROBE_THRESHOLD - 1} 次失败不转`)
  await node.probeLive()
  assert.equal(node.current.state, 'offline', `${LIVE_PROBE_THRESHOLD} 次连续失败转 offline`)
  assert.match(node.current.lastError ?? '', new RegExp(`${LIVE_PROBE_THRESHOLD}/${LIVE_PROBE_THRESHOLD}`))
  node.stop()
  await waitFor(() => node.current.state === 'cold', 5_000, 'cold')

  // 成功一次即归零
  const child2 = fakeChild()
  const node2 = new NodeSupervisor('E2', {
    probe: async () => ({ ok: true, detail: '' }),
    spawn: fakeSpawnFor(child2),
    killTree: fakeKillTree,
  })
  node2.start(spec())
  await waitFor(() => node2.current.state === 'live', 5_000, 'node2 live')
  for (let i = 0; i < 10; i += 1) await node2.probeLive()
  assert.equal(node2.current.state, 'live', '成功的探活永不转离线')
  node2.stop()
  await waitFor(() => node2.current.state === 'cold', 5_000, 'node2 cold')
})

test('修路 A3: probeLive——docker 分支转 offline 时清 containerId，restart 直接重建（不 stop 死容器）', async () => {
  let probeOk = true
  const { runner, calls } = stubDocker()
  const node = new NodeSupervisor('D', { probe: async () => ({ ok: probeOk, detail: 'down' }), docker: runner })
  node.start(dockerSpec())
  await waitFor(() => node.current.state === 'live', 5_000, 'docker node live')

  probeOk = false
  for (let i = 0; i < LIVE_PROBE_THRESHOLD; i += 1) await node.probeLive()
  assert.equal(node.current.state, 'offline')

  const startsBefore = calls.start
  node.restart(dockerSpec())
  await waitFor(() => calls.start > startsBefore, 5_000, 'recreate started')
  assert.equal(calls.stop, 0, 'containerId 已清：restart 走直接 start，不去 stop 已死的容器')
  node.stop()
  await waitFor(() => node.current.state === 'cold', 5_000, 'node stopped')
})

test('backoffDelayMs: exponential, capped, and sane below attempt 1', () => {
  assert.equal(backoffDelayMs(1, 1_000, 30_000), 1_000)
  assert.equal(backoffDelayMs(2, 1_000, 30_000), 2_000)
  assert.equal(backoffDelayMs(3, 1_000, 30_000), 4_000)
  assert.equal(backoffDelayMs(20, 1_000, 30_000), 30_000)
  assert.equal(backoffDelayMs(0, 1_000, 30_000), 1_000)
  assert.equal(backoffDelayMs(-3, 1_000, 30_000), 1_000)
})

test('decideAfterExit: manual stop always settles cold', () => {
  assert.equal(decideAfterExit(1, 3, true), 'cold')
  assert.equal(decideAfterExit(99, 3, true), 'cold')
})

test('decideAfterExit: crashes restart until the streak hits the cap', () => {
  assert.equal(decideAfterExit(1, 3, false), 'restart')
  assert.equal(decideAfterExit(2, 3, false), 'restart')
  assert.equal(decideAfterExit(3, 3, false), 'offline')
  assert.equal(decideAfterExit(4, 3, false), 'offline')
})

test('a managed node goes live, buffers logs, and stops to cold', async () => {
  const lines: string[] = []
  const child = fakeChild()
  const node = new NodeSupervisor('A', {
    probe: okProbe,
    log: (l) => lines.push(l),
    spawn: fakeSpawnFor(child),
    killTree: fakeKillTree,
  })
  assert.equal(node.current.state, 'cold')

  node.start(spec({ args: ['-e', keepAliveScript] }))
  try {
    await waitFor(() => node.current.state === 'live', 10_000, 'live')
    assert.ok(node.current.pid !== null)
    assert.equal(node.current.attempts, 0)
    // stdout 是假流:手动喂一行,验证 pushLog 缓冲路径照常工作。
    child.stdout?.emit('data', Buffer.from('hello-node\n'))
    await waitFor(() => node.logs().includes('hello-node'), 5_000, 'captured log')
  } finally {
    node.stop()
    await waitFor(() => node.current.state === 'cold', 10_000, 'cold')
  }
  assert.equal(node.current.pid, null)
})

test('a node that never becomes ready is killed and restarted with backoff until offline', async () => {
  const child = fakeChild()
  const node = new NodeSupervisor('B', {
    probe: badProbe,
    spawn: fakeSpawnFor(child),
    killTree: fakeKillTree,
  })
  node.start(
    spec({
      args: ['-e', keepAliveScript],
      readyTimeoutMs: 250,
      restart: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 50 },
    }),
  )
  await waitFor(() => node.current.state === 'offline', 10_000, 'offline')
  assert.equal(node.current.attempts, 2)
  assert.match(node.current.lastError ?? '', /not ready within 250ms/)
})

test('a spawn failure (ENOENT) settles to offline after the cap', async () => {
  // 债务 C3:spawn 失败路径——注入直接 emit error 的假 spawn,不再真起进程。
  const node = new NodeSupervisor('C', {
    probe: badProbe,
    spawn: (() => {
      const child = fakeChild()
      queueMicrotask(() => child.emit('error', new Error('spawn definitely-not-a-real-binary-xyz-31415 ENOENT')))
      return child
    }) as SpawnFn,
  })
  node.start(
    spec({
      command: 'definitely-not-a-real-binary-xyz-31415',
      readyTimeoutMs: 250,
      restart: { maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 50 },
    }),
  )
  await waitFor(() => node.current.state === 'offline', 10_000, 'offline')
  assert.equal(node.current.attempts, 1)
  assert.match(node.current.lastError ?? '', /spawn|ENOENT|not found|failed/i)
})

test('a detached node writes to its log file, leaves a pidfile, and cleans it on stop', async () => {
  // 债务 C3:spawn + killTree 注入——不再真起 node -e 进程;假子进程写日志
  // 内容、报 pid,假 killTree 直接 emit exit 走 onExit 落 cold(win32 真实现
  // 走 taskkill,假子进程永远收不到)。
  const dir = mkdtempSync(join(tmpdir(), 'node-sup-'))
  const logFile = join(dir, 'node.log')
  let exited = false
  const node = new NodeSupervisor('D', {
    probe: okProbe,
    spawn: ((_cmd, _args, _opts) => {
      const child = Object.assign(new EventEmitter(), {
        pid: 4242,
        unref: () => {},
        stdout: null,
        stderr: null,
        kill: () => true,
      }) as unknown as import('node:child_process').ChildProcess
      writeFileSync(logFile, 'detached-up\n', 'utf8')
      return child
    }) as SpawnFn,
    killTree: (child) => {
      exited = true
      child.emit('exit', 0, null)
    },
  })
  node.start(
    spec({
      args: ['-e', 'console.log("detached-up"); setInterval(() => {}, 1000)'],
      detached: true,
      logFile,
    }),
  )
  try {
    await waitFor(() => node.current.state === 'live', 10_000, 'live')
    await waitFor(() => existsSync(logFile) && readFileSync(logFile, 'utf8').includes('detached-up'), 5_000, 'log file content')
    assert.ok(existsSync(logFile + '.pid'), 'pidfile exists while running')
  } finally {
    node.stop()
    await waitFor(() => node.current.state === 'cold', 10_000, 'cold')
  }
  assert.equal(exited, true, 'killTree 注入必须被 stop 调用')
  assert.equal(existsSync(logFile + '.pid'), false, 'pidfile removed on stop')
  rmSync(dir, { recursive: true, force: true })
})

// ---- 蜂群2计划 P2b：docker runner 模式 ----

test('P2b: docker 节点启动→探活→停止走 runner，不碰子进程', async () => {
  const { runner, calls } = stubDocker()
  const node = new NodeSupervisor('E', { probe: okProbe, docker: runner, dockerEnv: () => ({ DSH_HOME: '/data', GW_KEY: 'k' }) })
  node.start(dockerSpec())
  await waitFor(() => node.current.state === 'live', 5_000, 'docker live')
  assert.equal(calls.ensureImage, 1)
  assert.equal(calls.start, 1)
  assert.equal(node.current.pid, null, 'docker 模式没有进程 pid')
  node.stop()
  await waitFor(() => node.current.state === 'cold', 5_000, 'docker cold')
  assert.equal(calls.stop, 1)
})

test('P2b: adopt 认领在跑容器，探活通过即 live，绝不重复拉起', async () => {
  const { runner, calls } = stubDocker()
  const node = new NodeSupervisor('E', { probe: okProbe, docker: runner })
  node.adopt(dockerSpec(), 'cid-adopted')
  await waitFor(() => node.current.state === 'live', 5_000, 'adopted live')
  assert.equal(calls.start, 0)
  assert.equal(calls.ensureImage, 0)
})

test('P2b: docker 启动连续失败按退避重试，超过次数停用', async () => {
  const { runner } = stubDocker(true)
  const node = new NodeSupervisor('E', { probe: okProbe, docker: runner })
  node.start(dockerSpec())
  await waitFor(() => node.current.state === 'offline', 5_000, 'docker offline')
  assert.equal(node.current.attempts, 2)
  assert.match(node.current.lastError ?? '', /no docker/)
})

test('P2b: dockerLogs 无容器返回 null；认领后走 runner.logs', async () => {
  const { runner, calls } = stubDocker()
  const node = new NodeSupervisor('E', { probe: okProbe, docker: runner })
  assert.equal(await node.dockerLogs(), null)
  node.adopt(dockerSpec(), 'cid-1')
  assert.equal(await node.dockerLogs(), 'docker-logs\n')
  assert.equal(calls.logs, 1)
})

test('P6 评审 B3: 启动等待期间 stop——在途链作废、孤儿容器被补刀清理、不采纳容器', async () => {
  let releaseGate: () => void = () => undefined
  const gate = new Promise<void>((resolveGate) => {
    releaseGate = resolveGate
  })
  const calls = { ensureImage: 0, start: 0, stop: 0 }
  const runner = {
    ensureImage: async () => {
      calls.ensureImage += 1
      await gate
    },
    start: async () => {
      calls.start += 1
      return 'cid-late'
    },
    stop: async () => {
      calls.stop += 1
    },
    logs: async () => 'late',
    listManaged: async () => [],
  } as unknown as DockerRunner
  const node = new NodeSupervisor('E', { probe: okProbe, docker: runner })
  node.start(dockerSpec())
  await waitFor(() => calls.ensureImage === 1, 2_000, 'ensureImage entered')
  node.stop()
  assert.equal(node.current.state, 'cold')
  releaseGate()
  await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  assert.equal(node.current.state, 'cold', '过期链不得改变状态')
  assert.equal(calls.stop, 1, '过期链拉起的孤儿容器被补刀清理')
  assert.equal(await node.dockerLogs(), null, '过期链不得采纳 containerId')
})

test('P6 评审 B3: docker 就绪超时——停容器并走失败决策链（不卡 starting）', async () => {
  const calls = { start: 0, stop: 0 }
  const runner = {
    ensureImage: async () => undefined,
    start: async () => {
      calls.start += 1
      return 'cid-x'
    },
    stop: async () => {
      calls.stop += 1
    },
    logs: async () => '',
    listManaged: async () => [],
  } as unknown as DockerRunner
  const node = new NodeSupervisor('E', { probe: badProbe, docker: runner })
  node.start(dockerSpec()) // readyTimeoutMs 2s，maxAttempts 2，退避 10/20ms
  await waitFor(() => node.current.state === 'offline', 15_000, 'offline after probe timeouts')
  assert.equal(node.current.attempts, 2)
  assert.ok(calls.stop >= 2, '每次就绪超时都停容器')
})

// ---- 能力四（M1-4）：agent runner 分支 ----

const agentSpec = (): ResolvedSpawnSpec =>
  spec({
    command: '',
    args: ['--profile', 'ops01', '--port', '3081', '--no-open'],
    runner: 'agent',
    host: 'agent-abc123',
    readyTimeoutMs: 500,
    restart: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 20 },
    dshVersion: '0.1.5-rc.2',
    gatewayRef: 'github:litestartup-com/dsh-api-gateway#b592b4f',
  })

interface AgentDeps {
  enqueued: Array<{ type: string; payload: unknown }>
  resultCallbacks: Map<number, (ok: boolean) => void>
}

const agentDeps = (): AgentDeps => ({ enqueued: [], resultCallbacks: new Map() })

const supervisorWith = (deps: AgentDeps, probe: () => Promise<{ ok: boolean; detail: string }>, agentLog?: (agentId: string, nodeId: string) => string): NodeSupervisor =>
  new NodeSupervisor('ops01', {
    probe,
    agentCommand: (_agentId, type, payload) => {
      deps.enqueued.push({ type, payload })
      return deps.enqueued.length
    },
    agentResult: (commandId, cb) => {
      deps.resultCallbacks.set(commandId, cb)
      return () => {
        deps.resultCallbacks.delete(commandId)
      }
    },
    ...(agentLog === undefined ? {} : { agentLog }),
    agentEnv: () => ({ GW_KEY: 'apigw-super' }),
    fleetDoc: () => 'fleet-content',
  })

test('能力四 M1-4: agent start——入队 node.spawn（载荷含 nodeId/args/env/钉版/派生件），探活 ok 即 live', async () => {
  const deps = agentDeps()
  const s = supervisorWith(deps, okProbe)
  s.start(agentSpec())
  assert.equal(s.current.state, 'starting')
  assert.equal(deps.enqueued.length, 1)
  assert.equal(deps.enqueued[0]?.type, 'node.spawn')
  const payload = deps.enqueued[0]?.payload as {
    nodeId: string
    args: string[]
    dshVersion: string | null
    env: Record<string, string>
    fleetMd?: string
    profile: { dir: string; files: Record<string, string> }
  }
  assert.equal(payload.nodeId, 'ops01')
  assert.deepEqual(payload.args, ['--profile', 'ops01', '--port', '3081', '--no-open'])
  assert.equal(payload.dshVersion, '0.1.5-rc.2')
  assert.equal(payload.env.GW_KEY, 'apigw-super', 'agentEnv 注入 GW_KEY')
  assert.equal(payload.fleetMd, 'fleet-content', 'fleet.md 随载荷下发')
  assert.equal(payload.profile.dir, 'profiles/ops01', 'profile 目录 = --profile 名')
  assert.match(payload.profile.files['package.json'] ?? '', /"@deepseek-ai\/dsh-base": "0.1.5-rc.2"/, 'profile 钉版与载荷一致')
  assert.match(payload.profile.files['package.json'] ?? '', /#b592b4f/, 'facade ref 进 profile')
  assert.equal((payload.profile.files['.seed-version'] ?? '').trim().length, 40, '种子标记随载荷')
  deps.resultCallbacks.get(1)?.(true)
  await waitFor(() => s.current.state === 'live', 3_000, 'agent node live')
})

test('能力四 M2 回归: agent 就绪探活必须在 spawn 结果之后（远端冷安装期间不误杀）', async () => {
  const deps = agentDeps()
  let probes = 0
  const s = supervisorWith(deps, async () => {
    probes += 1
    return { ok: true, detail: '' }
  })
  s.start(agentSpec())
  await sleepMs(50)
  assert.equal(probes, 0, 'spawn 结果未回报前绝不探活（安装可能几分钟）')
  assert.equal(s.current.state, 'starting', '期间保持 starting')
  deps.resultCallbacks.get(1)?.(true)
  await waitFor(() => s.current.state === 'live', 3_000, '结果 ok 后才探活 → live')
  assert.ok(probes >= 1, '结果 ok 后探活启动')
})

test('能力四 M1-4: agent spawn 失败回报 → 快速失败重试链（不等待就绪超时）', async () => {
  const deps = agentDeps()
  const s = supervisorWith(deps, badProbe)
  s.start(agentSpec())
  deps.resultCallbacks.get(1)?.(false)
  await waitFor(() => deps.enqueued.length >= 2, 2_000, 'retry enqueued after failure report')
  assert.equal(deps.enqueued[1]?.type, 'node.spawn', '重试 = 再次入队 spawn')
  assert.equal(s.current.attempts >= 1, true, '失败计attempts')
})

test('能力四 M1-4: 就绪超时入队 node.stop + 失败链；stop → node.stop + 冷态；restart → stop+spawn 链', async () => {
  const deps = agentDeps()
  const s = supervisorWith(deps, badProbe)
  s.start(agentSpec())
  // M2 回归：每次重试的 spawn 都要有结果回报才继续（结果前不探活）。
  // 指令 id 含 node.stop 在内（spawn=1 → stop=2 → spawn=3），按「未回报过的回调」推进。
  const fired = new Set<number>()
  for (let i = 0; i < 2; i += 1) {
    await waitFor(() => [...deps.resultCallbacks.keys()].some((k) => !fired.has(k)), 2_000, 'spawn enqueued + result cb registered')
    const id = [...deps.resultCallbacks.keys()].find((k) => !fired.has(k))
    assert.ok(id !== undefined, '有未回报的 spawn 回调')
    fired.add(id)
    deps.resultCallbacks.get(id)?.(true)
    await waitFor(
      () => [...deps.resultCallbacks.keys()].some((k) => !fired.has(k)) || s.current.state === 'offline',
      3_000,
      'next spawn or offline',
    )
  }
  assert.equal(s.current.state, 'offline', 'agent offline after retries')
  assert.ok(deps.enqueued.filter((e) => e.type === 'node.stop').length >= 2, '每次超时入队 stop')

  s.stop()
  assert.equal(s.current.state, 'cold', 'stop 后落冷')

  const deps2 = agentDeps()
  const s2 = supervisorWith(deps2, okProbe)
  s2.start(agentSpec())
  deps2.resultCallbacks.get(1)?.(true)
  await waitFor(() => s2.current.state === 'live', 2_000, 'live before restart')
  s2.restart(agentSpec())
  deps2.resultCallbacks.get(2)?.(true)
  await waitFor(
    () => deps2.enqueued.some((e) => e.type === 'node.stop') && deps2.enqueued.filter((e) => e.type === 'node.spawn').length >= 2,
    2_000,
    'restart enqueues stop+spawn',
  )
})

test('能力四 M1-4: 未接线 agentCommand → fail-loud offline；agentLogs 走注入源', () => {
  const s = new NodeSupervisor('ops01', { probe: badProbe })
  s.start(agentSpec())
  assert.equal(s.current.state, 'offline', '缺 agentCommand = offline')
  assert.equal(s.agentLogs(), '', '无 spec 回空')

  const withLog = new NodeSupervisor('ops01', {
    probe: badProbe,
    agentCommand: () => 1,
    agentLog: (agentId, nodeId) => `${agentId}/${nodeId}/log`,
  })
  withLog.start(agentSpec())
  assert.equal(withLog.agentLogs(), 'agent-abc123/ops01/log')
})

// ---- 事故回归（2026-09-25 ubuntu-focal 失联）：agent 重连后的节点续跑 ----

test('事故回归: resume 把 cold 节点重新拉起——重启后节点正是 cold，healOnly 会跳过它', () => {
  const deps = agentDeps()
  const s = supervisorWith(deps, okProbe)

  // 刚开机的样子：还没人 start 过，状态是 cold
  assert.equal(s.current.state, 'cold')
  // healOnly 的 skip 语义就是照 cold 跳过的——所以 resume 必须自己动手
  s.resume(agentSpec())
  assert.equal(s.current.state, 'starting', 'cold → resume 必须真的拉起')
  assert.equal(deps.enqueued.filter((e) => e.type === 'node.spawn').length, 1, '入队一条 node.spawn')
})

test('事故回归: resume 不打扰 live 节点——机器重连但节点还活着时不得重复 spawn', () => {
  const deps = agentDeps()
  const s = supervisorWith(deps, okProbe)

  s.resume(agentSpec())
  deps.resultCallbacks.get(1)?.(true)
  return waitFor(() => s.current.state === 'live', 2_000, 'first resume reaches live').then(() => {
    const spawnedBefore = deps.enqueued.filter((e) => e.type === 'node.spawn').length
    // 节点还活着（KillMode=process 让它在 agent 自更新时存活）——再来一次 resume
    s.resume(agentSpec())
    assert.equal(s.current.state, 'live', 'live 保持 live')
    assert.equal(
      deps.enqueued.filter((e) => e.type === 'node.spawn').length,
      spawnedBefore,
      'live 节点不得被重复 spawn（否则抢同一端口 = EADDRINUSE）',
    )
  })
})

test('事故回归: resume 不抢人手动停掉的节点——手动 stop 后机器重连也不得拉起', () => {
  const deps = agentDeps()
  const s = supervisorWith(deps, okProbe)

  s.start(agentSpec())
  deps.resultCallbacks.get(1)?.(true)
  return waitFor(() => s.current.state === 'live', 2_000, 'live before stop').then(() => {
    s.stop()
    assert.equal(s.current.state, 'cold', '手动 stop 落冷')
    const spawnedBefore = deps.enqueued.filter((e) => e.type === 'node.spawn').length

    s.resume(agentSpec())
    assert.equal(s.current.state, 'cold', '手动停掉的节点绝不因 resume 复活（债务 R9 同款红线）')
    assert.equal(deps.enqueued.filter((e) => e.type === 'node.spawn').length, spawnedBefore, '不得入队 spawn')
  })
})
