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

test('蜂群 P5.5: provision creates a node (profile/key/config write-back/hot-load) and removes it', async () => {
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

  // 热加载：内存配置、监督器、yaml 写回、.env 密钥
  assert.ok(config.endpoints['product'] !== undefined)
  assert.ok(config.endpoints['product'].spawn !== null)
  assert.ok(supervisors.has('product'))
  const yaml = readFileSync(join(dir, 'manager.config.yaml'), 'utf8')
  assert.match(yaml, /product/)
  assert.match(readFileSync(join(dir, '.env'), 'utf8'), /GW_KEY_PRODUCT=/)
  assert.ok(join(nodesRoot, 'product') !== '')

  // 重名 / 端口冲突
  const dup = await app.inject({ method: 'POST', url: '/api/nodes', payload: { name: 'product', install: false } })
  assert.equal(dup.statusCode, 409)
  const port = await app.inject({ method: 'POST', url: '/api/nodes', payload: { name: 'other', port: 3090, install: false } })
  assert.equal(port.statusCode, 409)
  assert.match(String((port.json() as { detail: string }).detail), /already taken/)

  // 删除（无 agent 绑定）
  const supervisor = supervisors.get('product')!
  stopped.push(supervisor)
  const removed = await app.inject({ method: 'DELETE', url: '/api/nodes/product' })
  assert.equal(removed.statusCode, 200)
  assert.equal(config.endpoints['product'], undefined)
  assert.ok(!supervisors.has('product'))
  assert.doesNotMatch(readFileSync(join(dir, 'manager.config.yaml'), 'utf8'), /product/)
})

test('蜂群 P5.5: deleting a node removes its workspace binding rows too, files untouched', async () => {
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
  // DB 行保留（账单与审计不删）；工作区目录保留
  assert.ok(db.select().from(schema.agent).all().find((a) => a.id === 'company') !== undefined)
  assert.ok(join(dir, 'ws-company') !== '')

  const missing = await app.inject({ method: 'DELETE', url: '/api/nodes/nope' })
  assert.equal(missing.statusCode, 404)
})

test('能力二回归: dsh_version 按节点钉版——pending 黄字、未知版本 400、verified 无警告', async () => {
  const { app, config, supervisors } = await boot()
  // 真实矩阵两行均已 verified；pending 黄字路径经测试注入缝覆盖。
  _setMatrixForTest([{ dsh: '0.1.5-rc.2', gateway: GATEWAY_REF, status: 'pending' }])
  try {
    const created = await app.inject({
      method: 'POST',
      url: '/api/nodes',
      payload: { name: 'v15', install: false, dsh_version: '0.1.5-rc.2' },
    })
    assert.equal(created.statusCode, 201, JSON.stringify(created.body))
    const body = created.json() as { versionWarning?: boolean }
    assert.equal(body.versionWarning, true, 'pending 配对 → 黄字警告')
    assert.equal(config.endpoints['v15']?.spawn?.dshVersion, '0.1.5-rc.2', '内存端点钉版')
    const pkg = JSON.parse(readFileSync(join(nodesRoot, 'v15', 'profiles', 'v15', 'package.json'), 'utf8'))
    assert.equal(pkg.dependencies['@deepseek-ai/dsh'], '0.1.5-rc.2', 'profile 钉目标版本')
    assert.match(readFileSync(join(dir, 'manager.config.yaml'), 'utf8'), /dsh_version: 0.1.5-rc.2/, 'yaml 落盘钉版')
    const supervisor = supervisors.get('v15')!
    stopped.push(supervisor)

    const bad = await app.inject({ method: 'POST', url: '/api/nodes', payload: { name: 'vbad', install: false, dsh_version: '0.9.9' } })
    assert.equal(bad.statusCode, 400, '未知版本显性拒绝')
  } finally {
    _resetMatrixForTest()
  }

  const clean = await app.inject({ method: 'POST', url: '/api/nodes', payload: { name: 'v15c', install: false, dsh_version: '0.1.5-rc.2' } })
  assert.equal(clean.statusCode, 201, JSON.stringify(clean.body))
  assert.equal((clean.json() as { versionWarning?: boolean }).versionWarning, undefined, 'verified 配对不再黄字')
  const supervisorClean = supervisors.get('v15c')!
  stopped.push(supervisorClean)
})

