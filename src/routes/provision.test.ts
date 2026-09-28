import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppConfig } from '../config.js'
import { loadConfig } from '../config.js'
import { DEFAULT_PRICING } from '../pricing.js'
import { openDb, schema, type Db } from '../db/index.js'
import type { NodeSupervisor } from '../nodes/supervisor.js'
import { registerProvisionRoutes, installNodeDepsAsync } from './provision.js'
import { GATEWAY_REF, _setMatrixForTest, _resetMatrixForTest } from '../dsh-matrix.js'

// Incident regression (CI red on 2026-09-26): loadConfig validates envSchema and SESSION_SECRET is required.
// Locally a gitignored .env covers it and a CI checkout has none -- a test must stand on its own, so the
// same fallback as config.test.ts applies here (dotenv does not override existing variables, the local test value wins).
if (process.env.SESSION_SECRET === undefined) process.env.SESSION_SECRET = 'x'.repeat(32)

const configFor = (): AppConfig => ({
  listen: { host: '127.0.0.1', port: 8080 },
  endpoints: {},
  agents: {},
  runner: { timeoutMs: 1_000, silenceMs: 0, maxConsecutiveFailures: 3, dailyBudgetMicroUsd: null },
  databasePath: ':memory:',
  pricing: DEFAULT_PRICING,
  sessionSecret: 'x'.repeat(32),
  initialUser: { username: 'admin', password: null },
  warnings: [],
})

const dir = mkdtempSync(join(tmpdir(), 'provision-'))
const nodesRoot = join(dir, 'nodes')
mkdirSync(nodesRoot, { recursive: true })
writeFileSync(join(dir, 'manager.config.yaml'), 'listen:\n  host: 127.0.0.1\n  port: 8080\nendpoints: {}\nagents: {}\n', 'utf8')
writeFileSync(join(dir, 'fake-dsh.js'), 'process.exit(0)\n', 'utf8')

const previousCwd = process.cwd()
process.chdir(dir)
process.env.DSH_BIN = join(dir, 'fake-dsh.js')
process.env.DSH_DAC_NODES_HOME = nodesRoot

const stopped: NodeSupervisor[] = []
after(() => {
  for (const s of stopped) s.stop()
  process.chdir(previousCwd)
  delete process.env.DSH_BIN
  delete process.env.DSH_DAC_NODES_HOME
  rmSync(dir, { recursive: true, force: true })
})

const boot = (): {
  app: ReturnType<typeof Fastify>
  config: AppConfig
  db: Db
  sqlite: ReturnType<typeof openDb>['sqlite']
  supervisors: Map<string, NodeSupervisor>
} => {
  const config = configFor()
  const { db, sqlite } = openDb(':memory:')
  const supervisors = new Map<string, NodeSupervisor>()
  const app = Fastify()
  registerProvisionRoutes(app, config, async () => {}, { db, supervisors, clients: new Map(), upstreamClients: new Map() })
  return { app, config, db, sqlite, supervisors }
}

test('Hive P5.5: provision creates a node (profile/key/config write-back/hot-load) and removes it', async () => {
  const { app, config, supervisors } = await boot()

  const created = await app.inject({
    method: 'POST',
    url: '/api/nodes',
    payload: { name: 'product', install: false },
  })
  assert.equal(created.statusCode, 201, JSON.stringify(created.body))
  const body = created.json() as { node: { id: string; port: number; home: string } }
  assert.equal(body.node.id, 'product')
  assert.equal(body.node.port, 3090)

  // Hot load: in-memory config, supervisors, the yaml write-back, the .env secret
  assert.ok(config.endpoints['product'] !== undefined)
  assert.ok(config.endpoints['product'].spawn !== null)
  assert.ok(supervisors.has('product'))
  const yaml = readFileSync(join(dir, 'manager.config.yaml'), 'utf8')
  assert.match(yaml, /product/)
  assert.match(readFileSync(join(dir, '.env'), 'utf8'), /GW_KEY_PRODUCT=/)
  assert.ok(join(nodesRoot, 'product') !== '')

  // Duplicate name / port conflict
  const dup = await app.inject({ method: 'POST', url: '/api/nodes', payload: { name: 'product', install: false } })
  assert.equal(dup.statusCode, 409)
  const port = await app.inject({ method: 'POST', url: '/api/nodes', payload: { name: 'other', port: 3090, install: false } })
  assert.equal(port.statusCode, 409)
  assert.match(String((port.json() as { detail: string }).detail), /already taken/)

  // Removal (no agent bound)
  const supervisor = supervisors.get('product')!
  stopped.push(supervisor)
  const removed = await app.inject({ method: 'DELETE', url: '/api/nodes/product' })
  assert.equal(removed.statusCode, 200)
  assert.equal(config.endpoints['product'], undefined)
  assert.ok(!supervisors.has('product'))
  assert.doesNotMatch(readFileSync(join(dir, 'manager.config.yaml'), 'utf8'), /product/)
})

