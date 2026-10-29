import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import type { AppConfig, ResolvedEndpoint, ResolvedSpawnSpec } from '../config.js'
import { DEFAULT_PRICING } from '../pricing.js'
// The gateway driver is retired: endpoint probes now go through the SessionDriver port
// (probeVersion -> host.describe), driven here by the scripted in-memory fake -- no HTTP server needed.
import { FakeSessionDriver } from '../session-driver/fake.js'
import type { SessionDriver } from '../session-driver/port.js'
import { NodeSupervisor } from '../nodes/supervisor.js'
// Debt C3: agent construction consolidates into the test harness.
import { agentWith } from '../test-harness.js'
import { registerNodesRoutes } from './nodes.js'

/** The endpoint fixture: an apiproxy driver on a loopback URL (probes never touch HTTP any more). */
const endpointFixture = (): ResolvedEndpoint => ({
  id: 'A',
  url: 'http://127.0.0.1:3080',
  driver: 'apiproxy',
  prefix: '/api',
  key: 'test-key',
  sandboxBase: null,
  sandboxKey: '',
  spawn: null,
  access: null,
})

/**
 * One config with a single endpoint A and one agent on it. The endpoint object is returned
 * alongside the config so tests can mutate it (spawn/access/url) without non-null assertions.
 */
const configFor = (): { config: AppConfig; ep: ResolvedEndpoint } => {
  const ep = endpointFixture()
  const config: AppConfig = {
    listen: { host: '127.0.0.1', port: 0 },
    endpoints: { A: ep },
    agents: { personal: agentWith({ id: 'personal', name: 'Personal', workspacePath: '.' }) },
    runner: { timeoutMs: 1_000, silenceMs: 0, maxConsecutiveFailures: 3, dailyBudgetMicroUsd: null },
    databasePath: ':memory:',
    pricing: DEFAULT_PRICING,
    sessionSecret: 'x'.repeat(32),
    initialUser: { username: 'admin', password: null },
    warnings: [],
  }
  return { config, ep }
}

/** A reachable upstream for endpoint A: probeVersion answers with the node's DSH version. */
const liveUpstreams = (version = '0.2.0-rc.2'): Map<string, SessionDriver> =>
  new Map<string, SessionDriver>([['A', new FakeSessionDriver('A', { frames: [], probeVersion: version })]])

/** An unreachable upstream for endpoint A: probeVersion throws the way a dead node does. */
const deadUpstreams = (): Map<string, SessionDriver> =>
  new Map<string, SessionDriver>([['A', new FakeSessionDriver('A', { frames: [], probeVersion: null })]])

test('an unmanaged node reports the probe result as its state', async () => {
  const { config } = configFor()
  const app = Fastify()
  registerNodesRoutes(app, config, new Map<string, NodeSupervisor>(), liveUpstreams(), async () => {})

  const res = await app.inject({ method: 'GET', url: '/api/nodes' })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.nodes.length, 1)
  assert.equal(body.nodes[0]?.id, 'A')
  assert.equal(body.nodes[0]?.managed, false)
  assert.equal(body.nodes[0]?.state, 'live')
  assert.deepEqual(body.nodes[0]?.agents, ['personal'])
  // Hive plan 2 P1: the probe now goes through the SessionDriver port (probeVersion -> host.describe),
  // so a live node's row carries the real DSH version and the matrix verdict.
  assert.equal(body.nodes[0]?.dshVersion, '0.2.0-rc.2')
  assert.equal(body.nodes[0]?.dshCompatible, true)
  // The legacy gateway-health surface died with the gateway driver: the port probe reports no session count.
  assert.equal(body.nodes[0]?.sessions, null)
  // UI wrap-up C-P1.5: local platform information (the data source of the topology's local card)
  assert.equal(typeof body.hostOs, 'string', 'hostOs must come back with /api/nodes')
  assert.equal(typeof body.hostArch, 'string', 'hostArch must come back with /api/nodes')
  // UI wrap-up C-P1.5: the data source of the local row (the hostname and node version on the first row of the machine list)
  assert.equal(typeof body.hostName, 'string', 'hostName must come back with /api/nodes')
  assert.equal(typeof body.hostNodeVersion, 'string', 'hostNodeVersion must come back with /api/nodes')
  await app.close()
})

