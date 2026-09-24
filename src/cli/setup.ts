import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import net from 'node:net'
import { pathToFileURL } from 'node:url'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { withConfigLock, writeFileAtomic } from '../config-store.js'
import type { ManagerConfigFile } from '../config.js'
import { initWorkspace } from '../workspace/init.js'
import { COMPAT_DSH_VERSION, DSH_INSTALL_COMMAND, GATEWAY_REF, dshCompatible } from '../dsh-version.js'
// 能力一（2026-09-20）：profile 生成/安装/钥匙/依赖命令已抽到 host-node 公共模块
// （setup 与 provision 共用）；本文件 import 自用 + re-export 保持既有导入面。
import { ensureNodeCredentials, ensureNodeProfiles, profileInstallCommand, resolveGatewayKey, type ProfileSpec } from '../host-node/profile.js'
export {
  ensureNodeProfiles, ensureNodeCredentials, profileFiles, profileInstallCommand,
  resolveGatewayKey, dshBinInProfile, PROFILE_BUNDLES, profileDependencies,
  type ProfileSpec,
} from '../host-node/profile.js'

/**
 * `npm run setup -- [选项]` — 蜂群 P4：默认安装。
 *
 * 一条命令把「单主机多节点」搭起来：
 *   1. 初始化个人与主脑两个工作区（模板幂等，绝不覆盖已有文件）
 *   2. 在 $DSH_HOME/profiles 下生成两个节点 profile（web 同款 bundle + 端口 patch）
 *   3. 解析 gateway 密钥（settings.yaml 的 provisionedKey，或生成并追加 apiKeys）
 *   4. 生成 .env（SESSION_SECRET / GW_KEY_A / BRAIN_TOKEN，幂等保留旧值）
 *   5. 生成 manager.config.yaml（两个托管节点 + 两个 agent + 沙箱/pre-set 全接）
 *
 * 前置：本机已装 DSH（$DSH_HOME 存在且有 credentials）、node / git 在 PATH
 * （节点依赖由 npx 临时拉取 pnpm@9，不要求全局 pnpm）。
 */

interface SetupOptions {
  personalWorkspace: string
  brainWorkspace: string
  personalPort: number
  brainPort: number
  /** 主 DSH_HOME（GUI/日常用），只用于取模型凭据副本。 */
  dshHome: string
  /** 节点目录根：每个节点一个独立 DSH_HOME，会话/settings/附件完全隔离。 */
  nodesHome: string
  dshBin: string | null
  installProfiles: boolean
  /** 本地 gateway 包路径（file: 依赖，离线安装）；null = 用钉死引用。 */
  gatewayLocal: string | null
  force: boolean
  /** 蜂群2计划 P1：DSH 版本不符时放行（显式声明风险自负）。 */
  skipVersionCheck: boolean
}