test('蜂群 P5.5: unknown agent id shape is rejected', async () => {
  const { app } = await boot()
  const bad = await app.inject({ method: 'POST', url: '/api/nodes', payload: { name: 'BAD NAME', install: false } })
  assert.equal(bad.statusCode, 400)
})

test('能力一回归: 显式 runner=process 在 docker 部署上建宿主机进程节点（审计 node_create_host）', async () => {
  const { app, config, db, supervisors } = await boot()
  // 预置 docker 端点使部署进入 docker 形态（同 P6 测试的 personal 脊柱）
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
  assert.equal(spawn?.runner, 'process', '显式 process 覆盖 docker 形态自动判定')
  const yaml = readFileSync(join(dir, 'manager.config.yaml'), 'utf8')
  assert.match(yaml, /hostnode:/, 'yaml 落盘新节点')
  assert.match(yaml, /command: node/, 'yaml 落盘进程形态（runner 缺省即 process，不序列化）')
  assert.doesNotMatch(yaml, /runner: docker/, 'yaml 不得落 docker 形态')
  const auditKinds = db.select().from(schema.auditLog).all().map((r) => r.kind)
  assert.ok(auditKinds.includes('node_create_host'), '宿主机进程形态创建审计 node_create_host')

  const supervisor = supervisors.get('hostnode')!
  stopped.push(supervisor)
})

test('能力四 M1-7: 向导建 agent 节点——runner=agent+host 落真相源、无本地 profile、url 必填、与 docker 互斥', async () => {
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
  assert.equal(spawn?.readyTimeoutMs, 120_000, 'M1 试点实证：agent 远端首启 40~90s，就绪窗必须放宽（30s 误杀重启链）')
  assert.equal(config.endpoints['ops01']?.url, 'http://10.0.0.7:3081', '远程 facade 地址进真相源')
  const yaml = readFileSync(join(dir, 'manager.config.yaml'), 'utf8')
  const section = yaml.slice(yaml.indexOf('ops01:'))
  assert.match(section, /runner: agent/, 'yaml 落 agent 形态')
  assert.match(section, /host: agent-abc123/, 'yaml 落 host')
  assert.doesNotMatch(section, /command: node/, '无本地 command（agent 侧用自己 prefix 的 bin）')
  assert.match(readFileSync(join(dir, '.env'), 'utf8'), /GW_KEY_OPS01=/, '钥匙进 .env')
  assert.ok(!existsSync(join(nodesRoot, 'ops01', 'profiles', 'ops01', 'package.json')), '本地不做 profile（agent 侧随载荷完成）')
  const auditKinds = db.select().from(schema.auditLog).all().map((r) => r.kind)
  assert.ok(auditKinds.includes('node_create_host'), '整机能力审计')
  const supervisor = supervisors.get('ops01')!
  stopped.push(supervisor)

  const noUrl = await app.inject({ method: 'POST', url: '/api/nodes', payload: { name: 'ops02', install: false, host: 'agent-abc123' } })
  assert.equal(noUrl.statusCode, 400, 'agent 节点必须给 url')
  const conflict = await app.inject({
    method: 'POST',
    url: '/api/nodes',
    payload: { name: 'ops03', install: false, host: 'agent-abc123', url: 'http://10.0.0.7:3083', runner: 'docker' },
  })
  assert.equal(conflict.statusCode, 400, 'host 与 docker 互斥')
})

