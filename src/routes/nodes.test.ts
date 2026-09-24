import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import type { AppConfig } from '../config.js'
import { DEFAULT_PRICING } from '../pricing.js'
import { GatewayClient } from '../gateway/client.js'
import { startFakeGateway, type FakeGateway } from '../gateway/fake.js'
import { NodeSupervisor } from '../nodes/supervisor.js'
import { registerNodesRoutes } from './nodes.js'

const API_KEY = 'test-key'
const gateways: FakeGateway[] = []

const ep = (gw: FakeGateway) => ({
  id: 'A',
  url: gw.url,
  driver: 'gateway' as const,
  prefix: gw.prefix,
  key: API_KEY,
  sandboxBase: null,
  sandboxKey: '',
  spawn: null, access: null,
})

const configFor = (gw: FakeGateway): AppConfig => ({
  listen: { host: '127.0.0.1', port: 0 },
  endpoints: { A: ep(gw) },
  agents: {
    personal: {
      id: 'personal', name: '个人', endpoint: 'A', workspacePath: '.',
      public: false, preset: null, sandboxMode: null, gitRemote: null, provider: null, model: null,
  validate: null,
},
  },
  runner: { timeoutMs: 1_000, silenceMs: 0, maxConsecutiveFailures: 3, dailyBudgetMicroUsd: null },
  databasePath: ':memory:',
  pricing: DEFAULT_PRICING,
  sessionSecret: 'x'.repeat(32),
  initialUser: { username: 'admin', password: null },
  warnings: [],
})

after(async () => {
  await Promise.all(gateways.map((g) => g.close()))
})

test('an unmanaged node reports the probe result as its state', async () => {
  const gw = await startFakeGateway({ frames: [] }, API_KEY)
  gateways.push(gw)
  const config = configFor(gw)
  const app = Fastify()
  const clients = new Map([['A', new GatewayClient(ep(gw))]])
  registerNodesRoutes(app, config, new Map(), clients, new Map(), async () => {})

  const res = await app.inject({ method: 'GET', url: '/api/nodes' })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.nodes.length, 1)
  assert.equal(body.nodes[0]?.id, 'A')
  assert.equal(body.nodes[0]?.managed, false)
  assert.equal(body.nodes[0]?.state, 'live')
  assert.deepEqual(body.nodes[0]?.agents, ['personal'])
  // 蜂群2计划 P1：gateway 驱动探测不到 DSH 版本 → null，不产生虚假告警
  assert.equal(body.nodes[0]?.dshVersion, null)
  assert.equal(body.nodes[0]?.dshCompatible, null)
  // UI 收尾 C-P1.5：本机平台信息（拓扑「本机卡」数据源）
  assert.equal(typeof body.hostOs, 'string', 'hostOs 必须随 /api/nodes 返回')
  assert.equal(typeof body.hostArch, 'string', 'hostArch 必须随 /api/nodes 返回')
  // UI 收尾 C-P1.5：本机行数据源（机器列表首行的主机名与 node 版本）
  assert.equal(typeof body.hostName, 'string', 'hostName 必须随 /api/nodes 返回')
  assert.equal(typeof body.hostNodeVersion, 'string', 'hostNodeVersion 必须随 /api/nodes 返回')
})

test('a managed node reports the supervisor state machine', async () => {
  const gw = await startFakeGateway({ frames: [] }, API_KEY)
  gateways.push(gw)
  const config = configFor(gw)
  const app = Fastify()
  const supervisors = new Map([
    ['A', new NodeSupervisor('A', { probe: async () => ({ ok: true, detail: '' }) })],
  ])
  registerNodesRoutes(app, config, supervisors, new Map(), new Map(), async () => {})

  const res = await app.inject({ method: 'GET', url: '/api/nodes' })
  const body = res.json()
  assert.equal(body.nodes[0]?.managed, true)
  assert.equal(body.nodes[0]?.state, 'cold')
  assert.equal(body.nodes[0]?.pid, null)
})