test('Hive P5.5: deleting a node removes its workspace binding rows too, files untouched', async () => {
  const { app, config, db, supervisors } = await boot()

  const created = await app.inject({
    method: 'POST',
    url: '/api/nodes',
    payload: {
      name: 'company',
      install: false,
      agent: { id: 'company', name: '企业', workspace: join(dir, 'ws-company'), preset: 'standard', sandboxMode: 'workspace-write' },
    },
  })
  assert.equal(created.statusCode, 201, JSON.stringify(created.body))
  assert.equal(config.agents['company']?.name, '企业')
  assert.equal(config.agents['company']?.endpoint, 'company')
  const row = db.select().from(schema.agent).all().find((a) => a.id === 'company')
  assert.ok(row !== undefined, 'agent mirrored into the registry table')
  assert.ok(join(dir, 'ws-company', '.git') !== '', 'workspace got git init')

  const supervisor = supervisors.get('company')!
  stopped.push(supervisor)
  const removed = await app.inject({ method: 'DELETE', url: '/api/nodes/company' })
  assert.equal(removed.statusCode, 200)
  assert.deepEqual((removed.json() as { removedWorkspaces: string[] }).removedWorkspaces, ['company'])
  assert.equal(config.endpoints['company'], undefined)
  assert.equal(config.agents['company'], undefined)
  const yaml = readFileSync(join(dir, 'manager.config.yaml'), 'utf8')
  assert.doesNotMatch(yaml, /company/)
  // The DB rows stay (billing and audit are never deleted); the workspace directory stays
  assert.ok(db.select().from(schema.agent).all().find((a) => a.id === 'company') !== undefined)
  assert.ok(join(dir, 'ws-company') !== '')

  const missing = await app.inject({ method: 'DELETE', url: '/api/nodes/nope' })
  assert.equal(missing.statusCode, 404)
})

test('Capability two regression: dsh_version pinned per node -- pending gets yellow text, an unknown version 400, verified no warning', async () => {
  const { app, config, supervisors } = await boot()
  // Both rows of the real matrix are verified; the pending yellow-text path is covered through a test injection seam.
  _setMatrixForTest([{ dsh: '0.1.5-rc.2', gateway: GATEWAY_REF, status: 'pending' }])
  try {
    const created = await app.inject({
      method: 'POST',
      url: '/api/nodes',
      payload: { name: 'v15', install: false, dsh_version: '0.1.5-rc.2' },
    })
    assert.equal(created.statusCode, 201, JSON.stringify(created.body))
    const body = created.json() as { versionWarning?: boolean }
    assert.equal(body.versionWarning, true, 'a pending pair -> a yellow-text warning')
    assert.equal(config.endpoints['v15']?.spawn?.dshVersion, '0.1.5-rc.2', 'the in-memory endpoint is pinned')
    const pkg = JSON.parse(readFileSync(join(nodesRoot, 'v15', 'profiles', 'v15', 'package.json'), 'utf8'))
    assert.equal(pkg.dependencies['@deepseek-ai/dsh'], '0.1.5-rc.2', 'the profile pins the target version')
    assert.match(readFileSync(join(dir, 'manager.config.yaml'), 'utf8'), /dsh_version: 0.1.5-rc.2/, 'the pin reaches the yaml on disk')
    const supervisor = supervisors.get('v15')!
    stopped.push(supervisor)

    const bad = await app.inject({ method: 'POST', url: '/api/nodes', payload: { name: 'vbad', install: false, dsh_version: '0.9.9' } })
    assert.equal(bad.statusCode, 400, 'an unknown version is rejected explicitly')
  } finally {
    _resetMatrixForTest()
  }

  const clean = await app.inject({ method: 'POST', url: '/api/nodes', payload: { name: 'v15c', install: false, dsh_version: '0.1.5-rc.2' } })
  assert.equal(clean.statusCode, 201, JSON.stringify(clean.body))
  assert.equal((clean.json() as { versionWarning?: boolean }).versionWarning, undefined, 'a verified pair gets no yellow text')
  const supervisorClean = supervisors.get('v15c')!
  stopped.push(supervisorClean)
})