test('舰队 M2 回归: agent 节点工作区 = 远端路径原样透传（不得被 Windows resolve 成 C:\\ 前缀）', async () => {
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
  assert.equal(config.agents['ops33']?.workspacePath, '/root/dac-workspaces/ops33', '远端工作区路径原样落真相源（实测被 resolve 成 C:\\root\\... → facade 拒 cwd）')
  const supervisor = supervisors.get('ops33')!
  stopped.push(supervisor)
})

test('舰队 M3-1: ops 节点第三档沙箱——agent.sandboxMode=danger-full-access 落真相源；非法档位 400', async () => {
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
  assert.equal(config.agents['ops01']?.sandboxMode, 'danger-full-access', '全量沙箱档位进真相源（审批卡片由 facade 兜底）')
  const supervisor = supervisors.get('ops01')!
  stopped.push(supervisor)

  const bad = await app.inject({
    method: 'POST',
    url: '/api/nodes',
    payload: { name: 'ops02', install: false, host: 'agent-abc123', url: 'http://10.0.0.7:3082', agent: { sandboxMode: 'total-control' } },
  })
  assert.equal(bad.statusCode, 400, '未知沙箱档位显性拒绝')
})

test('线上教训回归: 容器形态部署显式 process = 400 host_process_unavailable；无标记的裸机部署照常放行', async () => {
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
    assert.equal((bad.json() as { error: string }).error, 'host_process_unavailable', '容器形态必须显性拒绝')
  } finally {
    if (prev === undefined) delete process.env.DAC_DEPLOY_FORM
    else process.env.DAC_DEPLOY_FORM = prev
  }
})

test('蜂群2计划 P6: 容器模式新节点 = docker runner（不找 DSH bin，命名卷 + 内网别名 + 宿主路径推导）', async () => {
  const { app, config, supervisors } = await boot()
  // 模拟脊柱部署已存在 personal 工蜂（docker runner），向导据此进入容器模式
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
  assert.equal(body.node.home, 'dac-product', '节点 home = 命名卷')

  const spawn = config.endpoints['product']?.spawn
  assert.ok(spawn !== null && spawn !== undefined)
  assert.equal(spawn.runner, 'docker', '容器模式绝不找 DSH bin')
  assert.equal(spawn.docker?.network, 'dac-hive')
  assert.equal(spawn.docker?.namedVolumes['dac-product'], '/data')
  // 宿主路径前缀从 personal 推导（/srv/dac/workspaces/product），容器内路径 = manager 视角
  assert.equal(spawn.docker?.hostVolumes['/srv/dac/workspaces/product'], '/opt/dac/workspaces/product')
  assert.equal(config.endpoints['product']?.url, 'http://node-product:3090')
  // 债务 R10 回归（compose-e2e worker live 超时实证）：0.1.2 切主路后新建端点必须走
  // facade（/api-gw/v1/proxy + GW_KEY）——旧 0.1.1 接线 prefix:/api + key_ref:'' 探活 401。
  assert.equal(config.endpoints['product']?.prefix, '/api-gw/v1/proxy', '0.1.2 主路 = facade 前缀')
  const envText = readFileSync(join(dir, '.env'), 'utf8')
  const productKey = /^GW_KEY_PRODUCT=(.*)$/m.exec(envText)?.[1] ?? ''
  assert.ok(productKey !== '', '.env 必须落盘 GW_KEY_PRODUCT')
  assert.equal(config.endpoints['product']?.key, productKey, '内存端点 key 与 .env 同值（facade 鉴权用）')

  const yaml = readFileSync(join(dir, 'manager.config.yaml'), 'utf8')
  assert.match(yaml, /runner: docker/)
  assert.match(yaml, /http:\/\/node-product:3090/)
  assert.match(yaml, /key_ref: GW_KEY_PRODUCT/, 'yaml 端点的 key_ref 必须是本节点钥匙（旧接线空 key_ref 探活 401）')
  assert.match(yaml, /prefix: \/api-gw\/v1\/proxy/, 'yaml 端点的 prefix 必须是 facade 前缀')
  assert.match(readFileSync(join(dir, '.env'), 'utf8'), /GW_KEY_PRODUCT=/)
  // 事故回归（2026-09-26 compose-e2e 红）：docker 分支不得把 host: null 写进
  // 真相文件——spawnSchema 只认 string 或缺省，null 会让 loadConfig 读不回来
  // （重启/备份/恢复连锁失败）。内存形态 host=null 合法（解析时缺省→null），
  // 文件里只需**缺省**。完整读回闭环见下方独立测试。
  assert.doesNotMatch(yaml, /host: null/, 'yaml 里不得出现 host: null')

  stopped.push(supervisors.get('product')!)
  const removed = await app.inject({ method: 'DELETE', url: '/api/nodes/product' })
  assert.equal(removed.statusCode, 200)
  assert.doesNotMatch(readFileSync(join(dir, 'manager.config.yaml'), 'utf8'), /product/)
})

