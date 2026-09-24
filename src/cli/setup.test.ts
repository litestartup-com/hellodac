import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { buildManagerConfig, adoptOldWorkspaces, checkPortFree, ensureNodeCredentials, ensureNodeProfiles, mergeEnv, parseArgs, probeToolVersions, profileInstallCommand, resolveGatewayKey, setupEnvValues } from './setup.js'
import { COMPAT_DSH_VERSION, GATEWAY_REF, dshCompatible } from '../dsh-version.js'

test('buildManagerConfig wires two managed nodes, agents, sandbox and presets', () => {
  const config = buildManagerConfig({
    personalWorkspace: 'C:/ws/personal',
    brainWorkspace: 'C:/ws/brain',
    personalPort: 3081,
    brainPort: 3082,
    dshBin: 'C:/nvm4w/nodejs/node_modules/@deepseek-ai/dsh/lib/bin.js',
    personalProfile: 'dac-personal',
    brainProfile: 'dac-brain',
    personalHome: 'C:/Users/me/.dac/dac-personal',
    brainHome: 'C:/Users/me/.dac/dac-brain',
    brainToken: 'brain-token-1',
  })
  const ep = config.endpoints as Record<string, Record<string, unknown>>
  const spawn = (id: string) => (ep[id]?.spawn ?? {}) as Record<string, unknown>
  assert.equal(ep['personal']?.url, 'http://127.0.0.1:3081')
  assert.equal(ep['brain']?.url, 'http://127.0.0.1:3082')
  assert.deepEqual(spawn('brain').args, ['C:/nvm4w/nodejs/node_modules/@deepseek-ai/dsh/lib/bin.js', '--profile', 'dac-brain', '--no-open'])
  assert.deepEqual(spawn('personal').env, { DSH_HOME: 'C:/Users/me/.dac/dac-personal' })
  // 主脑节点进程必须拿到 BRAIN_TOKEN，技能手册里的 curl 才能过内部 API 的门
  assert.deepEqual(spawn('brain').env, {
    DSH_HOME: 'C:/Users/me/.dac/dac-brain',
    BRAIN_TOKEN: 'brain-token-1',
  })
  // 每节点独立 gateway 密钥（分 ref 引用）
  assert.equal(ep['personal']?.sandbox_key_ref, 'GW_KEY_A')
  assert.equal(ep['brain']?.sandbox_key_ref, 'GW_KEY_B')
  const agents = config.agents as Record<string, Record<string, unknown>>
  assert.equal(agents['personal']?.preset, 'standard')
  assert.equal(agents['personal']?.sandbox_mode, 'workspace-write')
  assert.equal(agents['brain']?.endpoint, 'brain')
  // 蜂群 P5.1：主脑日派工预算熔断随 setup 默认开启
  const brain = config.brain as Record<string, unknown>
  assert.equal(brain['daily_budget_usd'], 1.0)
})

test('ensureNodeProfiles writes one isolated DSH_HOME per node, idempotently', () => {
  const nodesHome = mkdtempSync(join(tmpdir(), 'setup-nodes-home-'))
  try {
    const specs = [
      { name: 'dac-personal', port: 3081 },
      { name: 'dac-brain', port: 3082 },
    ]
    const created = ensureNodeProfiles(nodesHome, specs, GATEWAY_REF)
    assert.deepEqual(created.sort(), [join(nodesHome, 'dac-personal'), join(nodesHome, 'dac-brain')].sort())
    for (const spec of specs) {
      const dir = join(nodesHome, spec.name, 'profiles', spec.name)
      const patch = parseYaml(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')) as Array<{ id: string; config: { port: number; host: string } }>
      assert.equal(patch[0]?.id, 'webserver')
      assert.equal(patch[0]?.config.port, spec.port)
      assert.equal(patch[0]?.config.host, '127.0.0.1')
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        dsh: { profile: { bundles: string[] } }
        dependencies: Record<string, string>
      }
      assert.ok(pkg.dsh.profile.bundles.includes('ohdsh-api-facade'))
      assert.equal(pkg.dependencies['ohdsh-api-facade'], GATEWAY_REF, 'gateway 引用钉死 commit，不再追 master')
      // 蜂群2计划 P1：bundle 钉版本 = COMPAT_DSH_VERSION，根治安装漂移
      assert.equal(pkg.dependencies['@deepseek-ai/dsh-base'], COMPAT_DSH_VERSION)
      assert.equal(pkg.dependencies['@deepseek-ai/dsh-web-app'], COMPAT_DSH_VERSION)
      // pnpm ≥10 构建脚本白名单（镜像构建实测撞过 ERR_PNPM_IGNORED_BUILDS）
      const workspace = readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')
      assert.ok(workspace.includes('onlyBuiltDependencies:'), '必须声明构建脚本白名单')
      assert.ok(workspace.includes('node-pty') && workspace.includes('koffi'), '原生依赖必须在白名单内')
    }
    // 幂等：第二次不重建、不报错
    assert.deepEqual(ensureNodeProfiles(nodesHome, specs, GATEWAY_REF), [])
  } finally {
    rmSync(nodesHome, { recursive: true, force: true })
  }
})