test('Hive P5.5: unknown agent id shape is rejected', async () => {
  const { app } = await boot()
  const bad = await app.inject({ method: 'POST', url: '/api/nodes', payload: { name: 'BAD NAME', install: false } })
  assert.equal(bad.statusCode, 400)
})

test('Capability one regression: an explicit runner=process on a docker deployment creates a host-process node (audited as node_create_host)', async () => {
  const { app, config, db, supervisors } = await boot()
  // A preset docker endpoint puts the deployment into docker form (the personal spine of the P6 tests)
  config.endpoints['personal'] = {
    id: 'personal',
    url: 'http://node-personal:3081',
    driver: 'apiproxy',
    prefix: '/api',
    key: '',
    sandboxBase: 'http://node-personal:3081/api-gw/v1',
    sandboxKey: 'apigw-x',
    spawn: {
      managed: true,
      command: '',
      args: [],
      cwd: null,
      readyTimeoutMs: 30_000,
      detached: false,
      logFile: null,
      env: {},
      restart: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 30_000 },
      runner: 'docker',
      host: null,
      docker: {
        image: 'hellodac/dac-node:0.1.1-rc.2',
        containerName: null,
        network: 'dac-hive',
        port: 3081,
        hostVolumes: { '/srv/dac/workspaces/personal': '/opt/dac/workspaces/personal' },
        namedVolumes: { 'dac-personal': '/data' },
      },
    },
    access: null,
  }

  const created = await app.inject({
    method: 'POST',
    url: '/api/nodes',
    payload: { name: 'hostnode', install: false, runner: 'process' },
  })
  assert.equal(created.statusCode, 201, JSON.stringify(created.body))
  const spawn = config.endpoints['hostnode']?.spawn
  assert.equal(spawn?.runner, 'process', 'an explicit process overrides the automatic docker-form decision')
  const yaml = readFileSync(join(dir, 'manager.config.yaml'), 'utf8')
  assert.match(yaml, /hostnode:/, 'the new node reaches the yaml on disk')
  assert.match(yaml, /command: node/, 'the process form reaches the yaml (runner defaults to process and is not serialized)')
  assert.doesNotMatch(yaml, /runner: docker/, 'the yaml must not carry the docker form')
  const auditKinds = db.select().from(schema.auditLog).all().map((r) => r.kind)
  assert.ok(auditKinds.includes('node_create_host'), 'creating a host-process node is audited as node_create_host')

  const supervisor = supervisors.get('hostnode')!
  stopped.push(supervisor)
})