test('a managed node reports the supervisor state machine', async () => {
  const { config } = configFor()
  const app = Fastify()
  const supervisors = new Map([
    ['A', new NodeSupervisor('A', { probe: async () => ({ ok: true, detail: '' }) })],
  ])
  registerNodesRoutes(app, config, supervisors, new Map<string, SessionDriver>(), async () => {})

  const res = await app.inject({ method: 'GET', url: '/api/nodes' })
  const body = res.json()
  assert.equal(body.nodes[0]?.managed, true)
  assert.equal(body.nodes[0]?.state, 'cold')
  assert.equal(body.nodes[0]?.pid, null)
  await app.close()
})

test('an unreachable unmanaged node reports offline with the reason', async () => {
  const { config } = configFor()
  const app = Fastify()
  registerNodesRoutes(app, config, new Map<string, NodeSupervisor>(), deadUpstreams(), async () => {})

  const res = await app.inject({ method: 'GET', url: '/api/nodes' })
  const body = res.json()
  assert.equal(body.nodes[0]?.state, 'offline')
  // probeVersion threw (the fake's unreachable error), so its message surfaces as the offline reason.
  assert.ok((body.nodes[0]?.lastError ?? '').length > 0)
  assert.match(String(body.nodes[0]?.lastError ?? ''), /unreachable/)
  await app.close()
})

// ---- Hive P5.1: node control ----

const managedSpawn: ResolvedSpawnSpec = {
  managed: true,
  command: 'node',
  args: ['--version'],
  cwd: null,
  readyTimeoutMs: 30_000,
  detached: false,
  logFile: null,
  env: {},
  restart: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 },
  runner: 'process',
  host: null,
  docker: null,
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
  const { config, ep } = configFor()
  ep.spawn = managedSpawn
  const calls = { start: 0, stop: 0, restart: 0 }
  const app = Fastify()
  registerNodesRoutes(app, config, new Map([['A', stubSupervisor(calls)]]), new Map<string, SessionDriver>(), async () => {})

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
  await app.close()
})

test('Hive P5.1: unmanaged nodes get a friendly 409, unknown nodes a 404', async () => {
  const { config } = configFor()
  const app = Fastify()
  registerNodesRoutes(app, config, new Map<string, NodeSupervisor>(), new Map<string, SessionDriver>(), async () => {})

  const up = await app.inject({ method: 'POST', url: '/api/nodes/A/up' })
  assert.equal(up.statusCode, 409)
  assert.match(String((up.json()).detail), /managed outside the manager/)

  const logs = await app.inject({ method: 'GET', url: '/api/nodes/A/logs' })
  assert.equal(logs.statusCode, 409)

  const missing = await app.inject({ method: 'POST', url: '/api/nodes/nope/down' })
  assert.equal(missing.statusCode, 404)
  await app.close()
})

test('Hive plan 2 P2b: a docker runner node serves its logs through docker logs', async () => {
  const { config, ep } = configFor()
  const dockerSpawn: ResolvedSpawnSpec = {
    ...managedSpawn,
    runner: 'docker',
    docker: { image: 'hellodac/dac-node:0.1.1-rc.2', containerName: null, network: 'hive', port: 3081, hostVolumes: {}, namedVolumes: {}, memoryLimitMb: null },
  }
  ep.spawn = dockerSpawn
  const calls = { start: 0, stop: 0, restart: 0 }
  const supervisor = stubSupervisor(calls) as unknown as NodeSupervisor & { dockerLogs: () => Promise<string | null> }
  supervisor.dockerLogs = async () => 'container-log\n'
  const app = Fastify()
  registerNodesRoutes(app, config, new Map([['A', supervisor]]), new Map<string, SessionDriver>(), async () => {})

  const logs = await app.inject({ method: 'GET', url: '/api/nodes/A/logs' })
  assert.equal(logs.statusCode, 200)
  assert.equal((logs.json()).logs, 'container-log\n')
  assert.equal((logs.json()).source, 'docker')
  await app.close()
})

