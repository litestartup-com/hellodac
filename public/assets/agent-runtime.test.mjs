import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AgentRuntime, LEGACY_PEER_DEPS_VERSIONS } from './agent/runtime.mjs'

/** 内存假文件系统。 */
const fakeFs = () => {
  const store = new Map()
  return {
    store,
    readFile: (p) => store.get(p) ?? null,
    writeFile: (p, c) => store.set(p, c),
    mkdir: () => {},
    exists: (p) => store.has(p),
    stat: (p) => (store.has(p) ? store.get(p).length : null),
    rename: (from, to) => {
      const v = store.get(from)
      if (v === undefined) return
      store.set(to, v)
      store.delete(from)
    },
    remove: (p) => {
      store.delete(p)
    },
  }
}

const makeRuntime = (over = {}) => {
  const transport = {
    registerCalls: [],
    register: async (_url, body) => {
      transport.registerCalls.push(body)
      return { agentId: 'agent-test-1', agentToken: 'token-1' }
    },
    commandBatches: [],
    eventsPosted: [],
    commands: async () => {
      const batch = transport.commandBatches.shift() ?? []
      return batch
    },
    events: async (_url, _id, _token, events) => {
      transport.eventsPosted.push(events)
    },
    ...over.transport,
  }
  const proc = {
    installed: [],
    spawned: [],
    killed: [],
    profileInstalls: [],
    install: async (_dir, version, legacy) => {
      proc.installed.push({ version, legacy })
      return `/agent/dsh/${version}/node_modules/@deepseek-ai/dsh/lib/bin.js`
    },
    installProfile: async (dir, legacy) => {
      proc.profileInstalls.push({ dir, legacy })
    },
    spawn: async (bin, args, env) => {
      proc.spawned.push({ bin, args, env })
      return { pid: 4242 }
    },
    kill: async (pid) => {
      proc.killed.push(pid)
    },
    alive: async () => true,
    ...over.proc,
  }
  const fs = over.fs ?? fakeFs()
  const backoffs = []
  const runtime = new AgentRuntime({
    managerUrl: 'https://app.example.com',
    joinToken: 'join-1',
    agentDir: '/agent',
    transport,
    proc,
    fs,
    maxWaitMs: 10,
    backoff: async (ms) => {
      backoffs.push(ms)
    },
    log: () => {},
    ...over,
  })
  return { runtime, transport, proc, fs, backoffs }
}

test('能力四 M1-5: 注册——首次换发身份并落盘 0600 状态文件；重启复用不重注册', async () => {
  const a = makeRuntime()
  await a.runtime.registerOnce()
  assert.equal(a.runtime.agentId, 'agent-test-1')
  assert.equal(a.transport.registerCalls.length, 1)
  assert.deepEqual(a.transport.registerCalls[0], { joinToken: 'join-1', hostname: a.transport.registerCalls[0].hostname, os: process.platform, arch: process.arch, nodeVersion: process.version })
  assert.ok(a.fs.store.get('/agent/agent.json')?.includes('agent-test-1'), '身份落盘')

  const b = makeRuntime({ fs: a.fs })
  await b.runtime.registerOnce()
  assert.equal(b.transport.registerCalls.length, 0, '已有身份不重注册')
})

test('能力四 M1-6: spawn 指令——profile 派生下发（文件落盘幂等 + 依赖安装带 legacy）+ fleet.md', async () => {
  const a = makeRuntime()
  await a.runtime.registerOnce()
  a.transport.commandBatches.push([
    {
      id: 7,
      type: 'node.spawn',
      payload: {
        nodeId: 'ops01',
        args: ['--profile', 'ops01', '--port', '3081', '--no-open'],
        env: { DSH_HOME: '/srv/nodes/ops01', GW_KEY: 'apigw-k' },
        dshVersion: '0.1.5-rc.2',
        profile: { dir: 'profiles/ops01', files: { 'package.json': '{"dsh":1}', 'cordis.yml': '[]', '.seed-version': 'abc\n' } },
        fleetMd: '# fleet\n内容',
      },
    },
  ])
  await a.runtime.loopOnce()
  const profileRoot = '/srv/nodes/ops01/profiles/ops01'
  assert.equal(a.fs.store.get(`${profileRoot}/package.json`), '{"dsh":1}', 'profile 文件落盘')
  assert.equal(a.fs.store.get(`${profileRoot}/.seed-version`), 'abc\n')
  assert.equal(a.fs.store.get('/srv/nodes/ops01/fleet.md'), '# fleet\n内容', 'fleet.md 落 DSH_HOME')
  assert.deepEqual(a.proc.profileInstalls[0], { dir: profileRoot, legacy: true }, '0.1.5 profile 安装带 legacy')
  assert.equal(a.proc.spawned.length, 1, '安装完成后才 spawn')

  // 幂等：重复 spawn 内容不变不重写（install 仍幂等重跑）
  const writes = a.fs.store.size
  a.transport.commandBatches.push([{ id: 8, type: 'node.spawn', payload: { nodeId: 'ops01', args: [], env: { DSH_HOME: '/srv/nodes/ops01' }, dshVersion: '0.1.5-rc.2', profile: { dir: 'profiles/ops01', files: { 'package.json': '{"dsh":1}' } } } }])
  await a.runtime.loopOnce()
  assert.equal(a.fs.store.get(`${profileRoot}/package.json`), '{"dsh":1}')
  assert.ok(a.fs.store.size <= writes + 3, '内容未变不追加写入（只新增 pid 等）')
})