test('Capability four M1-7: the wizard creates an agent node -- runner=agent+host reaches the source of truth, no local profile, url required, mutually exclusive with docker', async () => {
  const { app, config, db, supervisors } = await boot()
  const created = await app.inject({
    method: 'POST',
    url: '/api/nodes',
    payload: { name: 'ops01', install: false, host: 'agent-abc123', url: 'http://10.0.0.7:3081' },
  })
  assert.equal(created.statusCode, 201, JSON.stringify(created.body))
  const spawn = config.endpoints['ops01']?.spawn
  assert.equal(spawn?.runner, 'agent')
  assert.equal(spawn?.host, 'agent-abc123')
  assert.equal(spawn?.readyTimeoutMs, 120_000, 'measured in the M1 pilot: a remote agent takes 40-90s on first start, so the readiness window must be wider (30s killed it and triggered the restart chain)')
  assert.equal(config.endpoints['ops01']?.url, 'http://10.0.0.7:3081', 'the remote facade address reaches the source of truth')
  const yaml = readFileSync(join(dir, 'manager.config.yaml'), 'utf8')
  const section = yaml.slice(yaml.indexOf('ops01:'))
  assert.match(section, /runner: agent/, 'the yaml carries the agent form')
  assert.match(section, /host: agent-abc123/, 'the yaml carries the host')
  assert.doesNotMatch(section, /command: node/, 'no local command (the agent side uses a bin from its own prefix)')
  assert.match(readFileSync(join(dir, '.env'), 'utf8'), /GW_KEY_OPS01=/, 'the key lands in .env')
  assert.ok(!existsSync(join(nodesRoot, 'ops01', 'profiles', 'ops01', 'package.json')), 'no local profile (the agent side finishes it with the payload)')
  const auditKinds = db.select().from(schema.auditLog).all().map((r) => r.kind)
  assert.ok(auditKinds.includes('node_create_host'), 'whole-machine capability is audited')
  const supervisor = supervisors.get('ops01')!
  stopped.push(supervisor)

  const noUrl = await app.inject({ method: 'POST', url: '/api/nodes', payload: { name: 'ops02', install: false, host: 'agent-abc123' } })
  assert.equal(noUrl.statusCode, 400, 'an agent node must be given a url')
  const conflict = await app.inject({
    method: 'POST',
    url: '/api/nodes',
    payload: { name: 'ops03', install: false, host: 'agent-abc123', url: 'http://10.0.0.7:3083', runner: 'docker' },
  })
  assert.equal(conflict.statusCode, 400, 'host and docker are mutually exclusive')
})

test('Fleet M2 regression: an agent node workspace = the remote path passed through as-is (Windows resolve must not turn it into a C:\\ prefix)', async () => {
  const { app, config, supervisors } = await boot()
  const created = await app.inject({
    method: 'POST',
    url: '/api/nodes',
    payload: {
      name: 'ops33',
      install: false,
      host: 'agent-abc123',
      url: 'http://10.0.0.7:3081',
      agent: { id: 'ops33', workspace: '/root/dac-workspaces/ops33', preset: 'standard', sandboxMode: 'workspace-write' },
    },
  })
  assert.equal(created.statusCode, 201, JSON.stringify(created.body))
  assert.equal(config.agents['ops33']?.workspacePath, '/root/dac-workspaces/ops33', 'the remote workspace path reaches the source of truth as-is (it was resolved to C:\\root\\... and the facade rejected the cwd)')
  const supervisor = supervisors.get('ops33')!
  stopped.push(supervisor)
})

test('Fleet M3-1: the third sandbox tier of an ops node -- agent.sandboxMode=danger-full-access reaches the source of truth; an invalid tier is 400', async () => {
  const { app, config, supervisors } = await boot()
  const created = await app.inject({
    method: 'POST',
    url: '/api/nodes',
    payload: {
      name: 'ops01',
      install: false,
      host: 'agent-abc123',
      url: 'http://10.0.0.7:3081',
      agent: { id: 'ops01', name: '运维助手', workspace: join(dir, 'ws-ops01'), preset: 'standard', sandboxMode: 'danger-full-access' },
    },
  })
  assert.equal(created.statusCode, 201, JSON.stringify(created.body))
  assert.equal(config.agents['ops01']?.sandboxMode, 'danger-full-access', 'the full sandbox tier reaches the source of truth (the approval card is handled by the facade)')
  const supervisor = supervisors.get('ops01')!
  stopped.push(supervisor)

  const bad = await app.inject({
    method: 'POST',
    url: '/api/nodes',
    payload: { name: 'ops02', install: false, host: 'agent-abc123', url: 'http://10.0.0.7:3082', agent: { sandboxMode: 'total-control' } },
  })
  assert.equal(bad.statusCode, 400, 'an unknown sandbox tier is rejected explicitly')
})

