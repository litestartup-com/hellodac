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
  // Hive plan 2 P1: a gateway-driven probe cannot see the DSH version -> null, so no false alarm is raised
  assert.equal(body.nodes[0]?.dshVersion, null)
  assert.equal(body.nodes[0]?.dshCompatible, null)
  // UI wrap-up C-P1.5: local platform information (the data source of the topology's local card)
  assert.equal(typeof body.hostOs, 'string', 'hostOs must come back with /api/nodes')
  assert.equal(typeof body.hostArch, 'string', 'hostArch must come back with /api/nodes')
  // UI wrap-up C-P1.5: the data source of the local row (the hostname and node version on the first row of the machine list)
  assert.equal(typeof body.hostName, 'string', 'hostName must come back with /api/nodes')
  assert.equal(typeof body.hostNodeVersion, 'string', 'hostNodeVersion must come back with /api/nodes')
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

// ---- Hive P5.1: node control ----

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

test('Hive P5.1: managed nodes accept up/down/restart and serve their log buffer', async () => {
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

test('Hive P5.1: unmanaged nodes get a friendly 409, unknown nodes a 404', async () => {
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

test('Hive plan 2 P2b: a docker runner node serves its logs through docker logs', async () => {
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

test('Debt P3 regression: process node drift detection plus align-version alignment (reseed/reinstall/restart, idempotent)', async () => {
  const gw = await startFakeGateway({ frames: [] }, API_KEY)
  gateways.push(gw)
  const config = configFor(gw)
  const profileDir = mkdtempSync(join(tmpdir(), 'nodes-align-'))
  const spawn = {
    ...managedSpawn,
    runner: 'process' as const,
    host: null,
    env: { DSH_HOME: join(profileDir, '..') }, // the profile directory = DSH_HOME/profiles/<id>
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
      // Fake installer: no network -- writing a fake bin inside the profile counts as installed
      const binDir = join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib')
      mkdirSync(binDir, { recursive: true })
      writeFileSync(join(binDir, 'bin.js'), '', 'utf8')
    },
  )

  const before = await app.inject({ method: 'GET', url: '/api/nodes' })
  assert.equal((before.json() as { nodes: Array<{ dshDrift: boolean }> }).nodes[0]?.dshDrift, true, 'the stale marker -> drift')

  const align = await app.inject({ method: 'POST', url: '/api/nodes/A/align-version' })
  assert.equal(align.statusCode, 202)
  await new Promise((resolve) => setTimeout(resolve, 20))

  const after = await app.inject({ method: 'GET', url: '/api/nodes' })
  assert.equal((after.json() as { nodes: Array<{ dshDrift: boolean }> }).nodes[0]?.dshDrift, false, 'the drift is gone after alignment')
  assert.equal(calls.restart, 1, 'restart the node once alignment finishes')
  const marker = readFileSync(join(profileDir, '..', 'profiles', 'A', '.seed-version'), 'utf8').trim()
  assert.equal(marker.length, 40, 'the marker is rewritten to a sha1')
})

test('P1 regression: POST /api/nodes/:id/version on the process branch -- pinning written to disk, the alignment chain, the audit, and 400 for an unknown version', async () => {
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
  assert.equal(config.endpoints['A']?.spawn?.dshVersion, '0.1.5-rc.2', 'the pin hot-loads into memory')
  assert.match(readFileSync(configPath, 'utf8'), /dsh_version: 0.1.5-rc.2/, 'the explicit pin is written to the source of truth')
  assert.ok(audits.includes('node_version_change'), 'the audit records node_version_change')
  assert.equal(calls.restart, 1, 'restart once alignment finishes')

  const bad = await app.inject({ method: 'POST', url: '/api/nodes/A/version', payload: { dsh_version: '0.9.9' } })
  assert.equal(bad.statusCode, 400)
  assert.equal((bad.json() as { error: string }).error, 'unknown_dsh_version')
})

test('0.2.0 corridor: switching a process node to 0.2.0-rc.2 writes the PAIRED facade ref to the truth source and materializes the patch key row (settings.yaml is dead on the new lines)', async () => {
  const gw = await startFakeGateway({ frames: [] }, API_KEY)
  gateways.push(gw)
  const config = configFor(gw)
  const dir = mkdtempSync(join(tmpdir(), 'nodes-v020-'))
  const configPath = join(dir, 'manager.config.yaml')
  writeFileSync(configPath, 'endpoints:\n  A:\n    url: http://x\n', 'utf8')
  config.configPath = configPath
  const dshHome = mkdtempSync(join(tmpdir(), 'nodes-v020home-'))
  const spawn = {
    ...managedSpawn,
    runner: 'process' as const,
    env: { DSH_HOME: dshHome },
    docker: null,
    // A stale explicit ref from the legacy era: the switch must overwrite it with the paired row ref
    // (a stale b592b4f on a 0.2.0 node = the answerer pump dies silently, dsh-facts §18.2)
    dshVersion: '0.1.5-rc.2',
    gatewayRef: 'github:litestartup-com/dsh-api-gateway#b592b4f',
  }
  config.endpoints['A']!.spawn = spawn as never
  const profileDir = join(dshHome, 'profiles', 'A')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), '{"dependencies":{}}', 'utf8')
  const calls = { start: 0, stop: 0, restart: 0 }
  const app = Fastify()
  registerNodesRoutes(
    app, config, new Map([['A', stubSupervisor(calls)]]), new Map(), new Map(), async () => {},
    undefined,
    async () => undefined, // fake installer: no network
  )

  const res = await app.inject({ method: 'POST', url: '/api/nodes/A/version', payload: { dsh_version: '0.2.0-rc.2' } })
  assert.equal(res.statusCode, 202, JSON.stringify(res.body))
  await new Promise((resolve) => setTimeout(resolve, 20))

  const yaml = readFileSync(configPath, 'utf8')
  assert.match(yaml, /dsh_version: 0\.2\.0-rc\.2/, 'the version pin lands in the truth source')
  assert.match(yaml, /gateway_ref: github:litestartup-com\/dsh-api-gateway#398ea94/, 'the paired facade ref lands WITH it (writing the version alone leaves the stale ref in charge)')
  assert.equal((config.endpoints['A']?.spawn as unknown as { gatewayRef?: string | null } | null)?.gatewayRef, 'github:litestartup-com/dsh-api-gateway#398ea94', 'the in-memory spawn hot-loads the new ref too (a later align-version must not read the stale one)')

  // The reseed produced the 0.2.0-gated profile shape and the key moved into the patch (J1-04):
  // the endpoint key is the truth, settings.yaml is never consulted on this line.
  const pkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  assert.equal(pkg.dependencies['ohdsh-api-facade'], 'github:litestartup-com/dsh-api-gateway#398ea94')
  assert.ok(pkg.dsh.profile.patchReload === undefined, 'no patchReload on the new lines (J1-15)')
  const patch = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /session-log-deepseek/, 'the privacy row is baked (J1-22: the session-log upload defaults ON from the corridor)')
  assert.match(patch, /ohdsh-api-facade/, 'the facade key row is materialized into the patch (J1-04)')
  assert.match(patch, /test-key/, 'the endpoint key is what lands in the patch row')
  assert.equal(calls.restart, 1, 'restart once alignment finishes')
})

test('P1 regression: the profile directory resolves from --profile in spawn.args (the endpoint id is not the profile name, hit for real in production)', async () => {
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
    async () => undefined, // fake installer: no network
  )

  const res = await app.inject({ method: 'POST', url: '/api/nodes/A/version', payload: { dsh_version: '0.1.5-rc.2' } })
  assert.equal(res.statusCode, 202, JSON.stringify(res.body))
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.equal(existsSync(join(dshHome, 'profiles', 'A')), false, 'must not create a ghost profile directory from the endpoint id')
  const realPkg = JSON.parse(readFileSync(join(realDir, 'package.json'), 'utf8'))
  assert.equal(realPkg.dependencies?.['@deepseek-ai/dsh'], '0.1.5-rc.2', 'the real profile (the name given to --profile) is reseeded')
  assert.equal(readFileSync(join(realDir, '.seed-version'), 'utf8').trim().length, 40, 'the seed of the real directory is rewritten')
})

test('P1 regression: POST /api/nodes/:id/version on the container branch -- the image tag written to disk, an immediate rebuild, and the audit', async () => {
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
  assert.equal((config.endpoints['A']?.spawn as unknown as { docker: { image: string } } | null)?.docker.image, 'hellodac/dac-node:0.1.5-rc.2', 'the image tag hot-loads into memory')
  assert.match(readFileSync(configPath, 'utf8'), /image: hellodac\/dac-node:0.1.5-rc.2/, 'the image tag is written to the source of truth')
  assert.equal(calls.restart, 1, 'rebuild immediately (without waiting for the reconcile cycle)')
  assert.ok(audits.includes('node_version_change'))
})

test('Debt P1 regression: POST /api/nodes/:id/access writes the source of truth and hot-loads it; clear removes it; an invalid value is 400', async () => {
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
  assert.deepEqual(config.endpoints['A']?.access, { sshUser: 'ubuntu', sshHost: '10.0.0.5', sshPort: 22, guiPort: 3080, localPort: 3088, sshKey: 'C:\\Users\\you\\.ssh\\id_ed25519' }, 'hot-loaded into memory')
  assert.match(readFileSync(configPath, 'utf8'), /access:/, 'written to the source of truth')
  assert.match(readFileSync(configPath, 'utf8'), /ssh_key/, 'the private key path is written, not the key content')
  assert.ok(audits.includes('node_access_update'), 'the audit leaves a trail')

  const clear = await app.inject({ method: 'POST', url: '/api/nodes/A/access', payload: { clear: true } })
  assert.equal(clear.statusCode, 200)
  assert.equal(config.endpoints['A']?.access, null)
  assert.doesNotMatch(readFileSync(configPath, 'utf8'), /access:/)

  const bad = await app.inject({ method: 'POST', url: '/api/nodes/A/access', payload: { ssh_user: 'u', ssh_host: 'h' } })
  assert.equal(bad.statusCode, 400)

  const missing = await app.inject({ method: 'POST', url: '/api/nodes/nope/access', payload: { ssh_user: 'u', ssh_host: 'h', local_port: 1 } })
  assert.equal(missing.statusCode, 404)
})

test('Debt P1 regression: GET /api/nodes carries access + guiUrl (the token is captured from the log on the spot, and a restart rotation is followed automatically)', async () => {
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
  assert.deepEqual(payload.supportedDsh.map((p) => p.dsh), ['0.1.2-rc.1', '0.1.5-rc.2', '0.2.0-rc.2'], 'the wizard version dropdown reads the matrix')
  assert.deepEqual(payload.supportedDsh.map((p) => p.status), ['verified', 'verified', 'pending'], 'the dropdown carries the row status (a pending row warns in yellow text at provision)')

  // Restart rotation: a new token line shows up in the log -> guiUrl follows automatically
  supervisor.logs = () => 'dsh web: http://127.0.0.1:3080/?token=tok-old\nrestarted\ndsh web: http://127.0.0.1:3080/?token=tok-new\n'
  const after = await app.inject({ method: 'GET', url: '/api/nodes' })
  assert.equal((after.json() as { nodes: Array<{ guiUrl: string | null }> }).nodes[0]?.guiUrl, 'http://127.0.0.1:3088/?token=tok-new')

  // A non-loopback node with no access configured: access=null and guiUrl=null (there is no way to open it)
  config.endpoints['A']!.access = null
  config.endpoints['A']!.url = 'http://10.0.0.5:3080'
  const bare = await app.inject({ method: 'GET', url: '/api/nodes' })
  const bareNode = (bare.json() as { nodes: Array<{ access: unknown; guiUrl: string | null }> }).nodes[0]
  assert.equal(bareNode?.access, null)
  assert.equal(bareNode?.guiUrl, null)

  // Ease-of-use improvement: a local loopback node connects directly even without access -- guiUrl uses the real port from the startup line
  config.endpoints['A']!.url = 'http://127.0.0.1:3081'
  const direct = await app.inject({ method: 'GET', url: '/api/nodes' })
  const directNode = (direct.json() as { nodes: Array<{ access: unknown; guiUrl: string | null }> }).nodes[0]
  assert.equal(directNode?.access, null)
  assert.equal(directNode?.guiUrl, 'http://127.0.0.1:3080/?token=tok-new', 'direct connect uses the port from the log (3080), not the configured port (3081)')
})