/** 解析 DSH 命令所在目录：优先 $DSH_BIN，其次 `where dsh` 的 .ps1 包装器。 */
export const detectDshBin = (dshHome: string, override: string | null): string => {
  const fromEnv = override ?? process.env.DSH_BIN ?? null
  if (fromEnv !== null && fromEnv !== '' && existsSync(fromEnv)) return resolve(fromEnv)

  if (process.platform === 'win32') {
    // Windows：`where dsh` 找到 npm 的 .ps1 垫片，真身在其旁的 node_modules 里
    try {
      const found = execFileSync('where', ['dsh'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l !== '')[0]
      if (found !== undefined && /\.ps1$/i.test(found)) {
        const candidate = join(dirname(found), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
        if (existsSync(candidate)) return resolve(candidate)
      }
    } catch {
      // `where` 找不到 dsh：继续按常见位置猜测
    }
  } else {
    // POSIX（蜂群2计划 P1 修复）：`command` 是 shell 内建，经 sh 执行；
    // 全局安装的 dsh 是软链，node 可直接跑，无需解析真身。
    try {
      const found = execFileSync('sh', ['-c', 'command -v dsh 2>/dev/null || true'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .trim()
        .split(/\r?\n/)[0]
      if (found !== undefined && found !== '' && existsSync(found)) return resolve(found)
    } catch {
      // 继续猜
    }
    try {
      const global = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      const candidate = join(global, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
      if (existsSync(candidate)) return resolve(candidate)
    } catch {
      // 继续猜
    }
  }

  const guesses = [
    join(dshHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    'C:/nvm4w/nodejs/node_modules/@deepseek-ai/dsh/lib/bin.js',
  ]
  for (const guess of guesses) if (existsSync(guess)) return resolve(guess)
  throw new Error(`DSH bin.js not found: install the pinned version first (${DSH_INSTALL_COMMAND}), or point --dsh-bin at it`)
}

/**
 * 蜂群2计划 P6 回归：setup 写进 .env 的密钥集（含首启密码）。
 * MANAGER_INITIAL_PASSWORD 必须在 manager 首启前落盘：manager 无配置密码时会
 * 自己 generate 且只打印到日志（index.ts），Windows 安装器隐藏窗口启动 → 用户
 * 永远拿不到。不进 forceKeys（用户改过绝不覆盖）。
 */
export const setupEnvValues = (
  personalKey: string,
  brainKey: string,
): { SESSION_SECRET: string; GW_KEY_A: string; GW_KEY_B: string; BRAIN_TOKEN: string; MANAGER_INITIAL_PASSWORD: string } => ({
  SESSION_SECRET: randomBytes(32).toString('hex'),
  GW_KEY_A: personalKey,
  GW_KEY_B: brainKey,
  BRAIN_TOKEN: randomBytes(24).toString('hex'),
  MANAGER_INITIAL_PASSWORD: randomBytes(16).toString('base64url'),
})

/** 蜂群2计划 P1：探测关键工具版本（node/pnpm/git/dsh）；dshBin 为 null = DSH 未找到。 */
export const probeToolVersions = (dshBin: string | null): Record<'node' | 'pnpm' | 'git' | 'dsh', string | null> => {
  const run = (cmd: string, args: string[], shell = false): string | null => {
    try {
      const out = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell })
      return out.trim().split(/\r?\n/)[0] ?? null
    } catch {
      return null
    }
  }
  // Windows 上 pnpm 是 .CMD 垫片：node ≥20 无 shell 直接 spawn 会 EINVAL（CVE-2024-27980
  // 加固，仓库 L543 同款坑）；无扩展名探测则先 ENOENT。shell: true 交给 cmd 解析；
  // 只剩 .ps1 垫片的机器（nvm4w 布局）再走 powershell 兜底。
  const probePnpm = (): string | null =>
    process.platform === 'win32'
      ? run('pnpm', ['--version'], true) ?? run('powershell', ['-NoProfile', '-Command', 'pnpm --version'])
      : run('pnpm', ['--version'])
  return {
    node: run('node', ['--version']),
    pnpm: probePnpm(),
    git: run('git', ['--version']),
    dsh: dshBin === null ? null : run('node', [dshBin, '--version']),
  }
}

/** 蜂群2计划 P1：端口是否空闲（bind 127.0.0.1 试探；被占用 → false）。 */
export const checkPortFree = (port: number): Promise<boolean> =>
  new Promise((resolvePort) => {
    const server = net.createServer()
    server.once('error', () => resolvePort(false))
    server.once('listening', () => server.close(() => resolvePort(true)))
    server.listen(port, '127.0.0.1')
  })

/** .env 合并：已有的值绝不覆盖（用户手改优先）；forceKeys 例外——setup 自己
 * 拥有这些密钥（必须与刚生成的节点 settings 一致），一律以新值为准。
 * 债务 A3：.env 也是真相源——注释与行序保留、原子写（.tmp+rename）、0600。 */
export const mergeEnv = (path: string, values: Record<string, string>, forceKeys: string[] = []): Record<string, string> => {
  const existing: Record<string, string> = {}
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/) : []
  for (const line of lines) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim())
    if (match !== null && match[1] !== undefined && match[2] !== undefined && match[2] !== '') {
      existing[match[1]] = match[2]
    }
  }
  const merged = { ...values, ...existing }
  for (const key of forceKeys) {
    if (values[key] !== undefined) merged[key] = values[key]
  }
  const handled = new Set<string>()
  const out: string[] = []
  for (const line of lines) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim())
    if (match === null || match[1] === undefined) {
      out.push(line) // 注释/空行原样保留
      continue
    }
    const value = merged[match[1]]
    if (value !== undefined && value !== '') {
      out.push(`${match[1]}=${value}`)
      handled.add(match[1])
    } else {
      out.push(line) // 空值行保留原样
    }
  }
  for (const [key, value] of Object.entries(merged)) {
    if (handled.has(key) || value === '') continue
    out.push(`${key}=${value}`)
  }
  const content = out.join('\n')
  writeFileAtomic(path, content.endsWith('\n') ? content : `${content}\n`, 0o600)
  return merged
}

