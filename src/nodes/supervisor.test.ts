import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeSupervisor, backoffDelayMs, decideAfterExit, LIVE_PROBE_THRESHOLD, type SpawnFn } from './supervisor.js'
import type { DockerRunner } from './docker-runner.js'
import type { ResolvedSpawnSpec } from '../config.js'
import { GATEWAY_REF_020 } from '../dsh-matrix.js'

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

/** Hive plan 2 P2b: the docker runner node spec (fast backoff, friendly to tests). */
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
 * Debt C3: fake child process -- an EventEmitter plus fake stdout/stderr streams; kill or an injected
 * killTree emits exit by hand. Together with the fake spawn/killTree, the supervisor tests never start a
 * real process (win32 taskkill does nothing to a fake pid, so exit has to land through the injected killTree).
 */
const fakeChild = () =>
  Object.assign(new EventEmitter(), {
    pid: 9999,
    unref: () => {},
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: () => true,
  }) as unknown as import('node:child_process').ChildProcess

/** Fake spawn: every call returns the same fake child (reused across the restart loop, so exit can be emitted repeatedly). */
const fakeSpawnFor = (child: import('node:child_process').ChildProcess): SpawnFn => (() => child) as SpawnFn

/** Fake killTree: emit exit directly into onExit (the same landing point as the real win32 taskkill path). */
const fakeKillTree = (child: import('node:child_process').ChildProcess): void => {
  child.emit('exit', 0, null)
}

test('Repair A3: probeLive -- consecutive failures in live turn it offline (the process is still there = a stuck node), and one success resets to zero', async () => {
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
  assert.equal(node.current.state, 'live', 'one failure does not flip it')
  await node.probeLive()
  assert.equal(node.current.state, 'live', `${LIVE_PROBE_THRESHOLD - 1} failures do not flip it`)
  await node.probeLive()
  assert.equal(node.current.state, 'offline', `${LIVE_PROBE_THRESHOLD} consecutive failures turn it offline`)
  assert.match(node.current.lastError ?? '', new RegExp(`${LIVE_PROBE_THRESHOLD}/${LIVE_PROBE_THRESHOLD}`))
  node.stop()
  await waitFor(() => node.current.state === 'cold', 5_000, 'cold')

  // One success resets the count to zero
  const child2 = fakeChild()
  const node2 = new NodeSupervisor('E2', {
    probe: async () => ({ ok: true, detail: '' }),
    spawn: fakeSpawnFor(child2),
    killTree: fakeKillTree,
  })
  node2.start(spec())
  await waitFor(() => node2.current.state === 'live', 5_000, 'node2 live')
  for (let i = 0; i < 10; i += 1) await node2.probeLive()
  assert.equal(node2.current.state, 'live', 'a successful probe never turns it offline')
  node2.stop()
  await waitFor(() => node2.current.state === 'cold', 5_000, 'node2 cold')
})

test('Repair A3: probeLive -- the docker branch clears containerId when it turns offline, so restart rebuilds directly (no stop on a dead container)', async () => {
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
  assert.equal(calls.stop, 0, 'containerId already cleared: restart goes straight to start instead of stopping a dead container')
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
    // stdout is a fake stream: feed one line by hand to check the pushLog buffer path still works.
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
  // Debt C3: the spawn failure path -- inject a fake spawn that emits error directly instead of starting a process.
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
  // Debt C3: spawn plus killTree injected -- no more real `node -e` process; the fake child writes the log
  // content and reports a pid, and the fake killTree emits exit straight into onExit to settle cold (the real
  // win32 implementation goes through taskkill, which a fake child never receives).
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
  assert.equal(exited, true, 'the injected killTree must be called by stop')
  assert.equal(existsSync(logFile + '.pid'), false, 'pidfile removed on stop')
  rmSync(dir, { recursive: true, force: true })
})

// ---- Hive plan 2 P2b: docker runner mode ----