test('ensureNodeProfiles writes a file: dependency when given a local gateway path', () => {
  const nodesHome = mkdtempSync(join(tmpdir(), 'setup-nodes-home-local-'))
  try {
    ensureNodeProfiles(nodesHome, [{ name: 'dac-personal', port: 3081 }], 'file:C:/src/dsh-api-gateway')
    const pkg = JSON.parse(readFileSync(join(nodesHome, 'dac-personal', 'profiles', 'dac-personal', 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    assert.equal(pkg.dependencies['ohdsh-api-facade'], 'file:C:/src/dsh-api-gateway')
  } finally {
    rmSync(nodesHome, { recursive: true, force: true })
  }
})

test('ensureNodeCredentials copies the model key once, never overwriting', () => {
  const root = mkdtempSync(join(tmpdir(), 'setup-cred-'))
  const main = join(root, 'main')
  const node = join(root, 'node')
  try {
    mkdirSync(main, { recursive: true })
    writeFileSync(join(main, '.credentials.yaml'), 'provider: x\n', 'utf8')
    assert.equal(ensureNodeCredentials(main, node), true)
    assert.equal(readFileSync(join(node, '.credentials.yaml'), 'utf8'), 'provider: x\n')
    // 已有凭据不覆盖
    writeFileSync(join(node, '.credentials.yaml'), 'provider: mine\n', 'utf8')
    assert.equal(ensureNodeCredentials(main, node), false)
    assert.equal(readFileSync(join(node, '.credentials.yaml'), 'utf8'), 'provider: mine\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolveGatewayKey reuses the provisioned key, else mints and appends apiKeys（facade 命名空间）', () => {
  const home = mkdtempSync(join(tmpdir(), 'setup-key-'))
  const settings = join(home, 'settings.yaml')
  try {
    writeFileSync(settings, stringifyYaml({ 'ohdsh-api-facade': { enabled: true, provisionedKey: 'apigw-existing' } }), 'utf8')
    assert.equal(resolveGatewayKey(home, settings), 'apigw-existing')

    rmSync(settings)
    const minted = resolveGatewayKey(home, settings)
    assert.match(minted, /^apigw-[0-9a-f]{48}$/)
    const parsed = parseYaml(readFileSync(settings, 'utf8')) as { 'ohdsh-api-facade': { apiKeys: string[] } }
    assert.deepEqual(parsed['ohdsh-api-facade'].apiKeys, [minted])
    // 旧命名空间的钥匙不被新 facade 读取（容器路径同款坑回归）
    writeFileSync(settings, stringifyYaml({ 'dsh-api-gw': { provisionedKey: 'apigw-stale' } }), 'utf8')
    const fresh = resolveGatewayKey(home, settings)
    assert.notEqual(fresh, 'apigw-stale', 'dsh-api-gw 段对 0.1.2 facade 无效，必须重新铸钥')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('parseArgs: npm run setup --force is recognised via npm_config_force (npm swallows the flag)', () => {
  const saved = process.env.npm_config_force
  try {
    process.env.npm_config_force = 'true'
    assert.equal(parseArgs([]).options.force, true)
    delete process.env.npm_config_force
    assert.equal(parseArgs([]).options.force, false)
    assert.equal(parseArgs(['--force']).options.force, true)
  } finally {
    if (saved === undefined) delete process.env.npm_config_force
    else process.env.npm_config_force = saved
  }
})

test('蜂群2计划 P1: parseArgs recognises --skip-version-check', () => {
  assert.equal(parseArgs([]).options.skipVersionCheck, false)
  assert.equal(parseArgs(['--skip-version-check']).options.skipVersionCheck, true)
})

test('蜂群2计划 P1: dshCompatible compares against the pinned version', () => {
  assert.equal(dshCompatible(COMPAT_DSH_VERSION), true)
  assert.equal(dshCompatible(`v${COMPAT_DSH_VERSION}`), true)
  assert.equal(dshCompatible('0.1.1-rc.3'), false)
  assert.equal(dshCompatible(null), false)
})

test('蜂群2计划 P1: checkPortFree reports occupation truthfully', async () => {
  // 先占一个随机端口
  const net = await import('node:net')
  const blocker = net.createServer()
  await new Promise<void>((resolveListen) => blocker.listen(0, '127.0.0.1', resolveListen))
  const address = blocker.address()
  assert.ok(address !== null && typeof address === 'object')
  const port = address.port
  try {
    assert.equal(await checkPortFree(port), false, '有进程监听的端口必须判占用')
  } finally {
    await new Promise<void>((resolveClose) => blocker.close(() => resolveClose()))
  }
  assert.equal(await checkPortFree(port), true, '释放后的端口必须判空闲')
})

test('蜂群2计划 P1: probeToolVersions reports node and marks missing dsh as null', () => {
  const tools = probeToolVersions(null)
  assert.ok(tools.node !== null, 'node 是跑测试的前提，必然存在')
  assert.match(tools.node, /^v?\d+\./)
  assert.equal(tools.dsh, null)
})

test('蜂群2计划 P6 回归: Windows 上 pnpm 探测必须穿透 .CMD 垫片（node≥20 无 shell 直接 EINVAL/ENOENT）', { skip: process.platform !== 'win32' }, () => {
  const tools = probeToolVersions(null)
  assert.ok(tools.pnpm !== null, 'pnpm 已装且探针必须找得到——发布实测：旧探针报 EINVAL 导致 setup 自检假红')
  assert.match(tools.pnpm, /^\d+\.\d+\.\d+$/)
})

test('0.1.2 切主路回归: 节点依赖改 npm——pnpm9 预发布区间失效、pnpm11 白名单失效（容器双墙实证）', () => {
  const win = profileInstallCommand('win32')
  assert.equal(win.cmd, 'npm')
  assert.deepEqual(win.args, ['install', '--no-audit', '--no-fund'])
  const posix = profileInstallCommand('linux')
  assert.equal(posix.cmd, 'npm')
  assert.deepEqual(posix.args, ['install', '--no-audit', '--no-fund'])
})

test('蜂群2计划 P6 回归: setup 必须预生成首启密码进 .env（manager 隐藏窗口启动，生成密码会丢）', () => {
  const values = setupEnvValues('apigw-a', 'apigw-b')
  assert.equal(values.GW_KEY_A, 'apigw-a')
  assert.equal(values.GW_KEY_B, 'apigw-b')
  assert.match(values.SESSION_SECRET, /^[0-9a-f]{64}$/)
  assert.match(values.BRAIN_TOKEN, /^[0-9a-f]{48}$/)
  assert.match(values.MANAGER_INITIAL_PASSWORD, /^[A-Za-z0-9_-]{22}$/, '16 字节 base64url')
})

test('adoptOldWorkspaces keeps user-customised workspaces unless explicitly overridden', () => {  const options = { personalWorkspace: './workspaces/personal', brainWorkspace: './workspaces/brain' }
  const old = { agents: { personal: { workspace: 'C:/Workplace/gitee/note-kaka' }, brain: { workspace: 'D:/brain' } } }

  adoptOldWorkspaces(old, { personalWorkspace: false, brainWorkspace: false }, options)
  assert.equal(options.personalWorkspace, 'C:/Workplace/gitee/note-kaka')
  assert.equal(options.brainWorkspace, 'D:/brain')

  // 显式传参优先：--workspace 指了新的，旧值让路
  const explicit = { personalWorkspace: './new-one', brainWorkspace: './workspaces/brain' }
  adoptOldWorkspaces(old, { personalWorkspace: true, brainWorkspace: false }, explicit)
  assert.equal(explicit.personalWorkspace, './new-one')
  assert.equal(explicit.brainWorkspace, 'D:/brain')

  // 旧配置缺字段/损坏：不动现状
  const untouched = { personalWorkspace: 'a', brainWorkspace: 'b' }
  adoptOldWorkspaces({ agents: {} }, { personalWorkspace: false, brainWorkspace: false }, untouched)
  assert.deepEqual(untouched, { personalWorkspace: 'a', brainWorkspace: 'b' })
})

test('mergeEnv fills missing values and never overwrites existing ones', () => {
  const dir = mkdtempSync(join(tmpdir(), 'setup-env-'))
  const env = join(dir, '.env')
  try {
    const merged = mergeEnv(env, { SESSION_SECRET: 'new-secret', GW_KEY_A: 'new-key' })
    assert.equal(merged.SESSION_SECRET, 'new-secret')

    const again = mergeEnv(env, { SESSION_SECRET: 'other', BRAIN_TOKEN: 'token-1' })
    assert.equal(again.SESSION_SECRET, 'new-secret', 'existing value survives')
    assert.equal(again.BRAIN_TOKEN, 'token-1')
    assert.ok(existsSync(env))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('mergeEnv forceKeys overrides stale values (setup-owned secrets must match node settings)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'setup-env-force-'))
  const env = join(dir, '.env')
  try {
    mergeEnv(env, { GW_KEY_A: 'old-key', GW_KEY_B: 'old-b' })
    const again = mergeEnv(env, { GW_KEY_A: 'new-key', GW_KEY_B: 'new-b', SESSION_SECRET: 's' }, ['GW_KEY_A', 'GW_KEY_B'])
    assert.equal(again.GW_KEY_A, 'new-key')
    assert.equal(again.GW_KEY_B, 'new-b')
    assert.equal(again.SESSION_SECRET, 's')
    // 非 force 键仍是旧值优先
    const third = mergeEnv(env, { SESSION_SECRET: 'later' }, ['GW_KEY_A', 'GW_KEY_B'])
    assert.equal(third.SESSION_SECRET, 's')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