test('an unreachable unmanaged node reports offline with the reason', async () => {
  const gw = await startFakeGateway({ frames: [] }, API_KEY)
  gateways.push(gw)
  const config = configFor(gw)
  const app = Fastify()
  const clients = new Map([['A', new GatewayClient({ ...ep(gw), url: 'http://127.0.0.1:1' })]])
  registerNodesRoutes(app, config, new Map(), clients, new Map(), async () => {})

  const res = await app.inject({ method: 'GET', url: '/api/nodes' })
  const body = res.json()
  assert.equal(body.nodes[0]?.state, 'offline')
  assert.ok((body.nodes[0]?.lastError ?? '').length > 0)
})

// ---- 蜂群 P5.1：节点管控 ----

const managedSpawn = {
  managed: true,
  command: 'node',
  args: ['--version'],
  cwd: null,
  readyTimeoutMs: 30_000,
  detached: false,
  logFile: null,
  env: {},
  restart: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 },
}

const stubSupervisor = (calls: { start: number; stop: number; restart: number }) =>
  ({
    start: () => {
      calls.start += 1
    },
    stop: () => {
      calls.stop += 1
    },
    restart: () => {
      calls.restart += 1
    },
    logs: () => 'hello\nworld',
    containerImage: async () => null,
    dockerLogs: async () => null,
    current: { state: 'cold' },
  }) as unknown as NodeSupervisor

test('蜂群 P5.1: managed nodes accept up/down/restart and serve their log buffer', async () => {
  const gw = await startFakeGateway({ frames: [] }, API_KEY)
  gateways.push(gw)
  const config = configFor(gw)
  config.endpoints['A']!.spawn = managedSpawn as never
  const calls = { start: 0, stop: 0, restart: 0 }
  const app = Fastify()
  registerNodesRoutes(app, config, new Map([['A', stubSupervisor(calls)]]), new Map(), new Map(), async () => {})

  const up = await app.inject({ method: 'POST', url: '/api/nodes/A/up' })
  assert.equal(up.statusCode, 200)
  assert.equal(calls.start, 1)

  const down = await app.inject({ method: 'POST', url: '/api/nodes/A/down' })
  assert.equal(down.statusCode, 200)
  assert.equal(calls.stop, 1)

  const restart = await app.inject({ method: 'POST', url: '/api/nodes/A/restart' })
  assert.equal(restart.statusCode, 200)
  assert.equal(calls.restart, 1)

  const logs = await app.inject({ method: 'GET', url: '/api/nodes/A/logs' })
  assert.equal(logs.statusCode, 200)
  assert.equal((logs.json()).logs, 'hello\nworld')
  assert.equal((logs.json()).source, 'buffer')
})

test('蜂群 P5.1: unmanaged nodes get a friendly 409, unknown nodes a 404', async () => {
  const gw = await startFakeGateway({ frames: [] }, API_KEY)
  gateways.push(gw)
  const config = configFor(gw)
  const app = Fastify()
  registerNodesRoutes(app, config, new Map(), new Map(), new Map(), async () => {})

  const up = await app.inject({ method: 'POST', url: '/api/nodes/A/up' })
  assert.equal(up.statusCode, 409)
  assert.match(String((up.json()).detail), /managed outside the manager/)

  const logs = await app.inject({ method: 'GET', url: '/api/nodes/A/logs' })
  assert.equal(logs.statusCode, 409)

  const missing = await app.inject({ method: 'POST', url: '/api/nodes/nope/down' })
  assert.equal(missing.statusCode, 404)
})