test('能力四 M1-5: spawn 指令——prefix 安装钉版（0.1.5 带 legacy）、spawn 载荷、pidfile、结果回报', async () => {
  const a = makeRuntime()
  await a.runtime.registerOnce()
  a.transport.commandBatches.push([
    { id: 7, type: 'node.spawn', payload: { nodeId: 'ops01', args: ['--profile', 'ops01', '--port', '3081', '--no-open'], env: { DSH_HOME: '/srv/nodes/ops01', GW_KEY: 'apigw-k' }, dshVersion: '0.1.5-rc.2' } },
  ])
  await a.runtime.loopOnce()
  assert.equal(a.proc.installed.length, 1)
  assert.deepEqual(a.proc.installed[0], { version: '0.1.5-rc.2', legacy: true }, '0.1.5 必须 --legacy-peer-deps')
  const spawned = a.proc.spawned[0]
  assert.equal(spawned.bin.endsWith('/0.1.5-rc.2/node_modules/@deepseek-ai/dsh/lib/bin.js'), true)
  assert.deepEqual(spawned.args, ['--profile', 'ops01', '--port', '3081', '--no-open'])
  assert.equal(spawned.env.DSH_HOME, '/srv/nodes/ops01')
  assert.ok(a.fs.store.get('/agent/nodes/ops01/node.pid') === '4242', 'pidfile 落盘')
  assert.match(a.fs.store.get('/srv/nodes/ops01/settings.yaml') ?? '', /apigw-k/, 'GW_KEY 写 settings')
  const posted = a.transport.eventsPosted.flat()
  assert.deepEqual(posted[0], { type: 'command_result', commandId: 7, ok: true, result: { pid: 4242 } })
})

test('能力四 M1 试点回归: spawn 优先 profile-local bin（prefix 独立装树缺 peer，实证启动即崩）', async () => {
  const a = makeRuntime()
  await a.runtime.registerOnce()
  // 预置 profile-local bin（幂等落盘的 profile 文件装好后的形态）
  a.fs.store.set('/agent/nodes/ops01/profiles/ops01/node_modules/@deepseek-ai/dsh/lib/bin.js', '')
  a.transport.commandBatches.push([
    {
      id: 9,
      type: 'node.spawn',
      payload: {
        nodeId: 'ops01',
        args: ['--profile', 'ops01', '--port', '3081'],
        env: { DSH_HOME: '/agent/nodes/ops01', GW_KEY: 'apigw-k' },
        dshVersion: '0.1.5-rc.2',
        profile: { dir: 'profiles/ops01', files: { 'package.json': '{"dsh":1}' } },
      },
    },
  ])
  await a.runtime.loopOnce()
  const spawned = a.proc.spawned[0]
  assert.equal(spawned.bin.endsWith('/agent/nodes/ops01/profiles/ops01/node_modules/@deepseek-ai/dsh/lib/bin.js'), true, '有 profile-local bin 就绝不用 prefix 树')
  assert.equal(a.proc.installed.length, 0, 'prefix 独立安装跳过（其树缺 legacy peer 会崩）')
})

