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
  agents: { personal: { name: 'Personal', endpoint: 'A', workspace: '.' } },
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

test('Debt A5 regression: loadConfig returns the resolved truth-source paths -- one source for the whole project', () => {
  const dir = mkdtempSync(join(tmpdir(), 'manager-config-test-'))
  try {
    const file = join(dir, 'config.yaml')
    writeFileSync(file, stringify(baseConfig()), 'utf8')
    const cfg = loadConfig(file)
    assert.equal(cfg.configPath, resolve(file), 'configPath must be the resolved absolute path')
    assert.equal(cfg.envPath, resolve('.env'), 'envPath must be an absolute path (the canonical location of .env)')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Debt E12 regression: the agent.validate governance rules parse, and their defaults', () => {
  withEnv({}, () => {
    const withRules = loadFrom(baseConfig({
      agents: {
        personal: {
          name: 'Personal',
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

    // The default = null (the caller goes through DEFAULT_RULES: the generic credential check only, inheriting no business rules)
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
        personal: { name: 'Personal', endpoint: 'A', workspace: '.', preset: 'standard', sandbox_mode: 'workspace-write' },
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

test('Debt P1 regression: the endpoint.access tunnel metadata parses, and its defaults (unconfigured = no capability)', () => {
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

  // access unconfigured = null (the nodes page shows no "open the native GUI")
  const bare = loadFrom(baseConfig())
  assert.equal(bare.endpoints['A']?.access, null)
})

test('Debt P1 regression: the access default ports (ssh 22 / gui 3080) and the rejection of illegal values', () => {
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
          access: { ssh_user: 'ubuntu', ssh_host: '10.0.0.5' }, // local_port missing
        },
      },
    })),
    /local_port/,
  )
})

test('Debt P3 regression: spawn.dsh_version / gateway_ref resolve as per-node pins (the default = null, following the global default)', () => {
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
  assert.equal(defaults.endpoints['A']?.spawn?.dshVersion ?? null, null, 'a null default = follow the global default')
  assert.equal(defaults.endpoints['A']?.spawn?.gatewayRef ?? null, null)
})

test('Capability four regression: runner=agent + host resolve -- the Fleet remote node shape (no local command; the agent side uses the bin from its own prefix)', () => {
  const cfg = loadFrom(baseConfig({
    endpoints: {
      A: {
        url: 'http://10.0.0.7:3081',
        driver: 'apiproxy',
        spawn: { managed: true, runner: 'agent', host: 'agent-abc123', env: { DSH_HOME: '/home/dac-node/.dac/ops01' } },
      },
    },
    agents: { personal: { name: 'Personal', endpoint: 'A', workspace: '/home/dac-node/ws' } },
  }))
  const spawn = cfg.endpoints['A']?.spawn
  assert.equal(spawn?.runner, 'agent')
  assert.equal(spawn?.host, 'agent-abc123', 'host = the agent id that runs this node')
  assert.equal(spawn?.command, '', 'the agent shape does not require a local command')
  assert.equal(spawn?.docker, null, 'the agent shape has no docker section')
})

test('Capability four regression: runner=agent without host is rejected; host on a non-agent shape is rejected (where it runs and its shape have to agree)', () => {
  assert.throws(
    () => loadFrom(baseConfig({
      endpoints: { A: { url: 'http://10.0.0.7:3081', driver: 'apiproxy', spawn: { managed: true, runner: 'agent' } } },
    })),
    /host/,
    'agent without host = fail-loud',
  )
  assert.throws(
    () => loadFrom(baseConfig({
      endpoints: { A: { url: 'http://127.0.0.1:3080', driver: 'apiproxy', spawn: { managed: true, command: 'node', host: 'agent-x' } } },
    })),
    /host/,
    'process with host = rejected (against wiring drift)',
  )
})

test('agent sandbox_mode without endpoint sandbox_base fails loud at boot', () => {
  assert.throws(
    () => loadFrom(baseConfig({
      agents: { personal: { name: 'Personal', endpoint: 'A', workspace: '.', sandbox_mode: 'read-only' } },
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

test('Hive P5.1: brain daily budget defaults off and parses when set', () => {
  assert.equal(loadFrom(baseConfig()).brainDailyBudgetMicroUsd, null)
  const capped = loadFrom(baseConfig({ brain: { daily_budget_usd: 1.5 } }))
  assert.equal(capped.brainDailyBudgetMicroUsd, 1_500_000)
})

test('v1.0.3: apiproxy prefix — explicit config wins, legacy default only when omitted', () => {
  // An old config (an explicit /api) and one that omits prefix behave unchanged.
  const legacyExplicit = loadFrom(baseConfig({
    endpoints: { A: { url: 'http://127.0.0.1:3080', driver: 'apiproxy', prefix: '/api' } },
  }))
  assert.equal(legacyExplicit.endpoints['A']?.prefix, '/api')
  const legacyOmitted = loadFrom(baseConfig())
  assert.equal(legacyOmitted.endpoints['A']?.prefix, '/api', 'an omitted prefix keeps the old 0.1.1 default')
  // The new 0.1.2 line: a prefix pointing explicitly at the gateway facade is no longer overridden by the pin.
  const facade = loadFrom(baseConfig({
    endpoints: { A: { url: 'http://127.0.0.1:3091', driver: 'apiproxy', prefix: '/api-gw/v1/proxy' } },
  }))
  assert.equal(facade.endpoints['A']?.prefix, '/api-gw/v1/proxy')
  // The gateway driver's prefix behaves as before (explicit wins).
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

test('Hive plan 2 P2: spawn.runner defaults to process; the docker runner resolves its spec', () => {
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
  assert.equal(spawn.command, '', 'the docker runner needs no command')
  assert.equal(spawn.docker?.image, 'hellodac/dac-node:0.1.1-rc.2')
  assert.equal(spawn.docker?.containerName, null)
  assert.equal(spawn.docker?.network, 'hive')
  assert.equal(spawn.docker?.port, 3081)
  assert.deepEqual(spawn.docker?.hostVolumes, { '/opt/dac/workspaces/personal': '/workspace' })
  assert.deepEqual(spawn.docker?.namedVolumes, { 'dac-personal': '/data' })
})

test('Hive plan 2 P2: runner=docker without a docker block fails loud', () => {
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

test('Hive plan 2 P2: a process spawn keeps resolving with runner=process and docker=null', () => {
  const cfg = loadFrom(baseConfig({
    endpoints: {
      A: { url: 'http://127.0.0.1:3080', driver: 'apiproxy', spawn: { managed: true, command: 'node' } },
    },
  }))
  assert.equal(cfg.endpoints['A']?.spawn?.runner, 'process')
  assert.equal(cfg.endpoints['A']?.spawn?.docker, null)
})

test('Hive plan 2 P5: the container example config shipped with the repo must always pass the schema (install.sh depends on it)', () => {
  const example = join(dirname(fileURLToPath(import.meta.url)), '..', 'manager.config.container.example.yaml')
  withEnv({ GW_KEY_A: 'apigw-a', GW_KEY_B: 'apigw-b' }, () => {
    const cfg = loadConfig(example)
    const brain = cfg.endpoints['brain']
    const personal = cfg.endpoints['personal']
    assert.ok(brain !== undefined && personal !== undefined)
    assert.equal(brain.spawn, null, 'the brain is declared by compose (the spine, unmanaged)')
    assert.equal(personal.spawn?.runner, 'docker')
    assert.equal(personal.spawn?.docker?.image, 'hellodac/dac-node:0.1.5-rc.2')
    assert.equal(personal.spawn?.docker?.network, 'dac-hive', 'the same as the explicit network name in compose')
    // The two views of the workspace path are unified: the path inside the node container = the path as the manager sees it (the root cause of the EACCES mkdir, as a regression)
    assert.equal(personal.spawn?.docker?.hostVolumes['/opt/dac/workspaces/personal'], '/opt/dac/workspaces/personal')
    assert.deepEqual(cfg.backupDockerVolumes, ['dac-brain'], 'the spine brain volume enters the backup declaration')
    assert.equal(cfg.backupAuto, false, 'automatic backup is off by default (the lesson from a small disk in production)')
    assert.equal(cfg.agents['brain']?.sandboxMode, 'workspace-write')
  })
})

test('Production disk lesson regression: backup.auto is off by default, and only an explicit true enables automatic backup; interval_minutes is adjustable', () => {
  const bare = loadFrom(baseConfig())
  assert.equal(bare.backupAuto, false, 'the default = off')
  assert.equal(bare.backupIntervalMs, 15 * 60_000, 'the default interval is 15 minutes')

  const on = loadFrom(baseConfig({ backup: { auto: true } }))
  assert.equal(on.backupAuto, true, 'explicitly enabled')

  const daily = loadFrom(baseConfig({ backup: { auto: true, interval_minutes: 1440 } }))
  assert.equal(daily.backupIntervalMs, 1440 * 60_000, 'on a small production disk it can be relaxed to daily')

  const off = loadFrom(baseConfig({ backup: { docker_volumes: ['x'] } }))
  assert.equal(off.backupAuto, false, 'configuring docker_volumes alone does not change the off default')
})

test('P0 regression: loadConfig migrates an old config automatically -- the migration warning is visible, the file is written back with a version stamp, and the original is backed up', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mig-load-'))
  try {
    const file = join(dir, 'config.yaml')
    writeFileSync(file, stringify(baseConfig()), 'utf8')
    const cfg = loadConfig(file)
    assert.ok(cfg.warnings.some((w) => w.includes('migrated from version 0 to 1')), 'the migration note enters config.warnings (visible in the boot log)')
    assert.match(readFileSync(file, 'utf8'), /config_version: 1/, 'the version stamp is written back')
    assert.ok(existsSync(`${file}.pre-mig.bak`), 'the original file is backed up')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P0 regression: a future-version config fails loud (the config comes from a newer manager, and guessing is refused)', () => {
  assert.throws(() => loadFrom(baseConfig({ config_version: 99 })), /newer than the supported/)
})

/**
 * The "service" definition of the outward API (the position in the internal design library `manager/topics/CONCEPTS-ALIGNED.md`).
 *
 * The fixture uses the **real shape of a production node**: the apiproxy driver + the facade proxy prefix + that node's own
 * gateway key (`driver: gateway` is already a dead path, see facts/dsh-facts.md section 15 -- the historical fixture
 * used exactly that dead path, which would mislead whoever comes next).
 *
 * A service member must be a public agent and, per the position in section 1, **each holds its own process**: a member left unmarked
 * public would silently become "a service nobody can get into", the hardest kind of fault to track down, so it fails loud.
 */
/**
 * The model pin an outward agent needs (provider + model, paired, and priced). A fixture for a
 * public agent that omits it describes a config the loader rejects, so the pin belongs in the
 * helper rather than in each test.
 */
const PUBLIC_PIN = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }

const serviceConfig = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  listen: { host: '127.0.0.1', port: 8080 },
  endpoints: {
    W: { url: 'http://127.0.0.1:3090', driver: 'apiproxy', prefix: '/api-gw/v1/proxy', key_ref: 'GW_KEY_TEST' },
  },
  // The pin is part of the real shape too: an outward agent must declare provider + model (see the
  // model-pinning rule in config.ts) so every turn can be accounted for on the cost ledger.
  agents: { 'worker-1': { name: 'Support one', endpoint: 'W', workspace: '.', public: true, ...PUBLIC_PIN } },
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

test('position: one endpoint carries one agent only (two agents on the same endpoint = fail-loud)', () => {
  const shared = baseConfig({
    agents: {
      a: { name: 'a', endpoint: 'A', workspace: '.' },
      b: { name: 'b', endpoint: 'A', workspace: '.' },
    },
  })
  assert.throws(() => loadFrom(shared), /shared by 2 agents/)
})

test('position: an outward agent may live on an apiproxy endpoint (an exclusive process is enough; the driver name no longer matters)', () => {
  // The historical red line was "no public agent on apiproxy", which pushed users toward gateway endpoints -- and that path
  // no longer exists on facade 0.2.x. The real constraint is an exclusive process (the previous case already covers it).
  const cfg = loadFrom(
    baseConfig({
      agents: { pub: { name: 'Outward', endpoint: 'A', workspace: '.', public: true, ...PUBLIC_PIN } },
    }),
  )
  assert.equal(cfg.agents['pub']?.public, true)
})

/**
 * Model pinning (2026-09-28, outward cost was uncomputable): the apiproxy wire passes no
 * provider/model to session.create, so the manager has to *land* a pin on the host session and read
 * back what the host confirms. Three ways to get that wrong are refused here, at config time, rather
 * than surfacing as a null cost on the ledger later.
 */
test('model pinning: an outward agent with no pin is refused (nothing to land, nothing to read back)', () => {
  const noPin = baseConfig({
    agents: { pub: { name: 'Outward', endpoint: 'A', workspace: '.', public: true } },
  })
  assert.throws(() => loadFrom(noPin), /public but pins no model/)
})

test('model pinning: half a pin is refused (session.selectModel needs both, the host would keep its default)', () => {
  const onlyModel = baseConfig({
    agents: { personal: { name: 'Personal', endpoint: 'A', workspace: '.', model: 'deepseek-v4-flash' } },
  })
  assert.throws(() => loadFrom(onlyModel), /provider and model must be set together/)
  const onlyProvider = baseConfig({
    agents: { personal: { name: 'Personal', endpoint: 'A', workspace: '.', provider: 'deepseek-official' } },
  })
  assert.throws(() => loadFrom(onlyProvider), /provider and model must be set together/)
})

test('model pinning: an unpriced model on an outward agent is refused (that would wire in a null cost)', () => {
  const unpriced = baseConfig({
    agents: {
      pub: { name: 'Outward', endpoint: 'A', workspace: '.', public: true, provider: 'deepseek-official', model: 'an-unreleased-snapshot' },
    },
  })
  assert.throws(() => loadFrom(unpriced), /no rate for it/)
})

test('model pinning: an internal agent may stay unpinned (the host default stands, and that is a legal choice)', () => {
  const internal = baseConfig({
    agents: { personal: { name: 'Personal', endpoint: 'A', workspace: '.', public: false } },
  })
  const cfg = loadFrom(internal)
  assert.equal(cfg.agents['personal']?.provider, null)
  assert.equal(cfg.agents['personal']?.model, null)
})


/**
 * Machine-level isolation (the third boundary in section 4.5 of the position; the user confirmed on 2026-09-27 that "the config layer blocks it hard too").
 * A machine = `spawn.host` (remote) or `local` (this machine): agents on one machine share the same OS user,
 * and DSH does not isolate file reads, so "an exclusive process" alone is not enough.
 */
const onMachine = (ids: string[], host: string, publicIds: string[] = []): Record<string, unknown> =>
  baseConfig({
    endpoints: Object.fromEntries(
      ids.map((id) => [id, { url: `http://10.0.0.5:${3100 + ids.indexOf(id)}`, driver: 'apiproxy', spawn: { managed: true, runner: 'agent', host } }]),
    ),
    agents: Object.fromEntries(
      ids.map((id) => [
        id,
        {
          name: id,
          endpoint: id,
          workspace: `/srv/ws-${id}`,
          public: publicIds.includes(id),
          // An outward agent carries the model pin these tests are not about; without it the
          // fixture is a config the loader rejects and the isolation rule under test never runs.
          ...(publicIds.includes(id) ? PUBLIC_PIN : {}),
        },
      ]),
    ),
  })

test('machine isolation: one machine with both an outward and an internal agent = fail-loud', () => {
  const mixed = onMachine(['srv-a', 'srv-b'], 'box-1', ['srv-a'])
  assert.throws(() => loadFrom(mixed), /hosts both outward agents/)
})

test('machine isolation: two agents of different outward services on one machine = fail-loud (a cross-service injection surface)', () => {
  const twoServices = onMachine(['srv-a', 'srv-b'], 'box-1', ['srv-a', 'srv-b'])
  const cfg = { ...twoServices, services: [
    { id: 'support', label: 'Support', workers: ['srv-a'] },
    { id: 'report', label: 'Reports', workers: ['srv-b'] },
  ] }
  assert.throws(() => loadFrom(cfg), /serves 2 different services/)
})

test('machine isolation: several agents of the same service on one machine = allowed (spread only tries to avoid it, it does not forbid it)', () => {
  const sameService = onMachine(['srv-a', 'srv-b'], 'box-1', ['srv-a', 'srv-b'])
  const cfg = { ...sameService, services: [
    { id: 'support', label: 'Support', workers: ['srv-a', 'srv-b'], count: 2 },
  ] }
  assert.equal(loadFrom(cfg).services?.[0]?.workers.length, 2)
})

test('machine isolation: several internal agents on one machine = allowed (the production shape: spike02/ops33 on the same machine at 33.11)', () => {
  const internal = onMachine(['spike02', 'ops33'], 'agent-002cf073615f')
  assert.deepEqual(Object.keys(loadFrom(internal).agents), ['spike02', 'ops33'])
})

test('machine isolation: it applies to this machine too (no spawn.host)', () => {
  const local = baseConfig({
    endpoints: {
      L1: { url: 'http://127.0.0.1:3190', driver: 'apiproxy' },
      L2: { url: 'http://127.0.0.1:3191', driver: 'apiproxy' },
    },
    agents: {
      inside: { name: 'inside', endpoint: 'L1', workspace: '.' },
      outside: { name: 'outside', endpoint: 'L2', workspace: '.', public: true, ...PUBLIC_PIN },
    },
  })
  assert.throws(() => loadFrom(local), /machine "local" hosts both outward agents/)
})

/**
 * A remote workspace is passed through verbatim (a real incident on 2026-09-28): the manager is on Windows and the node on Linux,
 * so `resolve('/home/dac/ws')` turns into `C:\home\dac\ws`, and session.create on the node side rejects it outright
 * (cwd must be an absolute path). The strange `C:\root\...\spike02` directory left on that Linux machine
 * that year is a fossil of this bug.
 */
test('remote workspace: a runner=agent path is passed through verbatim in that machine namespace, with no local resolution', () => {
  const cfg = loadFrom(
    baseConfig({
      endpoints: {
        R: { url: 'http://10.0.0.5:3201', driver: 'apiproxy', spawn: { managed: true, runner: 'agent', host: 'box-1' } },
      },
      agents: { remote: { name: 'remote', endpoint: 'R', workspace: '/home/dac/workspaces/chat' } },
    }),
  )
  assert.equal(cfg.agents['remote']?.workspacePath, '/home/dac/workspaces/chat')

  // A local node is still resolved against the manager's own filesystem (a relative path is meaningful there)
  const local = loadFrom(baseConfig({ agents: { here: { name: 'here', endpoint: 'A', workspace: 'sub/dir' } } }))
  assert.equal(local.agents['here']?.workspacePath, resolve('sub/dir'))
})

test('remote workspace: a relative path fails loud (a remote has no "current directory" to refer to)', () => {
  const relative = baseConfig({
    endpoints: {
      R: { url: 'http://10.0.0.5:3201', driver: 'apiproxy', spawn: { managed: true, runner: 'agent', host: 'box-1' } },
    },
    agents: { remote: { name: 'remote', endpoint: 'R', workspace: 'workspaces/chat' } },
  })
  assert.throws(() => loadFrom(relative), /must be an absolute path on the remote machine/)
})

test('dead-path warning: a driver: gateway endpoint must warn (facade 0.2.x has no chat REST surface)', () => {
  const legacy = baseConfig({
    endpoints: { G: { url: 'http://127.0.0.1:3090', driver: 'gateway', key_ref: 'GW_KEY_TEST' } },
    agents: { g: { name: 'g', endpoint: 'G', workspace: '.' } },
  })
  const cfg = loadWithKeyEnv(legacy)
  assert.ok(
    cfg.warnings.some((w) => w.includes('gateway driver, which is a dead path')),
    'the gateway driver is half dead: liveness green, chats 404 -- the boot has to say so out loud',
  )
  const ok = loadFrom(baseConfig())
  assert.ok(!ok.warnings.some((w) => w.includes('dead path')), 'an apiproxy endpoint should not carry this warning')
})

test('outward API service: a member must be a public agent (a private member fails loud, not silently)', () => {
  const priv = serviceConfig({
    agents: { 'worker-1': { name: 'Support one', endpoint: 'W', workspace: '.', public: false } },
    services: [{ id: 'support', label: 'Support', workers: ['worker-1'] }],
  })
  assert.throws(() => loadWithKeyEnv(priv), /not public/)
})

test('outward API service: an unknown member / a duplicate service id / a non-absolute mount point all fail loud', () => {
  const good = serviceConfig({ services: [{ id: 'support', label: 'Support', workers: ['worker-1'] }] })
  assert.ok(loadWithKeyEnv(good).services)

  const ghost = serviceConfig({ services: [{ id: 'support', label: 'Support', workers: ['ghost'] }] })
  assert.throws(() => loadWithKeyEnv(ghost), /unknown worker/)

  const dup = serviceConfig({
    services: [
      { id: 'support', label: 'Support', workers: ['worker-1'] },
      { id: 'support', label: 'Duplicate', workers: ['worker-1'] },
    ],
  })
  assert.throws(() => loadWithKeyEnv(dup), /duplicate service/)

  const badMount = serviceConfig({
    services: [{ id: 'support', label: 'Support', workers: ['worker-1'], knowledge: [{ host: '/srv/kb', mount: 'kb' }] }],
  })
  assert.throws(() => loadWithKeyEnv(badMount), /absolute/)
})

test('outward API service: it parses normally (the default surface = both modes of address; the handbook is read-only by default) + the surface binds to this machine by default', () => {
  const cfg = loadWithKeyEnv(
    serviceConfig({
      services: [
        {
          id: 'support',
          label: 'Support',
          workers: ['worker-1'],
          surfaces: ['conversations'],
          knowledge: [{ host: '/srv/knowledge/faq', mount: '/knowledge' }],
        },
      ],
    }),
  )
  assert.deepEqual(cfg.publicApi, { enabled: true, host: '127.0.0.1', port: 8081 }, 'the surface binds to this machine by default')
  assert.equal(cfg.services?.length, 1)
  assert.equal(cfg.services[0]?.id, 'support')
  assert.deepEqual(cfg.services[0]?.surfaces, ['conversations'])
  assert.deepEqual(cfg.services[0]?.knowledge, [{ host: '/srv/knowledge/faq', mount: '/knowledge', readOnly: true }])

  const both = loadWithKeyEnv(serviceConfig({ services: [{ id: 's', label: 'x', workers: ['worker-1'] }] }))
  assert.deepEqual(both.services?.[0]?.surfaces, ['tasks', 'conversations'], 'both modes of address are on by default')
})

test('outward API: it is empty when no service is configured (equivalent to "there is no outward API right now"), and existing config is unaffected', () => {
  const cfg = loadFrom(baseConfig())
  assert.deepEqual(cfg.services, [])
  assert.equal(cfg.publicApi?.enabled, true)
})

test('outward API: a surface port identical to the admin port = fail-loud (otherwise the surface can never come up)', () => {
  const clash = serviceConfig({ public_api: { port: 8080 }, services: [{ id: 's', label: 'x', workers: ['worker-1'] }] })
  assert.throws(() => loadWithKeyEnv(clash), /same as listen\.port/)
})


/**
 * The per-service scheduling declaration (section 8 of the position): the expected agent count / concurrency per agent / permission tier / chat reclaim duration /
 * placement policy defaults, and the illegal combinations, must fail loud.
 */
test('service declaration: the defaults (1 agent - 4 concurrent per agent - spread - 4 per machine - read-only - reclaimed after 24 hours)', () => {
  const cfg = loadWithKeyEnv(serviceConfig({ services: [{ id: 'support', label: 'Support', workers: ['worker-1'] }] }))
  const svc = cfg.services?.[0]
  assert.equal(svc?.count, 1)
  assert.equal(svc?.maxSessionsPerAgent, 4)
  assert.equal(svc?.permission, 'read', 'an outward agent is read-only by default')
  assert.equal(svc?.sessionIdleHours, 24, 'an idle chat is reclaimed after 24 hours by default')
  assert.equal(svc?.placement, 'spread')
  assert.deepEqual(svc?.machines, [])
  assert.equal(svc?.maxAgentsPerMachine, 4)
})

test('service declaration: the expected agent count is called count (the old name agents must error, and cannot be dropped silently)', () => {
  const renamed = loadWithKeyEnv(
    serviceConfig({ services: [{ id: 's', label: 'x', workers: ['worker-1'], count: 1 }] }),
  )
  assert.equal(renamed.services?.[0]?.count, 1)

  const stale = serviceConfig({ services: [{ id: 's', label: 'x', workers: ['worker-1'], agents: 1 }] })
  assert.throws(() => loadWithKeyEnv(stale), /agents/, 'a stale old field left by the rename must error: dropping it silently = silently under-provisioning')
})

test('service declaration: the permission tier is read-only by default, may be write, and forbids full', () => {
  const write = loadWithKeyEnv(
    serviceConfig({ services: [{ id: 's', label: 'x', workers: ['worker-1'], permission: 'write' }] }),
  )
  assert.equal(write.services?.[0]?.permission, 'write')

  const full = serviceConfig({ services: [{ id: 's', label: 'x', workers: ['worker-1'], permission: 'full' }] })
  assert.throws(() => loadWithKeyEnv(full), /permission/, 'outward traffic + full access = handing over the whole machine, which the schema layer should reject outright')
})

test('service declaration: the idle chat reclaim duration can be given when the service is created, and 0 or a negative fails loud', () => {
  const custom = loadWithKeyEnv(
    serviceConfig({ services: [{ id: 's', label: 'x', workers: ['worker-1'], session_idle_hours: 6 }] }),
  )
  assert.equal(custom.services?.[0]?.sessionIdleHours, 6)

  for (const bad of [0, -3]) {
    const cfg = serviceConfig({ services: [{ id: 's', label: 'x', workers: ['worker-1'], session_idle_hours: bad }] })
    assert.throws(() => loadWithKeyEnv(cfg), /session_idle_hours/)
  }
})

test('service declaration: the placement watermark thresholds can be overridden per service (the rest follow the global defaults), and an unknown key fails loud', () => {
  const def = loadWithKeyEnv(serviceConfig({ services: [{ id: 's', label: 'x', workers: ['worker-1'] }] }))
  assert.deepEqual(
    def.services?.[0]?.thresholds,
    { minFreeCpuPercent: 20, minFreeMemBytes: 1_500_000_000, minFreeDiskBytes: 5_000_000_000 },
    'no thresholds written = the global defaults as a floor (the placer always gets the complete set of three)',
  )

  // A real scenario: that machine at 33.11 has little memory but is meant to run outward agents -- lower only the memory
  // threshold to match it, and do not relax the global threshold for its sake (that would drag every service's placement decision with it).
  const tuned = loadWithKeyEnv(
    serviceConfig({
      services: [
        { id: 'chat', label: 'Support', workers: ['worker-1'], thresholds: { min_free_mem_bytes: 300_000_000 } },
      ],
    }),
  )
  assert.deepEqual(tuned.services?.[0]?.thresholds, {
    minFreeCpuPercent: 20,
    minFreeMemBytes: 300_000_000,
    minFreeDiskBytes: 5_000_000_000,
  })

  const typo = serviceConfig({
    services: [{ id: 's', label: 'x', workers: ['worker-1'], thresholds: { min_free_memory_bytes: 1 } }],
  })
  assert.throws(() => loadWithKeyEnv(typo), /thresholds/, 'a misspelled threshold key must error, and cannot be ignored silently')
})

test('service declaration: pin must be given machines; machines with a non-pin placement = fail-loud (not ignored silently)', () => {
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

test('service declaration: a pin that cannot fit the declared agent count = fail-loud', () => {
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

test('service declaration: a count that does not match the number of workers = fail-loud (automatic provisioning is not implemented yet, so do not silently under-provision)', () => {
  assert.throws(
    () => loadWithKeyEnv(serviceConfig({ services: [{ id: 's', label: 'x', workers: ['worker-1'], count: 3 }] })),
    /Automatic agent provisioning is not implemented yet/,
  )
})