/**
 * --force 重装时把旧配置里用户定制的工作区保留下来（纯函数，可单测）。
 * 显式传参（--workspace/--brain-workspace）优先于保留值。
 */
export const adoptOldWorkspaces = (
  oldConfig: unknown,
  explicit: { personalWorkspace: boolean; brainWorkspace: boolean },
  options: { personalWorkspace: string; brainWorkspace: string },
): void => {
  const old = oldConfig as { agents?: { personal?: { workspace?: unknown }; brain?: { workspace?: unknown } } }
  const oldPersonal = old?.agents?.personal?.workspace
  const oldBrain = old?.agents?.brain?.workspace
  if (!explicit.personalWorkspace && typeof oldPersonal === 'string' && oldPersonal !== '') {
    options.personalWorkspace = oldPersonal
  }
  if (!explicit.brainWorkspace && typeof oldBrain === 'string' && oldBrain !== '') {
    options.brainWorkspace = oldBrain
  }
}

/** 生成 manager.config.yaml 的配置对象（纯函数，可单测；债务 E7:返回类型 =
 * config.ts 的 ManagerConfigFile,与 loadConfig 消费契约共用一份类型,不再
 * Record<string, unknown> 裸奔）。 */
export const buildManagerConfig = (options: {
  personalWorkspace: string
  brainWorkspace: string
  personalPort: number
  brainPort: number
  dshBin: string
  personalProfile: string
  brainProfile: string
  /** 各节点自己的 DSH_HOME：会话/settings/附件完全隔离（蜂群 v1.1）。 */
  personalHome: string
  brainHome: string
  /** 主脑调内部 API 的令牌：必须注入 brain 节点进程环境，技能手册读 $BRAIN_TOKEN。 */
  brainToken: string
}): ManagerConfigFile => {
  const endpoint = (
    port: number,
    profile: string,
    home: string,
    keyRef: string,
    extraEnv: Record<string, string> = {},
  ): ManagerConfigFile['endpoints'][string] => ({
    url: `http://127.0.0.1:${port}`,
    driver: 'apiproxy',
    prefix: '/api',
    key_ref: '',
    sandbox_base: `http://127.0.0.1:${port}/api-gw/v1`,
    sandbox_key_ref: keyRef,
    spawn: {
      managed: true,
      command: 'node',
      // --no-open：节点是后台服务，不允许每次拉起都弹浏览器（web app 的自身参数）。
      args: [options.dshBin, '--profile', profile, '--no-open'],
      ready_timeout_ms: 30_000,
      // 债务 E7:与 spawnSchema 必填默认值显式对齐(类型化抓出的漂移)
      detached: false,
      runner: 'process',
      restart: { max_attempts: 3, base_delay_ms: 1_000, max_delay_ms: 30_000 },
      env: { DSH_HOME: home, ...extraEnv },
    },
  })
  return {
    listen: { host: '127.0.0.1', port: 8080 },
    endpoints: {
      personal: endpoint(options.personalPort, options.personalProfile, options.personalHome, 'GW_KEY_A'),
      brain: endpoint(options.brainPort, options.brainProfile, options.brainHome, 'GW_KEY_B', {
        BRAIN_TOKEN: options.brainToken,
      }),
    },
    agents: {
      personal: {
        name: 'Personal',
        endpoint: 'personal',
        workspace: options.personalWorkspace,
        public: false,
        preset: 'standard',
        sandbox_mode: 'workspace-write',
      },
      brain: {
        name: 'Brain',
        endpoint: 'brain',
        workspace: options.brainWorkspace,
        public: false,
        preset: 'standard',
        sandbox_mode: 'workspace-write',
      },
    },
    runner: {
      timeout_minutes: 15,
      silence_timeout_minutes: 5,
      max_consecutive_failures: 3,
      daily_budget_usd: 2.0,
    },
    // 蜂群 P5.1：主脑日派工预算熔断（只拦 trigger=brain，人手动不拦）。
    brain: {
      daily_budget_usd: 1.0,
    },
    database: { path: './data/manager.db' },
    // 债务 E7:与 fileSchema 默认值显式对齐(生成文件自带,不依赖下游默认)
    reconcile_interval_minutes: 10,
    backup: { docker_volumes: [], auto: false, interval_minutes: 15 },
    pricing: {
      // 债务 E7:与 pricingSchema 的默认值显式对齐(生成文件自带,不依赖下游默认)
      weekends_off_peak: true,
      timezone: 'Asia/Shanghai',
      peak_windows_utc: [
        { start: '01:00', end: '04:00' },
        { start: '06:00', end: '10:00' },
      ],
      models: {
        'deepseek-v4-pro': {
          off_peak: { input: 0.66, output: 1.98, cache_read: 0.022 },
          peak: { input: 1.32, output: 3.96, cache_read: 0.044 },
        },
        'deepseek-v4-flash': {
          off_peak: { input: 0.22, output: 0.66, cache_read: 0.007 },
          peak: { input: 0.44, output: 1.32, cache_read: 0.014 },
        },
      },
    },
  }
}