test('能力四 M2 回归: 文件未变 + 安装完成标记 = 跳过 npm 重装（慢盘重装分钟级）；半装态无标记必须重装', async () => {
  const a = makeRuntime()
  await a.runtime.registerOnce()
  const profileDir = '/agent/nodes/ops01/profiles/ops01'
  a.fs.store.set(`${profileDir}/node_modules/@deepseek-ai/dsh/lib/bin.js`, '')
  a.fs.store.set(`${profileDir}/.installed-ok`, '1')
  a.fs.store.set(`${profileDir}/package.json`, '{"dsh":1}')
  a.transport.commandBatches.push([
    { id: 51, type: 'node.spawn', payload: { nodeId: 'ops01', args: ['--profile', 'ops01'], env: { DSH_HOME: '/agent/nodes/ops01' }, dshVersion: '0.1.5-rc.2', profile: { dir: 'profiles/ops01', files: { 'package.json': '{"dsh":1}' } } } },
  ])
  await a.runtime.loopOnce()
  assert.equal(a.proc.profileInstalls.length, 0, '未变 + 标记 = 跳过重装')

  // 文件变了 → 即使有标记也重装
  a.transport.commandBatches.push([
    { id: 52, type: 'node.spawn', payload: { nodeId: 'ops01', args: [], env: { DSH_HOME: '/agent/nodes/ops01' }, dshVersion: '0.1.5-rc.2', profile: { dir: 'profiles/ops01', files: { 'package.json': '{"dsh":2}' } } } },
  ])
  await a.runtime.loopOnce()
  assert.equal(a.proc.profileInstalls.length, 1, '内容变化必须重装')

  // 无标记（半装态/旧版）→ 重装兜底
  const b = makeRuntime()
  await b.runtime.registerOnce()
  b.fs.store.set(`${profileDir}/node_modules/x`, '')
  b.transport.commandBatches.push([
    { id: 53, type: 'node.spawn', payload: { nodeId: 'ops01', args: [], env: { DSH_HOME: '/agent/nodes/ops01' }, dshVersion: '0.1.5-rc.2', profile: { dir: 'profiles/ops01', files: { 'package.json': '{}' } } } },
  ])
  await b.runtime.loopOnce()
  assert.equal(b.proc.profileInstalls.length, 1, '无完成标记必须重装')
})

test('舰队 M3 回归: ALLOW_FULL_ACCESS=true 时 settings.yaml 带 facade allowFullAccess 开锁', async () => {
  const a = makeRuntime()
  await a.runtime.registerOnce()
  a.transport.commandBatches.push([
    { id: 61, type: 'node.spawn', payload: { nodeId: 'ops33', args: [], env: { DSH_HOME: '/agent/nodes/ops33', GW_KEY: 'apigw-k', ALLOW_FULL_ACCESS: 'true' }, dshVersion: '0.1.5-rc.2', profile: { dir: 'profiles/ops33', files: { 'package.json': '{}' } } } },
  ])
  await a.runtime.loopOnce()
  const settings = a.fs.store.get('/agent/nodes/ops33/settings.yaml') ?? ''
  assert.match(settings, /apiKeys: \['apigw-k'\]/, 'GW_KEY 照旧写入')
  assert.match(settings, /allowFullAccess: true/, 'ops 节点开锁字段写入')

  const b = makeRuntime()
  await b.runtime.registerOnce()
  b.transport.commandBatches.push([
    { id: 62, type: 'node.spawn', payload: { nodeId: 'ops34', args: [], env: { DSH_HOME: '/agent/nodes/ops34', GW_KEY: 'apigw-k' }, dshVersion: '0.1.5-rc.2', profile: { dir: 'profiles/ops34', files: { 'package.json': '{}' } } } },
  ])
  await b.runtime.loopOnce()
  const plain = b.fs.store.get('/agent/nodes/ops34/settings.yaml') ?? ''
  assert.ok(!plain.includes('allowFullAccess'), '普通节点不开锁')
})

test('能力四 M4-4: 心跳指标——首轮携带主机指标，60s 窗口内不重报', async () => {
  const a = makeRuntime()
  await a.runtime.registerOnce()
  a.transport.commandBatches.push([])
  await a.runtime.loopOnce()
  const first = a.transport.eventsPosted.flat().find((e) => e.type === 'heartbeat')
  assert.ok(first !== undefined && typeof first.detail?.metrics === 'object', '首轮心跳带指标')
  assert.equal(typeof first.detail.metrics.memTotal, 'number')
  assert.equal(first.detail.metrics.platform, process.platform)

  a.transport.commandBatches.push([])
  await a.runtime.loopOnce()
  const second = (a.transport.eventsPosted[1] ?? []).filter((e) => e.type === 'heartbeat')
  assert.equal(second.length, 0, '60s 窗口内不重复上报（采样节流）')
})