test('P2b: starting, probing and stopping a docker node all go through the runner and never touch a child process', async () => {
  const { runner, calls } = stubDocker()
  const node = new NodeSupervisor('E', { probe: okProbe, docker: runner, dockerEnv: () => ({ DSH_HOME: '/data', GW_KEY: 'k' }) })
  node.start(dockerSpec())
  await waitFor(() => node.current.state === 'live', 5_000, 'docker live')
  assert.equal(calls.ensureImage, 1)
  assert.equal(calls.start, 1)
  assert.equal(node.current.pid, null, 'docker mode has no process pid')
  node.stop()
  await waitFor(() => node.current.state === 'cold', 5_000, 'docker cold')
  assert.equal(calls.stop, 1)
})

test('P2b: adopt claims a running container, goes live once the probe passes, and never starts it a second time', async () => {
  const { runner, calls } = stubDocker()
  const node = new NodeSupervisor('E', { probe: okProbe, docker: runner })
  node.adopt(dockerSpec(), 'cid-adopted')
  await waitFor(() => node.current.state === 'live', 5_000, 'adopted live')
  assert.equal(calls.start, 0)
  assert.equal(calls.ensureImage, 0)
})

test('P2b: consecutive docker start failures retry with backoff and disable the node past the cap', async () => {
  const { runner } = stubDocker(true)
  const node = new NodeSupervisor('E', { probe: okProbe, docker: runner })
  node.start(dockerSpec())
  await waitFor(() => node.current.state === 'offline', 5_000, 'docker offline')
  assert.equal(node.current.attempts, 2)
  assert.match(node.current.lastError ?? '', /no docker/)
})

test('P2b: dockerLogs returns null with no container; after adopt it goes through runner.logs', async () => {
  const { runner, calls } = stubDocker()
  const node = new NodeSupervisor('E', { probe: okProbe, docker: runner })
  assert.equal(await node.dockerLogs(), null)
  node.adopt(dockerSpec(), 'cid-1')
  assert.equal(await node.dockerLogs(), 'docker-logs\n')
  assert.equal(calls.logs, 1)
})

test('P6 review B3: stop while the start is still waiting -- the in-flight chain is voided, the orphan container it started is finished off, and the container is not adopted', async () => {
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
  assert.equal(node.current.state, 'cold', 'an expired chain must not change the state')
  assert.equal(calls.stop, 1, 'the orphan container started by the expired chain is finished off')
  assert.equal(await node.dockerLogs(), null, 'an expired chain must not adopt the containerId')
})

test('P6 review B3: docker readiness timeout -- stop the container and take the failure decision chain (never stuck in starting)', async () => {
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
  node.start(dockerSpec()) // readyTimeoutMs 2s, maxAttempts 2, backoff 10/20ms
  await waitFor(() => node.current.state === 'offline', 15_000, 'offline after probe timeouts')
  assert.equal(node.current.attempts, 2)
  assert.ok(calls.stop >= 2, 'every readiness timeout stops the container')
})

// ---- Capability four (M1-4): the agent runner branch ----

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