export const parseArgs = (argv: string[]): { options: SetupOptions; help: boolean; explicit: { personalWorkspace: boolean; brainWorkspace: boolean } } => {
  const user = process.env.USERPROFILE ?? process.env.HOME ?? '.'
  const nodesHome = `${user}/.dac`
  const defaults: SetupOptions = {
    // 2026-09-05：默认工作区放在仓库外（~/.dac 下）——放在仓库里会被
    // 外层 git 收养，agent 运行没有独立审计留痕（主脑工作区实测踩坑）。
    personalWorkspace: `${nodesHome}/workspaces/personal`,
    brainWorkspace: `${nodesHome}/brain-workspace`,
    personalPort: 3081,
    brainPort: 3082,
    dshHome: process.env.DSH_HOME ?? `${user}/.dsh`,
    nodesHome,
    dshBin: null,
    installProfiles: true,
    gatewayLocal: null,
    // `npm run setup --force` 时 npm 会把 --force 当自己的开关吞掉（并打一行
    // warn），根本不传给脚本——通过它注入的 npm_config_force 兜底识别。
    force: process.env.npm_config_force === 'true',
    skipVersionCheck: false,
  }
  const explicit = { personalWorkspace: false, brainWorkspace: false }
  let help = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = (): string => {
      i += 1
      return argv[i] ?? ''
    }
    if (arg === '--help' || arg === '-h') help = true
    else if (arg === '--workspace') {
      defaults.personalWorkspace = next()
      explicit.personalWorkspace = true
    } else if (arg === '--brain-workspace') {
      defaults.brainWorkspace = next()
      explicit.brainWorkspace = true
    } else if (arg === '--ports') {
      const parts = next().split(',').map((n) => Number(n))
      const a = parts[0]
      const b = parts[1]
      if (a !== undefined && Number.isInteger(a) && a > 0) defaults.personalPort = a
      if (b !== undefined && Number.isInteger(b) && b > 0) defaults.brainPort = b
    } else if (arg === '--dsh-home') defaults.dshHome = next()
    else if (arg === '--nodes-home') defaults.nodesHome = next()
    else if (arg === '--dsh-bin') defaults.dshBin = next()
    else if (arg === '--gateway-local') defaults.gatewayLocal = next()
    else if (arg === '--no-install') defaults.installProfiles = false
    else if (arg === '--force') defaults.force = true
    else if (arg === '--skip-version-check') defaults.skipVersionCheck = true
  }
  return { options: defaults, help, explicit }
}