test('Debt P3 regression: process node drift detection plus align-version alignment (reseed/reinstall/restart, idempotent)', async () => {
  const { config, ep } = configFor()
  const profileDir = mkdtempSync(join(tmpdir(), 'nodes-align-'))
  // The profile directory = DSH_HOME/profiles/<endpoint id> (the base fixture has no --profile arg)
  ep.spawn = { ...managedSpawn, env: { DSH_HOME: join(profileDir, '..') } }
  mkdirSync(join(profileDir, '..', 'profiles', 'A'), { recursive: true })
  writeFileSync(join(profileDir, '..', 'profiles', 'A', '.seed-version'), 'stale-seed\n', 'utf8')
  const calls = { start: 0, stop: 0, restart: 0 }
  const app = Fastify()
  registerNodesRoutes(
    app, config, new Map([['A', stubSupervisor(calls)]]), new Map<string, SessionDriver>(), async () => {},
    undefined,
    async (dir) => {
      // Fake installer: no network -- writing a fake bin inside the profile counts as installed
      const binDir = join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib')
      mkdirSync(binDir, { recursive: true })
      writeFileSync(join(binDir, 'bin.js'), '', 'utf8')
    },
  )

  const before = await app.inject({ method: 'GET', url: '/api/nodes' })
  assert.equal((before.json()).nodes[0]?.dshDrift, true, 'the stale marker -> drift')

  const align = await app.inject({ method: 'POST', url: '/api/nodes/A/align-version' })
  assert.equal(align.statusCode, 202)
  await new Promise((resolve) => setTimeout(resolve, 20))

  const aligned = await app.inject({ method: 'GET', url: '/api/nodes' })
  assert.equal((aligned.json()).nodes[0]?.dshDrift, false, 'the drift is gone after alignment')
  assert.equal(calls.restart, 1, 'restart the node once alignment finishes')
  const marker = readFileSync(join(profileDir, '..', 'profiles', 'A', '.seed-version'), 'utf8').trim()
  assert.equal(marker.length, 40, 'the marker is rewritten to a sha1')
  await app.close()
})