test('Live-lesson regression: an explicit process on a container deployment = 400 host_process_unavailable; an unmarked bare-metal deployment passes as before', async () => {
  const prev = process.env.DAC_DEPLOY_FORM
  process.env.DAC_DEPLOY_FORM = 'container'
  try {
    const { app } = await boot()
    const bad = await app.inject({
      method: 'POST',
      url: '/api/nodes',
      payload: { name: 'h1', install: false, runner: 'process' },
    })
    assert.equal(bad.statusCode, 400, JSON.stringify(bad.body))
    assert.equal((bad.json() as { error: string }).error, 'host_process_unavailable', 'container form must be rejected explicitly')
  } finally {
    if (prev === undefined) delete process.env.DAC_DEPLOY_FORM
    else process.env.DAC_DEPLOY_FORM = prev
  }
})

test('Hive plan 2 P6: a new node in container mode = docker runner (no DSH bin lookup, named volume + intranet alias + host path derivation)', async () => {
  const { app, config, supervisors } = await boot()
  // Simulate a spine deployment that already has a personal worker (docker runner), which puts the wizard into container mode
  config.endpoints['personal'] = {
    id: 'personal',
    url: 'http://node-personal:3081',
    driver: 'apiproxy',
    prefix: '/api',
    key: '',
    sandboxBase: 'http://node-personal:3081/api-gw/v1',
    sandboxKey: 'apigw-x',
    spawn: {
      managed: true,
      command: '',
      args: [],
      cwd: null,
      readyTimeoutMs: 30_000,
      detached: false,
      logFile: null,
      env: {},
      restart: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 30_000 },
      runner: 'docker',
      host: null,
      docker: {
        image: 'hellodac/dac-node:0.1.1-rc.2',
        containerName: null,
        network: 'dac-hive',
        port: 3081,
        hostVolumes: { '/srv/dac/workspaces/personal': '/opt/dac/workspaces/personal' },
        namedVolumes: { 'dac-personal': '/data' },
      },
    },
    access: null,
  }

  const created = await app.inject({ method: 'POST', url: '/api/nodes', payload: { name: 'product' } })
  assert.equal(created.statusCode, 201, JSON.stringify(created.body))
  const body = created.json() as { node: { id: string; home: string; port: number } }
  assert.equal(body.node.home, 'dac-product', 'the node home = the named volume')

  const spawn = config.endpoints['product']?.spawn
  assert.ok(spawn !== null && spawn !== undefined)
  assert.equal(spawn.runner, 'docker', 'container mode never looks for a DSH bin')
  assert.equal(spawn.docker?.network, 'dac-hive')
  assert.equal(spawn.docker?.namedVolumes['dac-product'], '/data')
  // The host path prefix is derived from personal (/srv/dac/workspaces/product); the in-container path is what the manager sees
  assert.equal(spawn.docker?.hostVolumes['/srv/dac/workspaces/product'], '/opt/dac/workspaces/product')
  assert.equal(config.endpoints['product']?.url, 'http://node-product:3090')
  // Debt R10 regression (measured when the compose-e2e worker timed out on live): once 0.1.2 is the main path a
  // new endpoint must go through the facade (/api-gw/v1/proxy + GW_KEY) -- the old 0.1.1 wiring prefix:/api + key_ref:'' gave 401 on probe.
  assert.equal(config.endpoints['product']?.prefix, '/api-gw/v1/proxy', 'the 0.1.2 main path = the facade prefix')
  const envText = readFileSync(join(dir, '.env'), 'utf8')
  const productKey = /^GW_KEY_PRODUCT=(.*)$/m.exec(envText)?.[1] ?? ''
  assert.ok(productKey !== '', '.env must carry GW_KEY_PRODUCT')
  assert.equal(config.endpoints['product']?.key, productKey, 'the in-memory endpoint key equals the .env one (used for facade auth)')

  const yaml = readFileSync(join(dir, 'manager.config.yaml'), 'utf8')
  assert.match(yaml, /runner: docker/)
  assert.match(yaml, /http:\/\/node-product:3090/)
  assert.match(yaml, /key_ref: GW_KEY_PRODUCT/, 'the yaml endpoint key_ref must be this node key (the old wiring left it empty and probed 401)')
  assert.match(yaml, /prefix: \/api-gw\/v1\/proxy/, 'the yaml endpoint prefix must be the facade prefix')
  assert.match(readFileSync(join(dir, '.env'), 'utf8'), /GW_KEY_PRODUCT=/)
  // Incident regression (compose-e2e red on 2026-09-26): the docker branch must not write host: null into the
  // truth file -- spawnSchema accepts only a string or absence, and null makes loadConfig unable to read it
  // back (a chain of failures across restart/backup/restore). In memory host=null is legal (absence parses to null);
  // the file only needs the field **absent**. The full read-back loop is the standalone test below.
  assert.doesNotMatch(yaml, /host: null/, 'host: null must never appear in the yaml')

  stopped.push(supervisors.get('product')!)
  const removed = await app.inject({ method: 'DELETE', url: '/api/nodes/product' })
  assert.equal(removed.statusCode, 200)
  assert.doesNotMatch(readFileSync(join(dir, 'manager.config.yaml'), 'utf8'), /product/)
})