const usage = (): void => {
  console.log('usage: npm run setup -- [--workspace PATH] [--brain-workspace PATH] [--ports 3081,3082] [--dsh-bin PATH] [--gateway-local PATH] [--nodes-home PATH] [--no-install] [--force] [--skip-version-check]')
  console.log('  --gateway-local  use a local dsh-api-gateway checkout as a file: dependency (offline install; defaults to GitHub)')
  console.log('  --nodes-home     root for node directories (one DSH_HOME per node; default ~/.dac)')
}

// ---------------------------------------------------------------------------
// 债务 E4:main() 拆阶段函数——六段各司其职,main 只编排。
// 每段的失败语义(process.exit(2) 红字)原样保留:setup 无半成功态。
// ---------------------------------------------------------------------------

/** ⓪-1 前置检查:已存在配置 / --force 保留定制工作区 / 模型凭据存在。 */
const checkPreconditions = (
  options: SetupOptions,
  explicit: { personalWorkspace: boolean; brainWorkspace: boolean },
): void => {
  const configPath = 'manager.config.yaml'
  if (existsSync(configPath) && !options.force) {
    console.error(`${configPath} already exists. Edit it directly, or re-run with --force (workspaces are kept, the config is rewritten).`)
    process.exit(2)
  }
  // --force 重写配置前，把旧配置里用户定制过的工作区保留下来——setup 的默认
  // 值是模板目录，一次不带参数的 --force 就会把 personal 从 note-kaka 打回
  // workspaces/personal（2026-09-04 真实踩过）。显式传参优先于保留。
  if (options.force && existsSync(configPath)) {
    try {
      const old = parseYaml(readFileSync(resolve(configPath), 'utf8')) as unknown
      adoptOldWorkspaces(old, explicit, options)
      console.log(`   --force: keeping the old workspaces personal=${options.personalWorkspace} brain=${options.brainWorkspace}`)
    } catch {
      // 旧配置读不了就当没有——生成新配置总比停在原地强。
    }
  }
  if (!existsSync(join(options.dshHome, '.credentials.yaml'))) {
    console.error(`${options.dshHome}/.credentials.yaml not found — run DSH once and configure model credentials before setup.`)
    process.exit(2)
  }
}

/** ⓪-2 自检表:DSH bin / 工具版本 / 端口占用(缺件即红字退出)。返回 dshBin。 */
const selfCheck = async (options: SetupOptions): Promise<string> => {
  console.log('[0/4] preflight…')
  let dshBin: string
  try {
    dshBin = detectDshBin(options.dshHome, options.dshBin)
  } catch (error) {
    console.error(`   ✗ DSH not found: ${(error as Error).message}`)
    process.exit(2)
  }
  const tools = probeToolVersions(dshBin)
  for (const [name, version] of Object.entries(tools)) {
    // pnpm 行只报告不设门槛：节点依赖固定由 npx 临时拉取 pnpm@9（全局 pnpm 版本无关）。
    const ok = name === 'pnpm' ? true : name === 'dsh' ? dshCompatible(version) : version !== null
    const detail =
      version === null
        ? name === 'dsh'
          ? `not found — ${DSH_INSTALL_COMMAND}`
          : name === 'pnpm'
            ? 'not installed (dependency install pulls pnpm@9 through npx)'
            : 'not installed'
        : `${version}${name === 'dsh' && !dshCompatible(version) ? ` (verified version: ${COMPAT_DSH_VERSION})` : ''}`
    console.log(`   ${ok ? '✓' : '✗'} ${name.padEnd(6)} ${detail}`)
  }
  if (tools.git === null) {
    console.error('   ✗ git is missing: install git and try again.')
    process.exit(2)
  }
  if (!dshCompatible(tools.dsh)) {
    if (options.skipVersionCheck) {
      console.warn(`   ! DSH version differs from the verified ${COMPAT_DSH_VERSION}; continuing because of --skip-version-check (at your own risk).`)
    } else {
      console.error(`   ✗ the DSH version must match the verified pin (${DSH_INSTALL_COMMAND}); add --skip-version-check to force it.`)
      process.exit(2)
    }
  }
  const MANAGER_PORT = 8080
  const portRows: Array<[string, number]> = [
    ['manager', MANAGER_PORT],
    ['personal node', options.personalPort],
    ['brain node', options.brainPort],
  ]
  const busyPorts: string[] = []
  for (const [label, port] of portRows) {
    const free = await checkPortFree(port)
    console.log(`   ${free ? '✓' : '✗'} port ${port} (${label}) ${free ? 'free' : 'in use'}`)
    if (!free) busyPorts.push(`${port}（${label}）`)
  }
  if (busyPorts.length > 0) {
    console.error(`   ✗ ports in use: ${busyPorts.join(', ')}. Change them with --ports 3081,3082; the manager port lives in listen.port of manager.config.yaml.`)
    process.exit(2)
  }
  return dshBin
}