test('Capability four M1-4: agent start -- enqueues node.spawn (payload carries nodeId/args/env/pinned version/derived files) and goes live as soon as the probe is ok', async () => {
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
  assert.equal(payload.env.GW_KEY, 'apigw-super', 'agentEnv injects GW_KEY')
  assert.equal(payload.fleetMd, 'fleet-content', 'fleet.md ships with the payload')
  assert.equal(payload.profile.dir, 'profiles/ops01', 'profile directory = the --profile name')
  assert.match(payload.profile.files['package.json'] ?? '', /"@deepseek-ai\/dsh-base": "0.1.5-rc.2"/, 'the profile pins the same version as the payload')
  assert.match(payload.profile.files['package.json'] ?? '', /#b592b4f/, 'the facade ref goes into the profile')
  assert.equal((payload.profile.files['.seed-version'] ?? '').trim().length, 40, 'the seed marker ships with the payload')
  deps.resultCallbacks.get(1)?.(true)
  await waitFor(() => s.current.state === 'live', 3_000, 'agent node live')
})

test('0.2.0 corridor: an agent node pinned to 0.2.0 without an explicit ref takes the matrix row ref (a pre-corridor facade silently hangs the card chain, dsh-facts §18.2)', async () => {
  const deps = agentDeps()
  const s = supervisorWith(deps, okProbe)
  s.start(spec({ ...agentSpec(), dshVersion: '0.2.0-rc.2', gatewayRef: null }))
  assert.equal(deps.enqueued.length, 1)
  const payload = deps.enqueued[0]?.payload as {
    dshVersion: string
    gatewayRef?: string
    profile: { files: Record<string, string> }
  }
  assert.equal(payload.dshVersion, '0.2.0-rc.2')
  assert.equal(payload.gatewayRef, GATEWAY_REF_020, 'the facade ref must resolve through the matrix row, not fall back to the legacy constant')
  assert.match(payload.profile.files['package.json'] ?? '', /#398ea94/, 'the profile pins the corridor facade (v0.2.5)')
  assert.match(payload.profile.files['package.json'] ?? '', /"@deepseek-ai\/cordis": "4.0.4"/, 'the 0.2.0 app-boot peer pins ship with the payload profile')
  assert.ok(!(payload.profile.files['package.json'] ?? '').includes('patchReload'), 'no patchReload on the new lines (J1-15)')
  assert.match(payload.profile.files['cordis.patch.yml'] ?? '', /session-log-deepseek/, 'the privacy row ships with the payload patch (J1-22)')
})

test('Capability four M2 regression: the agent readiness probe must come after the spawn result (never kill it during a cold remote install)', async () => {
  const deps = agentDeps()
  let probes = 0
  const s = supervisorWith(deps, async () => {
    probes += 1
    return { ok: true, detail: '' }
  })
  s.start(agentSpec())
  await sleepMs(50)
  assert.equal(probes, 0, 'never probe before the spawn result is reported (the install may take minutes)')
  assert.equal(s.current.state, 'starting', 'it stays starting in the meantime')
  deps.resultCallbacks.get(1)?.(true)
  await waitFor(() => s.current.state === 'live', 3_000, 'only probe after an ok result -> live')
  assert.ok(probes >= 1, 'the probe starts once the result is ok')
})

test('Capability four M1-4: an agent spawn failure report -> the fast-fail retry chain (without waiting for the readiness timeout)', async () => {
  const deps = agentDeps()
  const s = supervisorWith(deps, badProbe)
  s.start(agentSpec())
  deps.resultCallbacks.get(1)?.(false)
  await waitFor(() => deps.enqueued.length >= 2, 2_000, 'retry enqueued after failure report')
  assert.equal(deps.enqueued[1]?.type, 'node.spawn', 'a retry = enqueue spawn again')
  assert.equal(s.current.attempts >= 1, true, 'the failure counts an attempt')
})

test('Capability four M1-4: a readiness timeout enqueues node.stop plus the failure chain; stop -> node.stop plus cold; restart -> stop+spawn chain', async () => {
  const deps = agentDeps()
  const s = supervisorWith(deps, badProbe)
  s.start(agentSpec())
  // M2 regression: every retry's spawn needs its result reported before anything continues (no probing before the result).
  // Command ids include node.stop (spawn=1 -> stop=2 -> spawn=3), so advance by "the callback not reported yet".
  const fired = new Set<number>()
  for (let i = 0; i < 2; i += 1) {
    await waitFor(() => [...deps.resultCallbacks.keys()].some((k) => !fired.has(k)), 2_000, 'spawn enqueued + result cb registered')
    const id = [...deps.resultCallbacks.keys()].find((k) => !fired.has(k))
    assert.ok(id !== undefined, 'there is an unreported spawn callback')
    fired.add(id)
    deps.resultCallbacks.get(id)?.(true)
    await waitFor(
      () => [...deps.resultCallbacks.keys()].some((k) => !fired.has(k)) || s.current.state === 'offline',
      3_000,
      'next spawn or offline',
    )
  }
  assert.equal(s.current.state, 'offline', 'agent offline after retries')
  assert.ok(deps.enqueued.filter((e) => e.type === 'node.stop').length >= 2, 'every timeout enqueues a stop')

  s.stop()
  assert.equal(s.current.state, 'cold', 'cold after stop')

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

test('Capability four M1-4: agentCommand not wired up -> fail-loud offline; agentLogs goes through the injected source', () => {
  const s = new NodeSupervisor('ops01', { probe: badProbe })
  s.start(agentSpec())
  assert.equal(s.current.state, 'offline', 'a missing agentCommand = offline')
  assert.equal(s.agentLogs(), '', 'no spec returns empty')

  const withLog = new NodeSupervisor('ops01', {
    probe: badProbe,
    agentCommand: () => 1,
    agentLog: (agentId, nodeId) => `${agentId}/${nodeId}/log`,
  })
  withLog.start(agentSpec())
  assert.equal(withLog.agentLogs(), 'agent-abc123/ops01/log')
})

// ---- Incident regression (ubuntu-focal lost contact on 2026-09-25): nodes carry on running after the agent reconnects ----

test('Incident regression: resume brings a cold node back up -- right after a restart the node is cold, and healOnly would skip it', () => {
  const deps = agentDeps()
  const s = supervisorWith(deps, okProbe)

  // What a freshly booted machine looks like: nobody has started it yet, so the state is cold
  assert.equal(s.current.state, 'cold')
  // The skip semantics of healOnly pass over anything cold -- so resume has to do the work itself
  s.resume(agentSpec())
  assert.equal(s.current.state, 'starting', 'cold -> resume must really bring it up')
  assert.equal(deps.enqueued.filter((e) => e.type === 'node.spawn').length, 1, 'one node.spawn enqueued')
})

test('Incident regression: resume leaves a live node alone -- a machine that reconnects while the node is still alive must not spawn it again', () => {
  const deps = agentDeps()
  const s = supervisorWith(deps, okProbe)

  s.resume(agentSpec())
  deps.resultCallbacks.get(1)?.(true)
  return waitFor(() => s.current.state === 'live', 2_000, 'first resume reaches live').then(() => {
    const spawnedBefore = deps.enqueued.filter((e) => e.type === 'node.spawn').length
    // The node is still alive (KillMode=process keeps it alive across an agent self-update) -- resume once more
    s.resume(agentSpec())
    assert.equal(s.current.state, 'live', 'live stays live')
    assert.equal(
      deps.enqueued.filter((e) => e.type === 'node.spawn').length,
      spawnedBefore,
      'a live node must not be spawned again (otherwise two processes fight over the same port = EADDRINUSE)',
    )
  })
})

test('Incident regression: resume does not grab a node a human stopped by hand -- reconnecting the machine after a manual stop must not bring it up', () => {
  const deps = agentDeps()
  const s = supervisorWith(deps, okProbe)

  s.start(agentSpec())
  deps.resultCallbacks.get(1)?.(true)
  return waitFor(() => s.current.state === 'live', 2_000, 'live before stop').then(() => {
    s.stop()
    assert.equal(s.current.state, 'cold', 'a manual stop settles cold')
    const spawnedBefore = deps.enqueued.filter((e) => e.type === 'node.spawn').length

    s.resume(agentSpec())
    assert.equal(s.current.state, 'cold', 'a node stopped by hand must never come back through resume (the same red line as Debt R9)')
    assert.equal(deps.enqueued.filter((e) => e.type === 'node.spawn').length, spawnedBefore, 'must not enqueue a spawn')
  })
})