test('P1 regression: POST /api/nodes/:id/version on the process branch -- pinning written to disk, the alignment chain, the audit, and 400 for an unknown version', async () => {
  const { config, ep } = configFor()
  const dir = mkdtempSync(join(tmpdir(), 'nodes-version-'))
  const configPath = join(dir, 'manager.config.yaml')
  writeFileSync(configPath, 'endpoints:\n  A:\n    url: http://x\n', 'utf8')
  config.configPath = configPath
  const profileRoot = mkdtempSync(join(tmpdir(), 'nodes-vprof-'))
  ep.spawn = { ...managedSpawn, env: { DSH_HOME: join(profileRoot, '..') } }
  mkdirSync(join(profileRoot, '..', 'profiles', 'A'), { recursive: true })
  const calls = { start: 0, stop: 0, restart: 0 }
  const audits: string[] = []
  const app = Fastify()
  registerNodesRoutes(
    app, config, new Map([['A', stubSupervisor(calls)]]), new Map<string, SessionDriver>(), async () => {},
    (_actor, kind) => audits.push(kind),
    async (installDir) => {
      const binDir = join(installDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib')
      mkdirSync(binDir, { recursive: true })
      writeFileSync(join(binDir, 'bin.js'), '', 'utf8')
    },
  )

  const res = await app.inject({ method: 'POST', url: '/api/nodes/A/version', payload: { dsh_version: '0.1.5-rc.2' } })
  assert.equal(res.statusCode, 202, JSON.stringify(res.body))
  assert.equal((res.json()).version, '0.1.5-rc.2')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(ep.spawn?.dshVersion, '0.1.5-rc.2', 'the pin hot-loads into memory')
  assert.match(readFileSync(configPath, 'utf8'), /dsh_version: 0.1.5-rc.2/, 'the explicit pin is written to the source of truth')
  assert.ok(audits.includes('node_version_change'), 'the audit records node_version_change')
  assert.equal(calls.restart, 1, 'restart once alignment finishes')

  const bad = await app.inject({ method: 'POST', url: '/api/nodes/A/version', payload: { dsh_version: '0.9.9' } })
  assert.equal(bad.statusCode, 400)
  assert.equal((bad.json()).error, 'unknown_dsh_version')
  await app.close()
})

test('0.2.0 corridor: switching a process node to 0.2.0-rc.2 writes the PAIRED facade ref to the truth source and materializes the patch key row (settings.yaml is dead on the new lines)', async () => {
  const { config, ep } = configFor()
  const dir = mkdtempSync(join(tmpdir(), 'nodes-v020-'))
  const configPath = join(dir, 'manager.config.yaml')
  writeFileSync(configPath, 'endpoints:\n  A:\n    url: http://x\n', 'utf8')
  config.configPath = configPath
  const dshHome = mkdtempSync(join(tmpdir(), 'nodes-v020home-'))
  ep.spawn = {
    ...managedSpawn,
    env: { DSH_HOME: dshHome },
    // A stale explicit ref from the legacy era: the switch must overwrite it with the paired row ref
    // (a stale b592b4f on a 0.2.0 node = the answerer pump dies silently, dsh-facts §18.2)
    dshVersion: '0.1.5-rc.2',
    gatewayRef: 'github:litestartup-com/dsh-api-gateway#b592b4f',
  }
  const profileDir = join(dshHome, 'profiles', 'A')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), '{"dependencies":{}}', 'utf8')
  const calls = { start: 0, stop: 0, restart: 0 }
  const app = Fastify()
  registerNodesRoutes(
    app, config, new Map([['A', stubSupervisor(calls)]]), new Map<string, SessionDriver>(), async () => {},
    undefined,
    async () => undefined, // fake installer: no network
  )

  const res = await app.inject({ method: 'POST', url: '/api/nodes/A/version', payload: { dsh_version: '0.2.0-rc.2' } })
  assert.equal(res.statusCode, 202, JSON.stringify(res.body))
  await new Promise((resolve) => setTimeout(resolve, 20))

  const yaml = readFileSync(configPath, 'utf8')
  assert.match(yaml, /dsh_version: 0\.2\.0-rc\.2/, 'the version pin lands in the truth source')
  assert.match(yaml, /gateway_ref: github:litestartup-com\/dsh-api-gateway#398ea94/, 'the paired facade ref lands WITH it (writing the version alone leaves the stale ref in charge)')
  assert.equal(ep.spawn?.gatewayRef, 'github:litestartup-com/dsh-api-gateway#398ea94', 'the in-memory spawn hot-loads the new ref too (a later align-version must not read the stale one)')

  // The reseed produced the 0.2.0-gated profile shape and the key moved into the patch (J1-04):
  // the endpoint key is the truth, settings.yaml is never consulted on this line.
  const pkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>
    dsh: { profile: { patchReload?: unknown } }
  }
  assert.equal(pkg.dependencies['ohdsh-api-facade'], 'github:litestartup-com/dsh-api-gateway#398ea94')
  assert.ok(pkg.dsh.profile.patchReload === undefined, 'no patchReload on the new lines (J1-15)')
  const patch = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /session-log-deepseek/, 'the privacy row is baked (J1-22: the session-log upload defaults ON from the corridor)')
  assert.match(patch, /ohdsh-api-facade/, 'the facade key row is materialized into the patch (J1-04)')
  assert.match(patch, /test-key/, 'the endpoint key is what lands in the patch row')
  assert.equal(calls.restart, 1, 'restart once alignment finishes')
  await app.close()
})