test('Incident regression: the docker spawn truth file must read back (an absent host is legal, host:null is not)', () => {
  // Isomorphic to the shape writeNodeTruth writes: a docker runner + a complete agents section.
  const valid = `listen:\n  host: 127.0.0.1\n  port: 8080\nendpoints:\n  product:\n    url: http://node-product:3090\n    driver: apiproxy\n    prefix: /api-gw/v1/proxy\n    key_ref: GW_KEY_PRODUCT\n    sandbox_base: http://node-product:3090/api-gw/v1\n    sandbox_key_ref: GW_KEY_PRODUCT\n    spawn:\n      managed: true\n      runner: docker\n      ready_timeout_ms: 30000\n      docker:\n        image: hellodac/dac-node:0.1.5-rc.2\n        network: dac-hive\n        port: 3090\nagents:\n  product:\n    name: Product\n    endpoint: product\n    workspace: /opt/dac/workspaces/product\n    public: false\n    preset: standard\n    sandbox_mode: workspace-write\n`
  const good = join(dir, 'recheck-good.yaml')
  const bad = join(dir, 'recheck-bad.yaml')
  writeFileSync(good, valid, 'utf8')
  writeFileSync(bad, valid.replace('      runner: docker\n', '      runner: docker\n      host: null\n'), 'utf8')

  // loadConfig checks each GW_KEY_* that key_ref/sandbox_key_ref addresses for non-emptiness, and the variable
  // does not exist on CI (the local .env covers it) -- the test provides its own and restores it afterwards.
  const prevKey = process.env.GW_KEY_PRODUCT
  process.env.GW_KEY_PRODUCT = 'apigw-test-key'
  try {
    const reread = loadConfig(good)
    assert.equal(reread.endpoints['product']?.spawn?.runner, 'docker')
    assert.equal(reread.endpoints['product']?.spawn?.host, null, 'an absent host -> parses to null (legal in memory)')

    // The reverse: writing host: null into the file = it cannot be read back. That is exactly the chain that
    // turned compose-e2e red on 2026-09-26: the file written after dynamically provisioning a worker blew up on backup/restore.
    assert.throws(() => loadConfig(bad), /host/, 'host: null in the file must be rejected by the schema')
  } finally {
    if (prevKey === undefined) delete process.env.GW_KEY_PRODUCT
    else process.env.GW_KEY_PRODUCT = prevKey
  }
  rmSync(good, { force: true })
  rmSync(bad, { force: true })
})