test('能力四 M4-3: agent.update——sha256 校验通过 staging 到 .next + 待退出；坏校验拒绝', async () => {
  const { createHash } = await import('node:crypto')
  const a = makeRuntime()
  await a.runtime.registerOnce()
  const runtimeContent = 'runtime-v2'
  const entryContent = 'entry-v2'
  const files = { 'runtime.mjs': runtimeContent, 'agent.mjs': entryContent }
  const sha = createHash('sha256').update(Object.keys(files).sort().map((name) => `${name}:${files[name]}`).join('\n')).digest('hex')
  a.transport.commandBatches.push([
    { id: 41, type: 'agent.update', payload: { files, sha256: sha, managerVersion: '9.9.9' } },
  ])
  await a.runtime.loopOnce()
  assert.equal(a.fs.store.get('/agent/.next/runtime.mjs'), runtimeContent, '.next staging')
  assert.equal(a.fs.store.get('/agent/.next/.version'), '9.9.9', '目标版本随包')
  assert.equal(a.runtime.pendingExit, true, '回报后退出交给服务管理器')
  const posted = a.transport.eventsPosted.flat().find((e) => e.type === 'command_result')
  assert.equal(posted?.ok, true)

  const b = makeRuntime()
  await b.runtime.registerOnce()
  b.transport.commandBatches.push([
    { id: 42, type: 'agent.update', payload: { files: { 'runtime.mjs': 'x', 'agent.mjs': 'y' }, sha256: 'deadbeef', managerVersion: '9.9.9' } },
  ])
  await b.runtime.loopOnce()
  const second = b.transport.eventsPosted.flat().find((e) => e.type === 'command_result')
  assert.equal(second?.ok, false, '校验失败拒绝换装')
  assert.equal(b.fs.store.get('/agent/.next/runtime.mjs') ?? null, null, '不 staging')
  assert.equal(b.runtime.pendingExit, false, '不退出')
})

test('能力四 M4-3: 版本协商——启动后首轮心跳携带 agentVersion（.update-version 为准）', async () => {
  const a = makeRuntime()
  await a.runtime.registerOnce()
  a.fs.store.set('/agent/.update-version', '1.1.2')
  a.runtime.agentVersion = '1.1.2'
  a.transport.commandBatches.push([])
  await a.runtime.loopOnce()
  const heartbeat = a.transport.eventsPosted.flat().find((e) => e.type === 'heartbeat')
  assert.equal(heartbeat?.detail?.agentVersion, '1.1.2', '心跳携带版本（与指标合并进同一条）')
})

test('能力四 M4-2: 超大 node.log 在 spawn 前轮转（保留一代，新日志从零开始）', async () => {
  const { NODE_LOG_MAX_BYTES } = await import('./agent/runtime.mjs')
  const big = NODE_LOG_MAX_BYTES + 1024
  const a = makeRuntime()
  await a.runtime.registerOnce()
  // 预置 profile-local bin + 一个超限的旧日志
  a.fs.store.set('/agent/nodes/ops01/profiles/ops01/node_modules/@deepseek-ai/dsh/lib/bin.js', '')
  a.fs.store.set('/agent/nodes/ops01/node.log', 'x'.repeat(big))
  a.runtime.nodes.set('ops01', { pid: null, startedAt: null, logOffset: 999 })
  a.transport.commandBatches.push([
    {
      id: 31,
      type: 'node.spawn',
      payload: {
        nodeId: 'ops01',
        args: ['--profile', 'ops01', '--port', '3081'],
        env: { DSH_HOME: '/agent/nodes/ops01', GW_KEY: 'apigw-k' },
        dshVersion: '0.1.5-rc.2',
        profile: { dir: 'profiles/ops01', files: { 'package.json': '{"dsh":1}' } },
      },
    },
  ])
  await a.runtime.loopOnce()
  assert.equal(a.fs.store.get('/agent/nodes/ops01/node.log.1')?.length, big, '旧日志轮转到 .1（保留一代，崩溃排障不丢）')
  assert.equal(a.fs.store.get('/agent/nodes/ops01/node.log') ?? null, null, '旧 node.log 已让位（真实 spawn 会开新文件）')
  const node = a.runtime.nodes.get('ops01')
  assert.equal(node?.logOffset, 0, '新日志世代偏移归零')

  // 小日志不轮转
  const b = makeRuntime()
  await b.runtime.registerOnce()
  b.fs.store.set('/agent/nodes/ops01/profiles/ops01/node_modules/@deepseek-ai/dsh/lib/bin.js', '')
  b.fs.store.set('/agent/nodes/ops01/node.log', 'small-boot\n')
  b.transport.commandBatches.push([
    { id: 32, type: 'node.spawn', payload: { nodeId: 'ops01', args: [], env: { DSH_HOME: '/agent/nodes/ops01' }, dshVersion: '0.1.5-rc.2', profile: { dir: 'profiles/ops01', files: { 'package.json': '{}' } } } },
  ])
  await b.runtime.loopOnce()
  assert.equal(b.fs.store.get('/agent/nodes/ops01/node.log'), 'small-boot\n', '小日志原样保留')
  assert.equal(b.fs.store.get('/agent/nodes/ops01/node.log.1'), undefined, '不产生 .1')
})