test('蜂群2计划 P2b: docker runner 节点的日志走 docker logs', async () => {
  const gw = await startFakeGateway({ frames: [] }, API_KEY)
  gateways.push(gw)
  const config = configFor(gw)
  const dockerSpawn = {
    ...managedSpawn,
    runner: 'docker' as const,
    host: null,
    docker: { image: 'hellodac/dac-node:0.1.1-rc.2', containerName: null, network: 'hive', port: 3081, hostVolumes: {}, namedVolumes: {} },
  }
  config.endpoints['A']!.spawn = dockerSpawn
  const calls = { start: 0, stop: 0, restart: 0 }
  const supervisor = stubSupervisor(calls) as unknown as NodeSupervisor & { dockerLogs: () => Promise<string | null> }
  supervisor.dockerLogs = async () => 'container-log\n'
  const app = Fastify()
  registerNodesRoutes(app, config, new Map([['A', supervisor]]), new Map(), new Map(), async () => {})

  const logs = await app.inject({ method: 'GET', url: '/api/nodes/A/logs' })
  assert.equal(logs.statusCode, 200)
  assert.equal((logs.json()).logs, 'container-log\n')
  assert.equal((logs.json()).source, 'docker')
})

test('债务 P3 回归: 进程节点漂移检测 + align-version 对齐（重播种/重装/重启，幂等）', async () => {
  const gw = await startFakeGateway({ frames: [] }, API_KEY)
  gateways.push(gw)
  const config = configFor(gw)
  const profileDir = mkdtempSync(join(tmpdir(), 'nodes-align-'))
  const spawn = {
    ...managedSpawn,
    runner: 'process' as const,
    host: null,
    env: { DSH_HOME: join(profileDir, '..') }, // profile 目录 = DSH_HOME/profiles/<id>
    docker: null,
  }
  config.endpoints['A']!.spawn = spawn
  mkdirSync(join(profileDir, '..', 'profiles', 'A'), { recursive: true })
  writeFileSync(join(profileDir, '..', 'profiles', 'A', '.seed-version'), 'stale-seed\n', 'utf8')
  const calls = { start: 0, stop: 0, restart: 0 }
  const app = Fastify()
  registerNodesRoutes(
    app, config, new Map([['A', stubSupervisor(calls)]]), new Map(), new Map(), async () => {},
    undefined,
    async (dir) => {
      // 假安装器：不触网——写一个假的 profile 内 bin 就算装完
      const binDir = join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib')
      mkdirSync(binDir, { recursive: true })
      writeFileSync(join(binDir, 'bin.js'), '', 'utf8')
    },
  )

  const before = await app.inject({ method: 'GET', url: '/api/nodes' })
  assert.equal((before.json() as { nodes: Array<{ dshDrift: boolean }> }).nodes[0]?.dshDrift, true, '旧标记 → 漂移')

  const align = await app.inject({ method: 'POST', url: '/api/nodes/A/align-version' })
  assert.equal(align.statusCode, 202)
  await new Promise((resolve) => setTimeout(resolve, 20))

  const after = await app.inject({ method: 'GET', url: '/api/nodes' })
  assert.equal((after.json() as { nodes: Array<{ dshDrift: boolean }> }).nodes[0]?.dshDrift, false, '对齐后漂移消失')
  assert.equal(calls.restart, 1, '对齐完成后重启节点')
  const marker = readFileSync(join(profileDir, '..', 'profiles', 'A', '.seed-version'), 'utf8').trim()
  assert.equal(marker.length, 40, '标记重写为 sha1')
})