/** ① 初始化工作区(模板幂等,绝不覆盖已有文件;note-kaka 类只读权威)。 */
const initWorkspaces = (options: SetupOptions): void => {
  console.log('[1/4] initialising workspaces…')
  // note-kaka 之类已有 RULE.md/CONTEXT.md 的笔记库是「只读权威」（TASKS 阶段二）：
  // 不写入任何模板文件，只确认目录存在——否则 AGENTS.md 会与 RULE.md 打架、
  // 模板文档会污染用户的笔记体系。
  const personalRoot = resolve(options.personalWorkspace)
  if (existsSync(join(personalRoot, 'RULE.md')) || existsSync(join(personalRoot, 'CONTEXT.md'))) {
    mkdirSync(personalRoot, { recursive: true })
    console.log(`   adopting the existing notes workspace ${personalRoot} (RULE.md/CONTEXT.md found; template files are not written)`)
  } else {
    initWorkspace({ workspacePath: options.personalWorkspace, preset: 'personal' })
  }
  initWorkspace({ workspacePath: options.brainWorkspace, preset: 'brain' })
}

/** ② 节点 profile + 凭据 + 依赖安装(失败 = 红字退出,无半成功态)。返回节点 home 映射。 */
const installNodeProfiles = (options: SetupOptions, dshBin: string): Map<string, string> => {
  console.log('[2/4] creating node directories and profiles…')
  const specs: ProfileSpec[] = [
    { name: 'dac-personal', port: options.personalPort },
    { name: 'dac-brain', port: options.brainPort },
  ]
  const gatewayDep =
    options.gatewayLocal === null
      ? GATEWAY_REF
      : `file:${resolve(options.gatewayLocal).replace(/\\/g, '/')}`
  console.log(`   gateway dependency: ${gatewayDep}`)
  const nodeHomes = new Map<string, string>()
  for (const spec of specs) {
    nodeHomes.set(spec.name, join(options.nodesHome, spec.name))
  }
  for (const home of ensureNodeProfiles(options.nodesHome, specs, gatewayDep)) {
    console.log(`   node directory created: ${home}`)
  }
  // 模型凭据：同一用户同一把 key，从主 DSH_HOME 复制（绝不覆盖已有）。
  for (const home of nodeHomes.values()) {
    if (ensureNodeCredentials(options.dshHome, home)) {
      console.log(`   credentials copied to ${home}`)
    }
  }
  console.log(`   DSH bin: ${dshBin}`)
  if (options.installProfiles) {
    let failures = 0
    for (const [name, home] of nodeHomes) {
      const dir = join(home, 'profiles', name)
      try {
        // 换 pnpm 大版本（如 11→9）时 pnpm 会弹「node_modules 将重建」交互确认，
        // 无人值守直接挂死——先删干净，全新安装无提示。
        rmSync(join(dir, 'node_modules'), { recursive: true, force: true })
        const { cmd, args } = profileInstallCommand(process.platform)
        execFileSync(cmd, args, { cwd: dir, shell: true, stdio: ['ignore', 'inherit', 'inherit'] })
      } catch (error) {
        failures += 1
        const message = ((error as Error).message ?? String(error)).split('\n')[0] ?? ''
        console.error(`   npm install failed in ${dir}: ${message}`)
        console.error('   If GitHub is unreachable, re-run setup --force with --gateway-local pointing at a local dsh-api-gateway checkout.')
      }
    }
    // 蜂群2计划 P6 回归：节点依赖没装成 = 半成功态——红字退出（发布实测旧代码软失败
    // 继续，节点能起但原生工具悄悄缺）。修复后重跑 setup --force（幂等）。
    if (failures > 0) {
      console.error('   ✗ node dependency install failed — fix it and re-run setup --force (idempotent).')
      process.exit(2)
    }
  }
  return nodeHomes
}