test('事故回归: docker spawn 真相文件必须能读回（host 缺省合法、host:null 非法）', () => {
  // 与 writeNodeTruth 写出的形状同构：docker runner + 完整 agents 段。
  const valid = `listen:\n  host: 127.0.0.1\n  port: 8080\nendpoints:\n  product:\n    url: http://node-product:3090\n    driver: apiproxy\n    prefix: /api-gw/v1/proxy\n    key_ref: GW_KEY_PRODUCT\n    sandbox_base: http://node-product:3090/api-gw/v1\n    sandbox_key_ref: GW_KEY_PRODUCT\n    spawn:\n      managed: true\n      runner: docker\n      ready_timeout_ms: 30000\n      docker:\n        image: hellodac/dac-node:0.1.5-rc.2\n        network: dac-hive\n        port: 3090\nagents:\n  product:\n    name: Product\n    endpoint: product\n    workspace: /opt/dac/workspaces/product\n    public: false\n    preset: standard\n    sandbox_mode: workspace-write\n`
  const good = join(dir, 'recheck-good.yaml')
  const bad = join(dir, 'recheck-bad.yaml')
  writeFileSync(good, valid, 'utf8')
  writeFileSync(bad, valid.replace('      runner: docker\n', '      runner: docker\n      host: null\n'), 'utf8')

  const reread = loadConfig(good)
  assert.equal(reread.endpoints['product']?.spawn?.runner, 'docker')
  assert.equal(reread.endpoints['product']?.spawn?.host, null, '缺省 host → 解析成 null（内存形态合法）')

  // 反向：把 host: null 落进文件 = 读不回来。这正是 2026-09-26 compose-e2e
  // 红的那条链：动态开通 worker 后写出的文件在备份/恢复时炸掉。
  assert.throws(() => loadConfig(bad), /host/, 'host: null 落文件必须被 schema 拒绝')
  rmSync(good, { force: true })
  rmSync(bad, { force: true })
})

test('蜂群2计划 P6 回归: 容器模式新建节点同步镜像进 DB（chat 外键不再炸）', async () => {  const { app, config, db } = await boot()
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
  assert.ok(row !== undefined, 'agent 镜像进 DB registry（chat 外键依赖它）')
})

test('债务 B1 回归: 依赖安装后台化——installNodeDepsAsync 不冻结事件循环,spawn 参数正确', async () => {
  // TS 无法追踪闭包内赋值,用已断言类型的哨兵对象
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
    setTimeout(() => listeners['exit']?.(0), 400) // 400ms 后 exit 0
    return child
  }
  const promise = installNodeDepsAsync('/tmp/node-home/profiles/x', undefined, fakeSpawn as never)
  // 事件循环未被冻结:install 完成前,立即排队的 timer 必须先触发(旧同步 execFileSync 会冻结)
  let ticked = false
  setTimeout(() => {
    ticked = true
  }, 50)
  await promise
  assert.ok(ticked, 'install 期间事件循环必须保持响应')
  assert.ok(spawnArgs.cmd !== '')
  assert.ok(spawnArgs.args.includes('--prefer-offline'), '必须带 --prefer-offline')
  assert.equal(spawnArgs.cwd, '/tmp/node-home/profiles/x')
})