test('P1 回归: POST /api/nodes/:id/version 进程分支——钉版落盘 + 对齐链 + 审计 + 未知版本 400', async () => {
  const gw = await startFakeGateway({ frames: [] }, API_KEY)
  gateways.push(gw)
  const config = configFor(gw)
  const dir = mkdtempSync(join(tmpdir(), 'nodes-version-'))
  const configPath = join(dir, 'manager.config.yaml')
  writeFileSync(configPath, 'endpoints:\n  A:\n    url: http://x\n', 'utf8')
  config.configPath = configPath
  const profileRoot = mkdtempSync(join(tmpdir(), 'nodes-vprof-'))
  const spawn = {
    ...managedSpawn,
    runner: 'process' as const,
    host: null,
    env: { DSH_HOME: join(profileRoot, '..') },
    docker: null,
  }
  config.endpoints['A']!.spawn = spawn
  mkdirSync(join(profileRoot, '..', 'profiles', 'A'), { recursive: true })
  const calls = { start: 0, stop: 0, restart: 0 }
  const audits: string[] = []
  const app = Fastify()
  registerNodesRoutes(
    app, config, new Map([['A', stubSupervisor(calls)]]), new Map(), new Map(), async () => {},
    (_actor, kind) => audits.push(kind),
    async (dir2) => {
      const binDir = join(dir2, 'node_modules', '@deepseek-ai', 'dsh', 'lib')
      mkdirSync(binDir, { recursive: true })
      writeFileSync(join(binDir, 'bin.js'), '', 'utf8')
    },
  )

  const res = await app.inject({ method: 'POST', url: '/api/nodes/A/version', payload: { dsh_version: '0.1.5-rc.2' } })
  assert.equal(res.statusCode, 202, JSON.stringify(res.body))
  assert.equal((res.json() as { version: string }).version, '0.1.5-rc.2')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(config.endpoints['A']?.spawn?.dshVersion, '0.1.5-rc.2', '内存钉版热加载')
  assert.match(readFileSync(configPath, 'utf8'), /dsh_version: 0.1.5-rc.2/, '真相源落盘显式钉版')
  assert.ok(audits.includes('node_version_change'), '审计 node_version_change')
  assert.equal(calls.restart, 1, '对齐完成后重启')

  const bad = await app.inject({ method: 'POST', url: '/api/nodes/A/version', payload: { dsh_version: '0.9.9' } })
  assert.equal(bad.statusCode, 400)
  assert.equal((bad.json() as { error: string }).error, 'unknown_dsh_version')
})

test('P1 回归: profile 目录按 spawn.args 的 --profile 解析（端点 id ≠ profile 名，线上实踩）', async () => {
  const gw = await startFakeGateway({ frames: [] }, API_KEY)
  gateways.push(gw)
  const config = configFor(gw)
  const dir = mkdtempSync(join(tmpdir(), 'nodes-vprofile-'))
  const configPath = join(dir, 'manager.config.yaml')
  writeFileSync(configPath, 'endpoints:\n  A:\n    url: http://x\n', 'utf8')
  config.configPath = configPath
  const dshHome = mkdtempSync(join(tmpdir(), 'nodes-vhome-'))
  const spawn = {
    ...managedSpawn,
    runner: 'process' as const,
    args: ['bin.js', '--profile', 'real-prof'],
    env: { DSH_HOME: dshHome },
    docker: null,
  }
  config.endpoints['A']!.spawn = spawn as never
  const realDir = join(dshHome, 'profiles', 'real-prof')
  mkdirSync(realDir, { recursive: true })
  writeFileSync(join(realDir, '.seed-version'), 'stale\n', 'utf8')
  writeFileSync(join(realDir, 'package.json'), '{"dependencies":{}}', 'utf8')
  const calls = { start: 0, stop: 0, restart: 0 }
  const app = Fastify()
  registerNodesRoutes(
    app, config, new Map([['A', stubSupervisor(calls)]]), new Map(), new Map(), async () => {},
    undefined,
    async () => undefined, // 假安装器：不触网
  )

  const res = await app.inject({ method: 'POST', url: '/api/nodes/A/version', payload: { dsh_version: '0.1.5-rc.2' } })
  assert.equal(res.statusCode, 202, JSON.stringify(res.body))
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.equal(existsSync(join(dshHome, 'profiles', 'A')), false, '不得按端点 id 造幽灵 profile 目录')
  const realPkg = JSON.parse(readFileSync(join(realDir, 'package.json'), 'utf8'))
  assert.equal(realPkg.dependencies?.['@deepseek-ai/dsh'], '0.1.5-rc.2', '真实 profile（--profile 指定名）被重播种')
  assert.equal(readFileSync(join(realDir, '.seed-version'), 'utf8').trim().length, 40, '真实目录种子重写')
})