/** ③ 密钥与 .env(债务 R6:写入走锁入口)。返回 .env 值与两个 home(类型收窄后非空)。 */
const writeSecrets = async (
  nodeHomes: Map<string, string>,
): Promise<{ envValues: Record<string, string>; personalHome: string; brainHome: string }> => {
  console.log('[3/4] generating secrets…')
  // 每个节点自己的 settings.yaml 里一把独立的 gateway 密钥；manager 分 ref 引用。
  // 债务 E10:ensureNodeProfiles 已保证两 home 必在 map,显式收窄替代 `!`
  const personalHome = nodeHomes.get('dac-personal')
  const brainHome = nodeHomes.get('dac-brain')
  if (personalHome === undefined || brainHome === undefined) {
    console.error('internal error: node homes were not registered — ensureNodeProfiles did not run as expected.')
    process.exit(2)
  }
  const personalKey = resolveGatewayKey(personalHome, null)
  const brainKey = resolveGatewayKey(brainHome, null)
  const envValues = await withConfigLock(() => mergeEnv('.env', setupEnvValues(personalKey, brainKey), ['GW_KEY_A', 'GW_KEY_B']))
  return { envValues, personalHome, brainHome }
}

/** ④ 生成 manager.config.yaml(债务 R6:写入走锁入口)。 */
const writeManagerConfig = async (
  options: SetupOptions,
  dshBin: string,
  personalHome: string,
  brainHome: string,
  envValues: Record<string, string>,
): Promise<void> => {
  console.log('[4/4] writing manager.config.yaml…')
  const managerConfig = buildManagerConfig({
    personalWorkspace: resolve(options.personalWorkspace),
    brainWorkspace: resolve(options.brainWorkspace),
    personalPort: options.personalPort,
    brainPort: options.brainPort,
    dshBin,
    personalProfile: 'dac-personal',
    brainProfile: 'dac-brain',
    personalHome,
    brainHome,
    brainToken: envValues.BRAIN_TOKEN ?? '',
  })
  await withConfigLock(() => writeFileAtomic('manager.config.yaml', stringifyYaml(managerConfig)))
}

/** 完成打印:下一步指引。 */
const printDone = (nodeHomes: Map<string, string>): void => {
  console.log('')
  console.log('Done. Next steps:')
  console.log('  npm run build && npm start     # the manager starts both nodes on boot')
  console.log('  (node status: npm run nodes -- list; the brain lives at the top of the sidebar)')
  console.log('  Each node has its own DSH_HOME (sessions/settings/attachments are isolated):')
  for (const [name, home] of nodeHomes) console.log(`    ${name}: ${home}`)
  console.log(`   open http://127.0.0.1:8080 (user ${process.env.MANAGER_USERNAME ?? 'admin'})`)
}

const main = async (): Promise<void> => {
  const { options, help, explicit } = parseArgs(process.argv.slice(2))
  if (help) {
    usage()
    return
  }
  checkPreconditions(options, explicit)
  const dshBin = await selfCheck(options)
  initWorkspaces(options)
  const nodeHomes = installNodeProfiles(options, dshBin)
  const { envValues, personalHome, brainHome } = await writeSecrets(nodeHomes)
  await writeManagerConfig(options, dshBin, personalHome, brainHome, envValues)
  printDone(nodeHomes)
}

// 只在被直接执行时运行（测试导入本模块时不应触发安装流程）。
const isDirect = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirect) void main()