test('能力四 M4-1: config.deliver 身份轮换——新 token 落盘立即生效；未知 kind 诚实失败', async () => {
  const a = makeRuntime()
  await a.runtime.registerOnce()
  a.transport.commandBatches.push([
    { id: 21, type: 'config.deliver', payload: { kind: 'identity', agentToken: 'token-rotated-1' } },
  ])
  await a.runtime.loopOnce()
  assert.equal(a.runtime.agentToken, 'token-rotated-1', '新 token 立即生效（后续轮询用它鉴权）')
  const saved = JSON.parse(a.fs.store.get('/agent/agent.json') ?? '{}')
  assert.equal(saved.agentToken, 'token-rotated-1', '身份落盘')
  const posted = a.transport.eventsPosted.flat().find((e) => e.type === 'command_result')
  assert.equal(posted?.ok, true, '回报成功')

  a.transport.commandBatches.push([{ id: 22, type: 'config.deliver', payload: { kind: 'nope' } }])
  await a.runtime.loopOnce()
  const second = a.transport.eventsPosted.at(-1)?.find((e) => e.commandId === 22)
  assert.equal(second?.ok, false, '未知 kind 诚实失败（manager 侧据此回滚）')
})

test('能力四 M1-5: stop/restart/logs/status/未知指令', async () => {
  const a = makeRuntime()
  await a.runtime.registerOnce()
  a.runtime.nodes.set('ops01', { pid: 4242, startedAt: Date.now(), logOffset: 0 })
  a.fs.store.set('/agent/nodes/ops01/node.log', 'line1\nline2\nline3\n')

  a.transport.commandBatches.push([{ id: 1, type: 'node.stop', payload: { nodeId: 'ops01' } }])
  a.transport.commandBatches.push([{ id: 2, type: 'node.restart', payload: { nodeId: 'ops01', args: [], env: {}, dshVersion: '0.1.2-rc.1' } }])
  a.transport.commandBatches.push([{ id: 3, type: 'node.logs', payload: { nodeId: 'ops01' } }])
  a.transport.commandBatches.push([{ id: 4, type: 'node.status' }])
  a.transport.commandBatches.push([{ id: 5, type: 'agent.update', payload: {} }])
  await a.runtime.loopOnce()
  await a.runtime.loopOnce()
  await a.runtime.loopOnce()
  await a.runtime.loopOnce()
  await a.runtime.loopOnce()

  assert.deepEqual(a.proc.killed, [4242], 'stop 杀 pid')
  const results = a.transport.eventsPosted.flat().filter((e) => e.type === 'command_result')
  assert.equal(results[0]?.ok, true, 'stop ok')
  assert.equal(results[1]?.ok, true, 'restart ok（stop+spawn）')
  assert.equal((results[2]?.result?.logs ?? '').includes('line3'), true, 'logs 读尾部')
  assert.equal((results[3]?.result?.nodes ?? []).length >= 1, true, 'status 列出节点')
  assert.equal(results[4]?.ok, false, '未知指令诚实失败')
})