test('P1 回归: POST /api/nodes/:id/version 容器分支——镜像 tag 落盘 + 立即重建 + 审计', async () => {
  const gw = await startFakeGateway({ frames: [] }, API_KEY)
  gateways.push(gw)
  const config = configFor(gw)
  const dir = mkdtempSync(join(tmpdir(), 'nodes-vdocker-'))
  const configPath = join(dir, 'manager.config.yaml')
  writeFileSync(configPath, 'endpoints:\n  A:\n    url: http://x\n', 'utf8')
  config.configPath = configPath
  const dockerSpawn = {
    ...managedSpawn,
    runner: 'docker' as const,
    host: null,
    docker: { image: 'hellodac/dac-node:0.1.2-rc.1', containerName: null, network: 'dac-hive', port: 3081, hostVolumes: {}, namedVolumes: {} },
  }
  config.endpoints['A']!.spawn = dockerSpawn as never
  const calls = { start: 0, stop: 0, restart: 0 }
  const audits: string[] = []
  const app = Fastify()
  registerNodesRoutes(
    app, config, new Map([['A', stubSupervisor(calls)]]), new Map(), new Map(), async () => {},
    (_actor, kind) => audits.push(kind),
  )

  const res = await app.inject({ method: 'POST', url: '/api/nodes/A/version', payload: { dsh_version: '0.1.5-rc.2' } })
  assert.equal(res.statusCode, 202, JSON.stringify(res.body))
  assert.equal((res.json() as { image: string }).image, 'hellodac/dac-node:0.1.5-rc.2')
  assert.equal((config.endpoints['A']?.spawn as unknown as { docker: { image: string } } | null)?.docker.image, 'hellodac/dac-node:0.1.5-rc.2', '内存镜像 tag 热加载')
  assert.match(readFileSync(configPath, 'utf8'), /image: hellodac\/dac-node:0.1.5-rc.2/, '真相源落盘镜像 tag')
  assert.equal(calls.restart, 1, '立即重建（不等对账周期）')
  assert.ok(audits.includes('node_version_change'))
})

test('债务 P1 回归: POST /api/nodes/:id/access 写真相源并热加载;clear 移除;非法值 400', async () => {
  const gw = await startFakeGateway({ frames: [] }, API_KEY)
  gateways.push(gw)
  const config = configFor(gw)
  const dir = mkdtempSync(join(tmpdir(), 'nodes-access-'))
  const configPath = join(dir, 'manager.config.yaml')
  writeFileSync(configPath, 'endpoints:\n  A:\n    url: http://x\n', 'utf8')
  config.configPath = configPath
  const audits: string[] = []
  const app = Fastify()
  registerNodesRoutes(app, config, new Map(), new Map(), new Map(), async () => {}, (_actor, kind) => audits.push(kind))

  const set = await app.inject({
    method: 'POST',
    url: '/api/nodes/A/access',
    payload: { ssh_user: 'ubuntu', ssh_host: '10.0.0.5', local_port: 3088, ssh_key: 'C:\\Users\\you\\.ssh\\id_ed25519' },
  })
  assert.equal(set.statusCode, 200)
  assert.deepEqual(config.endpoints['A']?.access, { sshUser: 'ubuntu', sshHost: '10.0.0.5', sshPort: 22, guiPort: 3080, localPort: 3088, sshKey: 'C:\\Users\\you\\.ssh\\id_ed25519' }, '内存热加载')
  assert.match(readFileSync(configPath, 'utf8'), /access:/, '真相源落盘')
  assert.match(readFileSync(configPath, 'utf8'), /ssh_key/, '私钥路径落盘（非密钥内容）')
  assert.ok(audits.includes('node_access_update'), '审计留痕')

  const clear = await app.inject({ method: 'POST', url: '/api/nodes/A/access', payload: { clear: true } })
  assert.equal(clear.statusCode, 200)
  assert.equal(config.endpoints['A']?.access, null)
  assert.doesNotMatch(readFileSync(configPath, 'utf8'), /access:/)

  const bad = await app.inject({ method: 'POST', url: '/api/nodes/A/access', payload: { ssh_user: 'u', ssh_host: 'h' } })
  assert.equal(bad.statusCode, 400)

  const missing = await app.inject({ method: 'POST', url: '/api/nodes/nope/access', payload: { ssh_user: 'u', ssh_host: 'h', local_port: 1 } })
  assert.equal(missing.statusCode, 404)
})