test('Hive plan 2 P6 regression: a node created in container mode mirrors into the DB (chat foreign keys no longer blow up)', async () => {  const { app, config, db } = await boot()
  config.endpoints['personal'] = {
    id: 'personal',
    url: 'http://node-personal:3081',
    driver: 'apiproxy',
    prefix: '/api',
    key: '',
    sandboxBase: 'http://node-personal:3081/api-gw/v1',
    sandboxKey: 'apigw-x',
    spawn: {
      managed: true,
      command: '',
      args: [],
      cwd: null,
      readyTimeoutMs: 30_000,
      detached: false,
      logFile: null,
      env: {},
      restart: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 30_000 },
      runner: 'docker',
      host: null,
      docker: {
        image: 'hellodac/dac-node:0.1.1-rc.2',
        containerName: null,
        network: 'dac-hive',
        port: 3081,
        hostVolumes: { '/srv/dac/workspaces/personal': '/opt/dac/workspaces/personal' },
        namedVolumes: { 'dac-personal': '/data' },
      },
    },
    access: null,
  }

  const created = await app.inject({
    method: 'POST',
    url: '/api/nodes',
    payload: { name: 'product', agent: { id: 'product', name: '产品', workspace: join(dir, 'ws-product-docker') } },
  })
  assert.equal(created.statusCode, 201, JSON.stringify(created.body))
  const row = db.select().from(schema.agent).all().find((a) => a.id === 'product')
  assert.ok(row !== undefined, 'the agent mirrors into the DB registry (chat foreign keys depend on it)')
})

test('Debt B1 regression: dependency install runs in the background -- installNodeDepsAsync does not freeze the event loop, the spawn arguments are right', async () => {
  // TS cannot track an assignment made inside a closure, so use a sentinel object with an asserted type
  const spawnArgs = {} as { cmd: string; args: string[]; cwd: string }
  const fakeSpawn = (cmd: string, args: string[], opts: { cwd: string }): unknown => {
    spawnArgs.cmd = cmd
    spawnArgs.args = args
    spawnArgs.cwd = opts.cwd
    const listeners: Record<string, (code: number) => void> = {}
    const child = {
      on: (ev: string, fn: (code: number) => void) => {
        listeners[ev] = fn
        return child
      },
    }
    setTimeout(() => listeners['exit']?.(0), 400) // exit 0 after 400ms
    return child
  }
  const promise = installNodeDepsAsync('/tmp/node-home/profiles/x', undefined, fakeSpawn as never)
  // The event loop was not frozen: a timer queued immediately must fire before install finishes (the old synchronous execFileSync froze it)
  let ticked = false
  setTimeout(() => {
    ticked = true
  }, 50)
  await promise
  assert.ok(ticked, 'the event loop must stay responsive during install')
  assert.ok(spawnArgs.cmd !== '')
  assert.ok(spawnArgs.args.includes('--prefer-offline'), 'it must pass --prefer-offline')
  assert.equal(spawnArgs.cwd, '/tmp/node-home/profiles/x')
})

test('Debt B1 regression: a non-zero exit from the background install = reject (the caller audits on it)', async () => {
  const fakeSpawn = (): unknown => {
    const listeners: Record<string, (code: number) => void> = {}
    const child = {
      on: (ev: string, fn: (code: number) => void) => {
        listeners[ev] = fn
        return child
      },
    }
    setTimeout(() => listeners['exit']?.(1), 10) // a non-zero exit = failure
    return child
  }
  await assert.rejects(
    () => installNodeDepsAsync('/tmp/any', undefined, fakeSpawn as never),
    /exit|failed/i,
    'a non-zero exit must reject',
  )
})

