import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stringify } from 'yaml'
import { loadConfig } from './config.js'

// dotenv does not override existing vars, so a test-local secret wins over any
// real .env the repo may have.
if (process.env.SESSION_SECRET === undefined) process.env.SESSION_SECRET = 'x'.repeat(32)

const baseConfig = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  listen: { host: '127.0.0.1', port: 8080 },
  endpoints: { A: { url: 'http://127.0.0.1:3080', driver: 'apiproxy' } },
  agents: { personal: { name: '个人', endpoint: 'A', workspace: '.' } },
  ...extra,
})

const loadFrom = (obj: Record<string, unknown>): ReturnType<typeof loadConfig> => {
  const dir = mkdtempSync(join(tmpdir(), 'manager-config-test-'))
  try {
    const file = join(dir, 'config.yaml')
    writeFileSync(file, stringify(obj), 'utf8')
    return loadConfig(file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const withEnv = (vars: Record<string, string>, fn: () => void): void => {
  const saved = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key])
    process.env[key] = value
  }
  try {
    fn()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('债务 A5 回归: loadConfig 返回解析后的真相源路径——全项目单一来源', () => {
  const dir = mkdtempSync(join(tmpdir(), 'manager-config-test-'))
  try {
    const file = join(dir, 'config.yaml')
    writeFileSync(file, stringify(baseConfig()), 'utf8')
    const cfg = loadConfig(file)
    assert.equal(cfg.configPath, resolve(file), 'configPath 必须是解析后的绝对路径')
    assert.equal(cfg.envPath, resolve('.env'), 'envPath 必须是绝对路径(.env 的规范位置)')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('债务 E12 回归: agent.validate 治理规则解析与缺省', () => {
  withEnv({}, () => {
    const withRules = loadFrom(baseConfig({
      agents: {
        personal: {
          name: '个人',
          endpoint: 'A',
          workspace: '.',
          validate: {
            windows: [{ path: 'trade.history', max: 8, archive: 'somewhere.md' }],
            forbid_amount_fields: true,
            acct_flow_max_age_months: 1,
          },
        },
      },
    }))
    const rules = withRules.agents['personal']?.validate
    assert.ok(rules !== null)
    assert.deepEqual(rules?.windows, [{ path: 'trade.history', max: 8, archive: 'somewhere.md' }])
    assert.equal(rules?.forbidAmountFields, true)
    assert.equal(rules?.acctFlowMaxAgeMonths, 1)

    // 缺省 = null(调用方走 DEFAULT_RULES:只做通用凭证检查,不继承业务规则)
    const without = loadFrom(baseConfig())
    assert.equal(without.agents['personal']?.validate, null)
  })
})

test('parses the P0 fields: agent preset/sandbox_mode and endpoint sandbox surface', () => {  withEnv({ GW_KEY_A: 'test-gw-key' }, () => {
    const cfg = loadFrom(baseConfig({
      endpoints: {
        A: {
          url: 'http://127.0.0.1:3080',
          driver: 'apiproxy',
          sandbox_base: 'http://127.0.0.1:3080/api-gw/v1/',
          sandbox_key_ref: 'GW_KEY_A',
        },
      },
      agents: {
        personal: { name: '个人', endpoint: 'A', workspace: '.', preset: 'standard', sandbox_mode: 'workspace-write' },
      },
    }))
    const ep = cfg.endpoints['A']
    assert.ok(ep !== undefined)
    assert.equal(ep.sandboxBase, 'http://127.0.0.1:3080/api-gw/v1')
    assert.equal(ep.sandboxKey, 'test-gw-key')
    const agent = cfg.agents['personal']
    assert.ok(agent !== undefined)
    assert.equal(agent.preset, 'standard')
    assert.equal(agent.sandboxMode, 'workspace-write')
  })
})

test('defaults: no sandbox surface, no preset, no mode', () => {
  const cfg = loadFrom(baseConfig())
  const ep = cfg.endpoints['A']
  assert.ok(ep !== undefined)
  assert.equal(ep.sandboxBase, null)
  assert.equal(ep.sandboxKey, '')
  const agent = cfg.agents['personal']
  assert.ok(agent !== undefined)
  assert.equal(agent.preset, null)
  assert.equal(agent.sandboxMode, null)
})

test('债务 P1 回归: endpoint.access 隧道元数据解析与缺省(未配置 = 无能力)', () => {
  const cfg = loadFrom(baseConfig({
    endpoints: {
      A: {
        url: 'http://127.0.0.1:3080',
        driver: 'apiproxy',
        access: {
          ssh_user: 'ubuntu',
          ssh_host: '10.0.0.5',
          ssh_port: 2222,
          gui_port: 3082,
          local_port: 3088,
          ssh_key: 'C:\\Users\\you\\.ssh\\id_ed25519',
        },
      },
    },
  }))
  const ep = cfg.endpoints['A']
  assert.ok(ep !== undefined)
  assert.deepEqual(ep.access, { sshUser: 'ubuntu', sshHost: '10.0.0.5', sshPort: 2222, guiPort: 3082, localPort: 3088, sshKey: 'C:\\Users\\you\\.ssh\\id_ed25519' })

  // 未配置 access = null(节点页不显示「打开原生 GUI」)
  const bare = loadFrom(baseConfig())
  assert.equal(bare.endpoints['A']?.access, null)
})

test('债务 P1 回归: access 缺省端口(ssh 22 / gui 3080)与非法值拒绝', () => {
  const cfg = loadFrom(baseConfig({
    endpoints: {
      A: {
        url: 'http://127.0.0.1:3080',
        driver: 'apiproxy',
        access: { ssh_user: 'ubuntu', ssh_host: '10.0.0.5', local_port: 3088 },
      },
    },
  }))
  const access = cfg.endpoints['A']?.access
  assert.deepEqual(access, { sshUser: 'ubuntu', sshHost: '10.0.0.5', sshPort: 22, guiPort: 3080, localPort: 3088, sshKey: null })

  assert.throws(
    () => loadFrom(baseConfig({
      endpoints: {
        A: {
          url: 'http://127.0.0.1:3080',
          driver: 'apiproxy',
          access: { ssh_user: 'ubuntu', ssh_host: '10.0.0.5' }, // 缺 local_port
        },
      },
    })),
    /local_port/,
  )
})

test('债务 P3 回归: spawn.dsh_version / gateway_ref 按节点钉版解析（缺省 = null 跟随全局默认）', () => {
  const pinned = loadFrom(baseConfig({
    endpoints: {
      A: {
        url: 'http://127.0.0.1:3080',
        driver: 'apiproxy',
        spawn: {
          managed: true,
          command: 'node',
          args: ['bin.js'],
          dsh_version: '0.1.5-rc.2',
          gateway_ref: 'github:litestartup-com/dsh-api-gateway#deadbeef',
        },
      },
    },
  }))
  assert.equal(pinned.endpoints['A']?.spawn?.dshVersion, '0.1.5-rc.2')
  assert.equal(pinned.endpoints['A']?.spawn?.gatewayRef, 'github:litestartup-com/dsh-api-gateway#deadbeef')

  const defaults = loadFrom(baseConfig({
    endpoints: {
      A: {
        url: 'http://127.0.0.1:3080',
        driver: 'apiproxy',
        spawn: { managed: true, command: 'node', args: ['bin.js'] },
      },
    },
  }))
  assert.equal(defaults.endpoints['A']?.spawn?.dshVersion ?? null, null, '缺省 null = 跟随全局默认')
  assert.equal(defaults.endpoints['A']?.spawn?.gatewayRef ?? null, null)
})

test('能力四回归: runner=agent + host 解析——舰队远端节点形态（无本地 command，agent 侧用自己 prefix 的 bin）', () => {
  const cfg = loadFrom(baseConfig({
    endpoints: {
      A: {
        url: 'http://10.0.0.7:3081',
        driver: 'apiproxy',
        spawn: { managed: true, runner: 'agent', host: 'agent-abc123', env: { DSH_HOME: '/home/dac-node/.dac/ops01' } },
      },
    },
  }))
  const spawn = cfg.endpoints['A']?.spawn
  assert.equal(spawn?.runner, 'agent')
  assert.equal(spawn?.host, 'agent-abc123', 'host = 执行该节点的 agent id')
  assert.equal(spawn?.command, '', 'agent 形态不要求本地 command')
  assert.equal(spawn?.docker, null, 'agent 形态无 docker 段')
})

test('能力四回归: runner=agent 缺 host 拒绝；非 agent 形态写 host 拒绝（执行地与形态必须一致）', () => {
  assert.throws(
    () => loadFrom(baseConfig({
      endpoints: { A: { url: 'http://10.0.0.7:3081', driver: 'apiproxy', spawn: { managed: true, runner: 'agent' } } },
    })),
    /host/,
    'agent 无 host = fail-loud',
  )
  assert.throws(
    () => loadFrom(baseConfig({
      endpoints: { A: { url: 'http://127.0.0.1:3080', driver: 'apiproxy', spawn: { managed: true, command: 'node', host: 'agent-x' } } },
    })),
    /host/,
    'process 写 host = 拒绝（防接线漂移）',
  )
})

test('agent sandbox_mode without endpoint sandbox_base fails loud at boot', () => {
  assert.throws(
    () => loadFrom(baseConfig({
      agents: { personal: { name: '个人', endpoint: 'A', workspace: '.', sandbox_mode: 'read-only' } },
    })),
    /no sandbox_base/,
  )
})

test('endpoint sandbox_base with empty key env fails loud at boot', () => {
  withEnv({ GW_KEY_A: '' }, () => {
    assert.throws(
      () => loadFrom(baseConfig({
        endpoints: {
          A: {
            url: 'http://127.0.0.1:3080',
            driver: 'apiproxy',
            sandbox_base: 'http://127.0.0.1:3080/api-gw/v1',
            sandbox_key_ref: 'GW_KEY_A',
          },
        },
      })),
      /GW_KEY_A is empty/,
    )
  })
})

test('parses a managed spawn spec with defaults and resolved cwd', () => {
  const cfg = loadFrom(baseConfig({
    endpoints: {
      A: {
        url: 'http://127.0.0.1:3080',
        driver: 'apiproxy',
        spawn: {
          managed: true,
          command: 'node',
          args: ['bin.js', '--profile', 'web'],
          cwd: '.',
        },
      },
    },
  }))
  const ep = cfg.endpoints['A']
  assert.ok(ep !== undefined)
  assert.ok(ep.spawn !== null)
  assert.equal(ep.spawn.managed, true)
  assert.equal(ep.spawn.command, 'node')
  assert.deepEqual(ep.spawn.args, ['bin.js', '--profile', 'web'])
  assert.equal(ep.spawn.cwd, resolve('.'))
  assert.equal(ep.spawn.readyTimeoutMs, 30_000)
  assert.equal(ep.spawn.detached, false)
  assert.equal(ep.spawn.logFile, null)
  assert.deepEqual(ep.spawn.restart, { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 30_000 })
})

test('蜂群 P5.1: brain daily budget defaults off and parses when set', () => {
  assert.equal(loadFrom(baseConfig()).brainDailyBudgetMicroUsd, null)
  const capped = loadFrom(baseConfig({ brain: { daily_budget_usd: 1.5 } }))
  assert.equal(capped.brainDailyBudgetMicroUsd, 1_500_000)
})

test('v1.0.3: apiproxy prefix — explicit config wins, legacy default only when omitted', () => {
  // 老配置（显式 /api）与省略 prefix 的配置行为不变。
  const legacyExplicit = loadFrom(baseConfig({
    endpoints: { A: { url: 'http://127.0.0.1:3080', driver: 'apiproxy', prefix: '/api' } },
  }))
  assert.equal(legacyExplicit.endpoints['A']?.prefix, '/api')
  const legacyOmitted = loadFrom(baseConfig())
  assert.equal(legacyOmitted.endpoints['A']?.prefix, '/api', '省略 prefix 沿用 0.1.1 旧默认')
  // 0.1.2 新线：显式指向网关 facade 的 prefix 不再被钉死覆盖。
  const facade = loadFrom(baseConfig({
    endpoints: { A: { url: 'http://127.0.0.1:3091', driver: 'apiproxy', prefix: '/api-gw/v1/proxy' } },
  }))
  assert.equal(facade.endpoints['A']?.prefix, '/api-gw/v1/proxy')
  // gateway 驱动的 prefix 行为保持原样（显式优先）。
  withEnv({ GW_KEY_A: 'test-gw-key' }, () => {
    const gw = loadFrom(baseConfig({
      endpoints: { A: { url: 'http://127.0.0.1:3080', driver: 'gateway', prefix: '/api-gw/v1', key_ref: 'GW_KEY_A' } },
    }))
    assert.equal(gw.endpoints['A']?.prefix, '/api-gw/v1')
  })
})

test('no spawn block resolves to null (externally managed node)', () => {  const cfg = loadFrom(baseConfig())
  assert.equal(cfg.endpoints['A']?.spawn, null)
})

test('蜂群2计划 P2: spawn.runner defaults to process; docker runner resolves its spec', () => {
  const cfg = loadFrom(baseConfig({
    endpoints: {
      A: {
        url: 'http://127.0.0.1:3080',
        driver: 'apiproxy',
        spawn: {
          managed: true,
          runner: 'docker',
          docker: {
            image: 'hellodac/dac-node:0.1.1-rc.2',
            network: 'hive',
            port: 3081,
            host_volumes: { '/opt/dac/workspaces/personal': '/workspace' },
            named_volumes: { 'dac-personal': '/data' },
          },
        },
      },
    },
  }))
  const spawn = cfg.endpoints['A']?.spawn
  assert.ok(spawn !== null && spawn !== undefined)
  assert.equal(spawn.runner, 'docker')
  assert.equal(spawn.command, '', 'docker runner 不需要 command')
  assert.equal(spawn.docker?.image, 'hellodac/dac-node:0.1.1-rc.2')
  assert.equal(spawn.docker?.containerName, null)
  assert.equal(spawn.docker?.network, 'hive')
  assert.equal(spawn.docker?.port, 3081)
  assert.deepEqual(spawn.docker?.hostVolumes, { '/opt/dac/workspaces/personal': '/workspace' })
  assert.deepEqual(spawn.docker?.namedVolumes, { 'dac-personal': '/data' })
})

test('蜂群2计划 P2: runner=docker without docker block fails loud', () => {
  assert.throws(
    () => loadFrom(baseConfig({
      endpoints: {
        A: {
          url: 'http://127.0.0.1:3080',
          driver: 'apiproxy',
          spawn: { managed: true, runner: 'docker' },
        },
      },
    })),
    /runner=docker needs a docker section/,
  )
})

test('蜂群2计划 P2: process spawn keeps resolving with runner=process and docker=null', () => {
  const cfg = loadFrom(baseConfig({
    endpoints: {
      A: { url: 'http://127.0.0.1:3080', driver: 'apiproxy', spawn: { managed: true, command: 'node' } },
    },
  }))
  assert.equal(cfg.endpoints['A']?.spawn?.runner, 'process')
  assert.equal(cfg.endpoints['A']?.spawn?.docker, null)
})

test('蜂群2计划 P5: 随仓发布的容器示例配置必须始终通过 schema（install.sh 依赖它）', () => {
  const example = join(dirname(fileURLToPath(import.meta.url)), '..', 'manager.config.container.example.yaml')
  withEnv({ GW_KEY_A: 'apigw-a', GW_KEY_B: 'apigw-b' }, () => {
    const cfg = loadConfig(example)
    const brain = cfg.endpoints['brain']
    const personal = cfg.endpoints['personal']
    assert.ok(brain !== undefined && personal !== undefined)
    assert.equal(brain.spawn, null, '主脑由 compose 声明（脊柱，非托管）')
    assert.equal(personal.spawn?.runner, 'docker')
    assert.equal(personal.spawn?.docker?.image, 'hellodac/dac-node:0.1.2-rc.1')
    assert.equal(personal.spawn?.docker?.network, 'dac-hive', '与 compose 显式网络名一致')
    // 工作区路径两套视角统一：节点容器内路径 = manager 视角路径（EACCES mkdir 根因回归）
    assert.equal(personal.spawn?.docker?.hostVolumes['/opt/dac/workspaces/personal'], '/opt/dac/workspaces/personal')
    assert.deepEqual(cfg.backupDockerVolumes, ['dac-brain'], '脊柱主脑卷进备份声明')
    assert.equal(cfg.backupAuto, false, '自动备份默认关闭（线上小盘教训）')
    assert.equal(cfg.agents['brain']?.sandboxMode, 'workspace-write')
  })
})

test('线上磁盘教训回归: backup.auto 默认关闭，显式 true 才开自动备份；interval_minutes 可调', () => {
  const bare = loadFrom(baseConfig())
  assert.equal(bare.backupAuto, false, '缺省 = 关闭')
  assert.equal(bare.backupIntervalMs, 15 * 60_000, '缺省间隔 15 分钟')

  const on = loadFrom(baseConfig({ backup: { auto: true } }))
  assert.equal(on.backupAuto, true, '显式开启')

  const daily = loadFrom(baseConfig({ backup: { auto: true, interval_minutes: 1440 } }))
  assert.equal(daily.backupIntervalMs, 1440 * 60_000, '小盘线上可放宽到每日')

  const off = loadFrom(baseConfig({ backup: { docker_volumes: ['x'] } }))
  assert.equal(off.backupAuto, false, '只配 docker_volumes 不改变默认关闭')
})

test('P0 回归: loadConfig 自动迁移旧配置——迁移警告可见、文件写回版本戳、原文件备份', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mig-load-'))
  try {
    const file = join(dir, 'config.yaml')
    writeFileSync(file, stringify(baseConfig()), 'utf8')
    const cfg = loadConfig(file)
    assert.ok(cfg.warnings.some((w) => w.includes('migrated from version 0 to 1')), '迁移说明进 config.warnings（boot 日志可见）')
    assert.match(readFileSync(file, 'utf8'), /config_version: 1/, '写回版本戳')
    assert.ok(existsSync(`${file}.pre-mig.bak`), '原文件备份')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P0 回归: 未来版本配置 fail-loud（配置来自更新版 manager，拒绝猜测）', () => {
  assert.throws(() => loadFrom(baseConfig({ config_version: 99 })), /newer than the supported/)
})

/**
 * 对外 API 的"服务"定义（口径：内部设计库 `manager/topics/CONCEPTS-ALIGNED.md`）。
 *
 * 夹具用**现网节点的真实形态**：apiproxy 驱动 + facade 代理前缀 + 该节点自己的
 * gateway 钥匙（`driver: gateway` 已是死路，见 facts/dsh-facts.md §15——历史夹具
 * 用的正是那条死路，会误导后来者）。
 *
 * 服务成员必须是 public agent 且按口径 §1 **各自独占进程**：成员漏标 public 会静默
 * 变成"谁都进不来的服务"，那是最难查的一类故障，所以 fail-loud。
 */
const serviceConfig = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  listen: { host: '127.0.0.1', port: 8080 },
  endpoints: {
    W: { url: 'http://127.0.0.1:3090', driver: 'apiproxy', prefix: '/api-gw/v1/proxy', key_ref: 'GW_KEY_TEST' },
  },
  agents: { 'worker-1': { name: '客服一', endpoint: 'W', workspace: '.', public: true } },
  ...extra,
})

const loadWithKeyEnv = (obj: Record<string, unknown>): ReturnType<typeof loadConfig> => {
  const saved = process.env.GW_KEY_TEST
  process.env.GW_KEY_TEST = 'test-gateway-key'
  try {
    return loadFrom(obj)
  } finally {
    if (saved === undefined) delete process.env.GW_KEY_TEST
    else process.env.GW_KEY_TEST = saved
  }
}

test('口径: 一个端点只挂一个 agent（同一端点两个 agent = fail-loud）', () => {
  const shared = baseConfig({
    agents: {
      a: { name: 'a', endpoint: 'A', workspace: '.' },
      b: { name: 'b', endpoint: 'A', workspace: '.' },
    },
  })
  assert.throws(() => loadFrom(shared), /shared by 2 agents/)
})

test('口径: 对外 agent 允许落在 apiproxy 端点（独占进程即可，不再看 driver 名字）', () => {
  // 历史红线是"apiproxy 上不许有 public agent"，它把用户推向 gateway 端点——而那条路
  // 在 facade 0.2.x 上已经不存在。真正的约束是进程独占（上一条用例已在管）。
  const cfg = loadFrom(
    baseConfig({
      agents: { pub: { name: '对外', endpoint: 'A', workspace: '.', public: true } },
    }),
  )
  assert.equal(cfg.agents['pub']?.public, true)
})

test('死路告警: driver: gateway 端点必须 warning（facade 0.2.x 无会话 REST 面）', () => {
  const legacy = baseConfig({
    endpoints: { G: { url: 'http://127.0.0.1:3090', driver: 'gateway', key_ref: 'GW_KEY_TEST' } },
    agents: { g: { name: 'g', endpoint: 'G', workspace: '.' } },
  })
  const cfg = loadWithKeyEnv(legacy)
  assert.ok(
    cfg.warnings.some((w) => w.includes('gateway driver, which is a dead path')),
    'gateway 驱动是半死状态：探活绿、会话 404 —— 启动就要喊出来',
  )
  const ok = loadFrom(baseConfig())
  assert.ok(!ok.warnings.some((w) => w.includes('dead path')), 'apiproxy 端点不该有这条告警')
})

test('对外 API 服务: 成员必须是 public agent（私有成员 fail-loud，不静默）', () => {
  const priv = serviceConfig({
    agents: { 'worker-1': { name: '客服一', endpoint: 'W', workspace: '.', public: false } },
    services: [{ id: 'support', label: '客服', workers: ['worker-1'] }],
  })
  assert.throws(() => loadWithKeyEnv(priv), /not public/)
})

test('对外 API 服务: 未知成员 / 重复服务 id / 非绝对挂载点 都 fail-loud', () => {
  const good = serviceConfig({ services: [{ id: 'support', label: '客服', workers: ['worker-1'] }] })
  assert.ok(loadWithKeyEnv(good).services)

  const ghost = serviceConfig({ services: [{ id: 'support', label: '客服', workers: ['ghost'] }] })
  assert.throws(() => loadWithKeyEnv(ghost), /unknown worker/)

  const dup = serviceConfig({
    services: [
      { id: 'support', label: '客服', workers: ['worker-1'] },
      { id: 'support', label: '重复', workers: ['worker-1'] },
    ],
  })
  assert.throws(() => loadWithKeyEnv(dup), /duplicate service/)

  const badMount = serviceConfig({
    services: [{ id: 'support', label: '客服', workers: ['worker-1'], knowledge: [{ host: '/srv/kb', mount: 'kb' }] }],
  })
  assert.throws(() => loadWithKeyEnv(badMount), /absolute/)
})

test('对外 API 服务: 正常解析（默认面=两种话术、手册默认只读）+ 门面默认只绑本机', () => {
  const cfg = loadWithKeyEnv(
    serviceConfig({
      services: [
        {
          id: 'support',
          label: '企业智能客服',
          workers: ['worker-1'],
          surfaces: ['conversations'],
          knowledge: [{ host: '/srv/knowledge/faq', mount: '/knowledge' }],
        },
      ],
    }),
  )
  assert.deepEqual(cfg.publicApi, { enabled: true, host: '127.0.0.1', port: 8081 }, '门面默认只绑本机')
  assert.equal(cfg.services?.length, 1)
  assert.equal(cfg.services[0]?.id, 'support')
  assert.deepEqual(cfg.services[0]?.surfaces, ['conversations'])
  assert.deepEqual(cfg.services[0]?.knowledge, [{ host: '/srv/knowledge/faq', mount: '/knowledge', readOnly: true }])

  const both = loadWithKeyEnv(serviceConfig({ services: [{ id: 's', label: 'x', workers: ['worker-1'] }] }))
  assert.deepEqual(both.services?.[0]?.surfaces, ['tasks', 'conversations'], '缺省两种话术都开')
})

test('对外 API: 未配置服务时为空（等价于"当前没有对外 API"），不影响既有配置', () => {
  const cfg = loadFrom(baseConfig())
  assert.deepEqual(cfg.services, [])
  assert.equal(cfg.publicApi?.enabled, true)
})

test('对外 API: 门面端口与后台端口相同 = fail-loud（否则门面永远起不来）', () => {
  const clash = serviceConfig({ public_api: { port: 8080 }, services: [{ id: 's', label: 'x', workers: ['worker-1'] }] })
  assert.throws(() => loadWithKeyEnv(clash), /same as listen\.port/)
})


/**
 * 服务级调度声明（口径 §8）：期望 agent 数 / 每 agent 并发 / 权限档位 / 会话回收时长 /
 * 放置策略的默认值与非法组合必须 fail-loud。
 */
test('服务声明: 默认值（1 个 agent · 每 agent 4 并发 · spread · 每机 4 个 · 只读 · 24 小时回收）', () => {
  const cfg = loadWithKeyEnv(serviceConfig({ services: [{ id: 'support', label: '客服', workers: ['worker-1'] }] }))
  const svc = cfg.services?.[0]
  assert.equal(svc?.count, 1)
  assert.equal(svc?.maxSessionsPerAgent, 4)
  assert.equal(svc?.permission, 'read', '对外 agent 默认只读')
  assert.equal(svc?.sessionIdleHours, 24, '会话空闲默认 24 小时回收')
  assert.equal(svc?.placement, 'spread')
  assert.deepEqual(svc?.machines, [])
  assert.equal(svc?.maxAgentsPerMachine, 4)
})

test('服务声明: 期望 agent 数叫 count（旧名 agents 必须报错，不能被静默丢掉）', () => {
  const renamed = loadWithKeyEnv(
    serviceConfig({ services: [{ id: 's', label: 'x', workers: ['worker-1'], count: 1 }] }),
  )
  assert.equal(renamed.services?.[0]?.count, 1)

  const stale = serviceConfig({ services: [{ id: 's', label: 'x', workers: ['worker-1'], agents: 1 }] })
  assert.throws(() => loadWithKeyEnv(stale), /agents/, '改名后残留的旧字段必须报错：静默丢掉 = 静默少配')
})

test('服务声明: 权限档位默认只读、可选可写、禁止全放开', () => {
  const write = loadWithKeyEnv(
    serviceConfig({ services: [{ id: 's', label: 'x', workers: ['worker-1'], permission: 'write' }] }),
  )
  assert.equal(write.services?.[0]?.permission, 'write')

  const full = serviceConfig({ services: [{ id: 's', label: 'x', workers: ['worker-1'], permission: 'full' }] })
  assert.throws(() => loadWithKeyEnv(full), /permission/, '对外流量 + 全放开 = 把整台机器交出去，schema 层就该拒绝')
})

test('服务声明: 会话空闲回收时长可建服务时指定，0 与负数 fail-loud', () => {
  const custom = loadWithKeyEnv(
    serviceConfig({ services: [{ id: 's', label: 'x', workers: ['worker-1'], session_idle_hours: 6 }] }),
  )
  assert.equal(custom.services?.[0]?.sessionIdleHours, 6)

  for (const bad of [0, -3]) {
    const cfg = serviceConfig({ services: [{ id: 's', label: 'x', workers: ['worker-1'], session_idle_hours: bad }] })
    assert.throws(() => loadWithKeyEnv(cfg), /session_idle_hours/)
  }
})

test('服务声明: pin 必须给 machines；非 pin 给 machines = fail-loud（不静默忽略）', () => {
  assert.throws(
    () => loadWithKeyEnv(serviceConfig({ services: [{ id: 's', label: 'x', workers: ['worker-1'], placement: 'pin' }] })),
    /needs machines/,
  )
  assert.throws(
    () => loadWithKeyEnv(
      serviceConfig({ services: [{ id: 's', label: 'x', workers: ['worker-1'], placement: 'spread', machines: ['m1'] }] }),
    ),
    /only meaningful with placement/,
  )
  const ok = loadWithKeyEnv(
    serviceConfig({ services: [{ id: 's', label: 'x', workers: ['worker-1'], placement: 'pin', machines: ['m1'] }] }),
  )
  assert.equal(ok.services?.[0]?.placement, 'pin')
})

test('服务声明: pin 装不下声明的 agent 数 = fail-loud', () => {
  assert.throws(
    () =>
      loadWithKeyEnv(
        serviceConfig({
          services: [{ id: 's', label: 'x', workers: ['worker-1'], placement: 'pin', machines: ['m1'], count: 5, max_agents_per_machine: 4 }],
        }),
      ),
    /cannot fit on 1 pinned machine/,
  )
})

test('服务声明: count 与 workers 数不符 = fail-loud（自动新建尚未实现，别静默少配）', () => {
  assert.throws(
    () => loadWithKeyEnv(serviceConfig({ services: [{ id: 's', label: 'x', workers: ['worker-1'], count: 3 }] })),
    /Automatic agent provisioning is not implemented yet/,
  )
})