test('债务 P1 回归: GET /api/nodes 挂 access + guiUrl（token 从日志即时捕获，重启轮换自动跟随）', async () => {
  const gw = await startFakeGateway({ frames: [] }, API_KEY)
  gateways.push(gw)
  const config = configFor(gw)
  config.endpoints['A']!.access = { sshUser: 'ubuntu', sshHost: '10.0.0.5', sshPort: 22, guiPort: 3080, localPort: 3088, sshKey: null }
  config.endpoints['A']!.spawn = managedSpawn as never
  const app = Fastify()
  const supervisor = stubSupervisor({ start: 0, stop: 0, restart: 0 }) as unknown as NodeSupervisor & { logs: () => string }
  supervisor.logs = () => 'dsh web: http://127.0.0.1:3080/?token=tok-abc\n'
  registerNodesRoutes(app, config, new Map([['A', supervisor]]), new Map(), new Map(), async () => {})

  const res = await app.inject({ method: 'GET', url: '/api/nodes' })
  assert.equal(res.statusCode, 200)
  const payload = res.json() as { nodes: Array<{ access: unknown; guiUrl: string | null }>; supportedDsh: Array<{ dsh: string; status: string }> }
  const node = payload.nodes[0]
  assert.deepEqual(node?.access, { sshUser: 'ubuntu', sshHost: '10.0.0.5', sshPort: 22, guiPort: 3080, localPort: 3088, sshKey: null })
  assert.equal(node?.guiUrl, 'http://127.0.0.1:3088/?token=tok-abc')
  assert.deepEqual(payload.supportedDsh.map((p) => p.dsh), ['0.1.2-rc.1', '0.1.5-rc.2'], '向导版本下拉的数据源 = 矩阵')

  // 重启轮换：日志里出现新 token 行 → guiUrl 自动跟随
  supervisor.logs = () => 'dsh web: http://127.0.0.1:3080/?token=tok-old\nrestarted\ndsh web: http://127.0.0.1:3080/?token=tok-new\n'
  const after = await app.inject({ method: 'GET', url: '/api/nodes' })
  assert.equal((after.json() as { nodes: Array<{ guiUrl: string | null }> }).nodes[0]?.guiUrl, 'http://127.0.0.1:3088/?token=tok-new')

  // 未配置 access 的非 loopback 节点：access=null 且 guiUrl=null（无打开能力）
  config.endpoints['A']!.access = null
  config.endpoints['A']!.url = 'http://10.0.0.5:3080'
  const bare = await app.inject({ method: 'GET', url: '/api/nodes' })
  const bareNode = (bare.json() as { nodes: Array<{ access: unknown; guiUrl: string | null }> }).nodes[0]
  assert.equal(bareNode?.access, null)
  assert.equal(bareNode?.guiUrl, null)

  // 体验优化：本机 loopback 节点未配置 access 也直连——guiUrl 用启动行里的真实端口
  config.endpoints['A']!.url = 'http://127.0.0.1:3081'
  const direct = await app.inject({ method: 'GET', url: '/api/nodes' })
  const directNode = (direct.json() as { nodes: Array<{ access: unknown; guiUrl: string | null }> }).nodes[0]
  assert.equal(directNode?.access, null)
  assert.equal(directNode?.guiUrl, 'http://127.0.0.1:3080/?token=tok-new', '直连用日志端口（3080）而非配置端口（3081）')
})