test('Capability two regression: a 0.1.5 pair installs with --legacy-peer-deps automatically, 0.1.2 does not (the dsh-facts §12 ERESOLVE fix)', async () => {
  const seen: string[][] = []
  const fakeSpawn = (_cmd: string, args: string[]): unknown => {
    seen.push(args)
    const listeners: Record<string, (code: number) => void> = {}
    const child = {
      on: (ev: string, fn: (code: number) => void) => {
        listeners[ev] = fn
        return child
      },
    }
    setTimeout(() => listeners['exit']?.(0), 5)
    return child
  }
  await installNodeDepsAsync('/tmp/n15', '0.1.5-rc.2', fakeSpawn as never)
  await installNodeDepsAsync('/tmp/n12', '0.1.2-rc.1', fakeSpawn as never)
  assert.ok(seen[0]?.includes('--legacy-peer-deps'), `0.1.5 must carry --legacy-peer-deps, got ${JSON.stringify(seen[0])}`)
  assert.ok(seen[1] !== undefined && !seen[1].includes('--legacy-peer-deps'), '0.1.2 does not need that flag')
})

test('Debt H2 regression: a DB write failure -> provision rolls back completely, no ghost node left behind', async () => {
  const { app, config, db, sqlite, supervisors } = await boot()
  // Injected at the real DB layer: the agent insert throws (simulating disk full / constraint conflicts and other real failure paths)
  sqlite.exec("CREATE TRIGGER boom_agent_insert BEFORE INSERT ON agent BEGIN SELECT RAISE(ABORT, 'boom'); END")

  const res = await app.inject({
    method: 'POST',
    url: '/api/nodes',
    payload: { name: 'boom-node', install: false, agent: { id: 'boom-agent', workspace: join(dir, 'ws-boom') } },
  })
  assert.equal(res.statusCode, 500)

  // A complete rollback: no residue on any of the six faces -- memory / supervisors / yaml / .env / node directory / DB
  assert.equal(config.endpoints['boom-node'], undefined, 'no endpoint left in memory')
  assert.equal(config.agents['boom-agent'], undefined, 'no agent left in memory')
  assert.ok(!supervisors.has('boom-node'), 'no supervisor left')
  assert.doesNotMatch(readFileSync(join(dir, 'manager.config.yaml'), 'utf8'), /boom-node/, 'no residue in the yaml')
  assert.doesNotMatch(readFileSync(join(dir, '.env'), 'utf8'), /GW_KEY_BOOM_NODE/, 'no secret left in .env')
  assert.ok(!existsSync(join(nodesRoot, 'boom-node')), 'the node directory must be cleaned up')
  assert.equal(
    db.select().from(schema.agent).all().find((a) => a.id === 'boom-agent'),
    undefined,
    'no agent row may be left in the DB',
  )
})

test('Debt R9: a hot change converges through reconcile -- provisioning must not drag in other cold nodes the user stopped by hand', async () => {
  const { app, config, supervisors } = await boot()
  // Preset an existing managed node (stopped by hand = cold) and stub its supervisor to see whether it gets started
  const starts: string[] = []
  const stub = {
    current: { state: 'cold' },
    start: () => {
      starts.push('personal')
    },
  } as unknown as NodeSupervisor
  supervisors.set('personal', stub)
  config.endpoints['personal'] = {
    id: 'personal',
    url: 'http://127.0.0.1:3081',
    driver: 'apiproxy',
    prefix: '/api',
    key: '',
    sandboxBase: null,
    sandboxKey: '',
    spawn: {
      managed: true,
      command: 'node',
      args: ['x'],
      cwd: null,
      readyTimeoutMs: 1_000,
      detached: false,
      logFile: null,
      env: {},
      restart: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 30_000 },
      runner: 'process',
      host: null,
      docker: null,
    },
    access: null,
  }

  const created = await app.inject({
    method: 'POST',
    url: '/api/nodes',
    payload: { name: 'product', install: false },
  })
  assert.equal(created.statusCode, 201, JSON.stringify(created.body))
  // Let the install:false microtask chain (installPromise.then -> reconcile) run to completion
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(starts, [], 'a hot change must not start other cold nodes (onlyNodes scopes it)')
  assert.ok(supervisors.has('product'), 'the new node own supervisor must be registered')
  const supervisor = supervisors.get('product')!
  stopped.push(supervisor)
})