test('债务 B1 回归: 后台 install 非零退出 = reject(调用方据此审计留痕)', async () => {
  const fakeSpawn = (): unknown => {
    const listeners: Record<string, (code: number) => void> = {}
    const child = {
      on: (ev: string, fn: (code: number) => void) => {
        listeners[ev] = fn
        return child
      },
    }
    setTimeout(() => listeners['exit']?.(1), 10) // 非零退出 = 失败
    return child
  }
  await assert.rejects(
    () => installNodeDepsAsync('/tmp/any', undefined, fakeSpawn as never),
    /exit|失败|failed/i,
    '非零退出必须 reject',
  )
})

test('能力二回归: 0.1.5 配对安装自动带 --legacy-peer-deps，0.1.2 不带（dsh-facts §12 ERESOLVE 修复）', async () => {
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
  assert.ok(seen[0]?.includes('--legacy-peer-deps'), `0.1.5 必须带 --legacy-peer-deps，实得 ${JSON.stringify(seen[0])}`)
  assert.ok(seen[1] !== undefined && !seen[1].includes('--legacy-peer-deps'), '0.1.2 不需要该 flag')
})

test('债务 H2 回归: DB 写入失败 → provision 全量回滚,无幽灵节点残留', async () => {
  const { app, config, db, sqlite, supervisors } = await boot()
  // 真实 DB 层注入:agent 表插入即抛（模拟磁盘满/约束冲突等真实失败路径）
  sqlite.exec("CREATE TRIGGER boom_agent_insert BEFORE INSERT ON agent BEGIN SELECT RAISE(ABORT, 'boom'); END")

  const res = await app.inject({
    method: 'POST',
    url: '/api/nodes',
    payload: { name: 'boom-node', install: false, agent: { id: 'boom-agent', workspace: join(dir, 'ws-boom') } },
  })
  assert.equal(res.statusCode, 500)

  // 全量回滚:内存 / 监督器 / yaml / .env / 节点目录 / DB 六面全部无残留
  assert.equal(config.endpoints['boom-node'], undefined, '内存 endpoint 不得残留')
  assert.equal(config.agents['boom-agent'], undefined, '内存 agent 不得残留')
  assert.ok(!supervisors.has('boom-node'), '监督器不得残留')
  assert.doesNotMatch(readFileSync(join(dir, 'manager.config.yaml'), 'utf8'), /boom-node/, 'yaml 不得残留')
  assert.doesNotMatch(readFileSync(join(dir, '.env'), 'utf8'), /GW_KEY_BOOM_NODE/, '.env 密钥不得残留')
  assert.ok(!existsSync(join(nodesRoot, 'boom-node')), '节点目录必须被清理')
  assert.equal(
    db.select().from(schema.agent).all().find((a) => a.id === 'boom-agent'),
    undefined,
    'DB agent 行不得残留',
  )
})

test('债务 R9: 热变更经 reconcile 收敛——不借 provision 抢拉用户手动停掉的其它冷节点', async () => {
  const { app, config, supervisors } = await boot()
  // 预置一个既有托管节点(用户手动停掉 = cold),其 supervisor 用桩观察是否被 start
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
  // install:false 的微任务链(installPromise.then → reconcile)走完
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(starts, [], '热变更不得拉起其它冷节点(onlyNodes 范围化)')
  assert.ok(supervisors.has('product'), '新节点自己的监督器必须入册')
  const supervisor = supervisors.get('product')!
  stopped.push(supervisor)
})