test('0.2.0 corridor: POST /api/nodes/:id/version on the AGENT branch -- paired pins written, supervisor restarted (the align chain is process-only; an agent re-materializes its profile from the payload)', async () => {
  const { config, ep } = configFor()
  const dir = mkdtempSync(join(tmpdir(), 'nodes-vagent-'))
  const configPath = join(dir, 'manager.config.yaml')
  writeFileSync(configPath, 'endpoints:\n  A:\n    url: http://x\n', 'utf8')
  config.configPath = configPath
  ep.spawn = {
    ...managedSpawn,
    runner: 'agent',
    host: 'agent-1',
    args: ['--profile', 'A', '--port', '3201'],
    dshVersion: '0.1.5-rc.2',
    gatewayRef: 'github:litestartup-com/dsh-api-gateway#b592b4f',
  }
  const calls = { start: 0, stop: 0, restart: 0 }
  const app = Fastify()
  registerNodesRoutes(app, config, new Map([['A', stubSupervisor(calls)]]), new Map<string, SessionDriver>(), async () => {})

  const res = await app.inject({ method: 'POST', url: '/api/nodes/A/version', payload: { dsh_version: '0.2.0-rc.2' } })
  assert.equal(res.statusCode, 202, JSON.stringify(res.body))
  const body = res.json()
  assert.equal(body.switching, true)
  assert.equal(body.version, '0.2.0-rc.2')
  const yaml = readFileSync(configPath, 'utf8')
  assert.match(yaml, /dsh_version: 0\.2\.0-rc\.2/, 'the pin lands in the truth source')
  assert.match(yaml, /gateway_ref: github:litestartup-com\/dsh-api-gateway#398ea94/, 'paired with the matrix row facade ref')
  assert.equal(calls.restart, 1, 'the restart rebuilds the spawn payload at the new pin -- the agent reinstalls the profile from it')
  await app.close()
})

test('P1 regression: the profile directory resolves from --profile in spawn.args (the endpoint id is not the profile name, hit for real in production)', async () => {
  const { config, ep } = configFor()
  const dir = mkdtempSync(join(tmpdir(), 'nodes-vprofile-'))
  const configPath = join(dir, 'manager.config.yaml')
  writeFileSync(configPath, 'endpoints:\n  A:\n    url: http://x\n', 'utf8')
  config.configPath = configPath
  const dshHome = mkdtempSync(join(tmpdir(), 'nodes-vhome-'))
  ep.spawn = {
    ...managedSpawn,
    args: ['bin.js', '--profile', 'real-prof'],
    env: { DSH_HOME: dshHome },
  }
  const realDir = join(dshHome, 'profiles', 'real-prof')
  mkdirSync(realDir, { recursive: true })
  writeFileSync(join(realDir, '.seedversion'), 'stale\n', 'utf8')
  writeFileSync(join(realDir, 'package.json'), '{"dependencies":{}}', 'utf8')
  const calls = { start: 0, stop: 0, restart: 0 }
  const app = Fastify()
  registerNodesRoutes(
    app, config, new Map([['A', stubSupervisor(calls)]]), new Map<string, SessionDriver>(), async () => {},
    undefined,
    async () => undefined, // fake installer: no network
  )

  const res = await app.inject({ method: 'POST', url: '/api/nodes/A/version', payload: { dsh_version: '0.1.5-rc.2' } })
  assert.equal(res.statusCode, 202, JSON.stringify(res.body))
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.equal(existsSync(join(dshHome, 'profiles', 'A')), false, 'must not create a ghost profile directory from the endpoint id')
  const realPkg = JSON.parse(readFileSync(join(realDir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
  assert.equal(realPkg.dependencies?.['@deepseek-ai/dsh'], '0.1.5-rc.2', 'the real profile (the name given to --profile) is reseeded')
  assert.equal(readFileSync(join(realDir, '.seed-version'), 'utf8').trim().length, 40, 'the seed of the real directory is rewritten')
  await app.close()
})

test('P1 regression: POST /api/nodes/:id/version on the container branch -- the image tag written to disk, an immediate rebuild, and the audit', async () => {
  const { config, ep } = configFor()
  const dir = mkdtempSync(join(tmpdir(), 'nodes-vdocker-'))
  const configPath = join(dir, 'manager.config.yaml')
  writeFileSync(configPath, 'endpoints:\n  A:\n    url: http://x\n', 'utf8')
  config.configPath = configPath
  ep.spawn = {
    ...managedSpawn,
    runner: 'docker',
    docker: { image: 'hellodac/dac-node:0.1.2-rc.1', containerName: null, network: 'dac-hive', port: 3081, hostVolumes: {}, namedVolumes: {}, memoryLimitMb: null },
  }
  const calls = { start: 0, stop: 0, restart: 0 }
  const audits: string[] = []
  const app = Fastify()
  registerNodesRoutes(
    app, config, new Map([['A', stubSupervisor(calls)]]), new Map<string, SessionDriver>(), async () => {},
    (_actor, kind) => audits.push(kind),
  )

  const res = await app.inject({ method: 'POST', url: '/api/nodes/A/version', payload: { dsh_version: '0.1.5-rc.2' } })
  assert.equal(res.statusCode, 202, JSON.stringify(res.body))
  assert.equal((res.json()).image, 'hellodac/dac-node:0.1.5-rc.2')
  assert.equal(ep.spawn?.docker?.image, 'hellodac/dac-node:0.1.5-rc.2', 'the image tag hot-loads into memory')
  assert.match(readFileSync(configPath, 'utf8'), /image: hellodac\/dac-node:0.1.5-rc.2/, 'the image tag is written to the source of truth')
  assert.equal(calls.restart, 1, 'rebuild immediately (without waiting for the reconcile cycle)')
  assert.ok(audits.includes('node_version_change'))
  await app.close()
})

test('Debt P1 regression: POST /api/nodes/:id/access writes the source of truth and hot-loads it; clear removes it; an invalid value is 400', async () => {
  const { config, ep } = configFor()
  const dir = mkdtempSync(join(tmpdir(), 'nodes-access-'))
  const configPath = join(dir, 'manager.config.yaml')
  writeFileSync(configPath, 'endpoints:\n  A:\n    url: http://x\n', 'utf8')
  config.configPath = configPath
  const audits: string[] = []
  const app = Fastify()
  registerNodesRoutes(
    app, config, new Map<string, NodeSupervisor>(), new Map<string, SessionDriver>(), async () => {},
    (_actor, kind) => audits.push(kind),
  )

  const set = await app.inject({
    method: 'POST',
    url: '/api/nodes/A/access',
    payload: { ssh_user: 'ubuntu', ssh_host: '10.0.0.5', local_port: 3088, ssh_key: 'C:\\Users\\you\\.ssh\\id_ed25519' },
  })
  assert.equal(set.statusCode, 200)
  assert.deepEqual(ep.access, { sshUser: 'ubuntu', sshHost: '10.0.0.5', sshPort: 22, guiPort: 3080, localPort: 3088, sshKey: 'C:\\Users\\you\\.ssh\\id_ed25519' }, 'hot-loaded into memory')
  assert.match(readFileSync(configPath, 'utf8'), /access:/, 'written to the source of truth')
  assert.match(readFileSync(configPath, 'utf8'), /ssh_key/, 'the private key path is written, not the key content')
  assert.ok(audits.includes('node_access_update'), 'the audit leaves a trail')

  const clear = await app.inject({ method: 'POST', url: '/api/nodes/A/access', payload: { clear: true } })
  assert.equal(clear.statusCode, 200)
  assert.equal(ep.access, null)
  assert.doesNotMatch(readFileSync(configPath, 'utf8'), /access:/)

  const bad = await app.inject({ method: 'POST', url: '/api/nodes/A/access', payload: { ssh_user: 'u', ssh_host: 'h' } })
  assert.equal(bad.statusCode, 400)

  const missing = await app.inject({ method: 'POST', url: '/api/nodes/nope/access', payload: { ssh_user: 'u', ssh_host: 'h', local_port: 1 } })
  assert.equal(missing.statusCode, 404)
  await app.close()
})

test('Debt P1 regression: GET /api/nodes carries access + guiUrl (the token is captured from the log on the spot, and a restart rotation is followed automatically)', async () => {
  const { config, ep } = configFor()
  ep.access = { sshUser: 'ubuntu', sshHost: '10.0.0.5', sshPort: 22, guiPort: 3080, localPort: 3088, sshKey: null }
  ep.spawn = managedSpawn
  const app = Fastify()
  const supervisor = stubSupervisor({ start: 0, stop: 0, restart: 0 }) as unknown as NodeSupervisor & { logs: () => string }
  supervisor.logs = () => 'dsh web: http://127.0.0.1:3080/?token=tok-abc\n'
  registerNodesRoutes(app, config, new Map([['A', supervisor]]), new Map<string, SessionDriver>(), async () => {})

  const res = await app.inject({ method: 'GET', url: '/api/nodes' })
  assert.equal(res.statusCode, 200)
  const payload = res.json()
  const node = payload.nodes[0]
  assert.deepEqual(node?.access, { sshUser: 'ubuntu', sshHost: '10.0.0.5', sshPort: 22, guiPort: 3080, localPort: 3088, sshKey: null })
  assert.equal(node?.guiUrl, 'http://127.0.0.1:3088/?token=tok-abc')
  assert.deepEqual(payload.supportedDsh.map((p: { dsh: string }) => p.dsh), ['0.2.0-rc.2', '0.1.5-rc.2', '0.1.2-rc.1'], 'the wizard version dropdown reads the matrix (the default line leads)')
  assert.deepEqual(payload.supportedDsh.map((p: { status: string }) => p.status), ['verified', 'verified', 'verified'], 'all three rows verified (the pending yellow-text path is covered through the injection seam)')

  // Restart rotation: a new token line shows up in the log -> guiUrl follows automatically
  supervisor.logs = () => 'dsh web: http://127.0.0.1:3080/?token=tok-old\nrestarted\ndsh web: http://127.0.0.1:3080/?token=tok-new\n'
  const rotated = await app.inject({ method: 'GET', url: '/api/nodes' })
  assert.equal((rotated.json()).nodes[0]?.guiUrl, 'http://127.0.0.1:3088/?token=tok-new')

  // A non-loopback node with no access configured: access=null and guiUrl=null (there is no way to open it)
  ep.access = null
  ep.url = 'http://10.0.0.5:3080'
  const bare = await app.inject({ method: 'GET', url: '/api/nodes' })
  const bareNode = (bare.json()).nodes[0]
  assert.equal(bareNode?.access, null)
  assert.equal(bareNode?.guiUrl, null)

  // Ease-of-use improvement: a local loopback node connects directly even without access -- guiUrl uses the real port from the startup line
  ep.url = 'http://127.0.0.1:3081'
  const direct = await app.inject({ method: 'GET', url: '/api/nodes' })
  const directNode = (direct.json()).nodes[0]
  assert.equal(directNode?.access, null)
  assert.equal(directNode?.guiUrl, 'http://127.0.0.1:3080/?token=tok-new', 'direct connect uses the port from the log (3080), not the configured port (3081)')
  await app.close()
})