test('能力四 M1-5: 日志增量分块回传；失联指数退避；401 清身份重注册；AbortSignal 干净退出', async () => {
  const a = makeRuntime()
  await a.runtime.registerOnce()
  a.runtime.nodes.set('ops01', { pid: 4242, startedAt: Date.now(), logOffset: 0 })
  a.fs.store.set('/agent/nodes/ops01/node.log', 'boot\n')
  a.transport.commandBatches.push([])
  await a.runtime.loopOnce()
  const chunked = a.transport.eventsPosted.flat().find((e) => e.type === 'log_chunk')
  assert.equal(chunked?.chunk, 'boot\n', '首轮全量增量')

  a.fs.store.set('/agent/nodes/ops01/node.log', 'boot\ndsh web: http://127.0.0.1:3081\n')
  a.transport.commandBatches.push([])
  await a.runtime.loopOnce()
  const chunked2 = a.transport.eventsPosted[1].find((e) => e.type === 'log_chunk')
  assert.equal(chunked2?.chunk, 'dsh web: http://127.0.0.1:3081\n', '只回传增量')

  // 失联退避 + AbortSignal 退出
  const b = makeRuntime()
  let calls = 0
  b.transport.commands = async () => {
    calls += 1
    throw new Error('network down')
  }
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 50)
  await b.runtime.run({ signal: controller.signal })
  assert.ok(b.backoffs.length >= 1, '失败后走了退避')
  assert.ok(b.backoffs[0] >= 1_000, `首次退避 ≥1s（实际 ${b.backoffs[0]}）`)

  // 401 → 清身份 → 重注册（吊销场景可观测 = 再次注册）
  const c = makeRuntime()
  c.transport.commands = async () => {
    throw new Error('unauthorized')
  }
  const ctrl = new AbortController()
  setTimeout(() => ctrl.abort(), 80)
  await c.runtime.run({ signal: ctrl.signal })
  assert.ok(c.transport.registerCalls.length >= 2, '401 后重新注册')
})

test('能力四 M1-5: LEGACY_PEER_DEPS_VERSIONS 覆盖 0.1.5（与矩阵 needsLegacyPeerDeps 对齐）', () => {
  assert.ok(LEGACY_PEER_DEPS_VERSIONS.includes('0.1.5-rc.2'))
  assert.ok(!LEGACY_PEER_DEPS_VERSIONS.includes('0.1.2-rc.1'))
})

test('能力四 M1 试点回归: npm 调用必须 shell:true 且路径走 cwd（Windows .cmd 垫片 ENOENT 实证）', async () => {
  const { execFileSync } = await import('node:child_process')
  const { npmInvocation } = await import('./agent/runtime.mjs')
  const inv = npmInvocation(['install', 'x@1.0.0', '--no-audit', '--no-fund'], 'C:\\dir with space\\p')
  assert.equal(inv.options.shell, true, 'Windows 上 npm 是 .cmd 垫片，必须 shell:true 交给系统 shell 解析（node≥20 无 shell 直接 ENOENT/EINVAL）')
  assert.equal(inv.options.cwd, 'C:\\dir with space\\p', '安装目录只走 cwd——路径参数会被 shell 连接时拆断')
  assert.ok(!inv.args.some((a) => a.includes('dir with space')), '路径不得出现在参数里')
  if (process.platform === 'win32') {
    const out = execFileSync('npm', ['--version'], { shell: true, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' })
    assert.match(out.trim(), /^\d+\.\d+\.\d+/, '真实 npm 经 shell 可解析（旧写法 execFileSync(\'npm\') 无 shell = ENOENT）')
  }
})

test('能力四 M1 试点回归: Windows spawn bin.js 必须经 node 执行（CreateProcess EFTYPE 实证）', async () => {
  const { spawnInvocation } = await import('./agent/runtime.mjs')
  const win = spawnInvocation('win32', 'C:\\agent\\dsh\\0.1.5-rc.2\\bin.js', ['--profile', 'pilot01', '--port', '3197'])
  assert.equal(win.cmd, process.execPath, 'win32: .js 无 shebang，直接 spawn 是 EFTYPE——命令必须是 node')
  assert.deepEqual(win.args, ['C:\\agent\\dsh\\0.1.5-rc.2\\bin.js', '--profile', 'pilot01', '--port', '3197'], 'bin 转第一个参数')
  const posix = spawnInvocation('linux', '/agent/dsh/0.1.5-rc.2/bin.js', ['--profile', 'pilot01'])
  assert.equal(posix.cmd, '/agent/dsh/0.1.5-rc.2/bin.js', 'posix: shebang 可直接 spawn')
  assert.deepEqual(posix.args, ['--profile', 'pilot01'])
})

