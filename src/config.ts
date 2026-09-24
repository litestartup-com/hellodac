import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import dotenv from 'dotenv'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { DEFAULT_PRICING, parseUtcTime, type ModelPricing, type PricingTable } from './pricing.js'
import { USD_TO_MICRO } from './usage/store.js'
import type { ValidateRules } from './workspace/validate.js'
import { envSchema } from './env.js'
import { resolvePair } from './dsh-matrix.js'
import { migrateConfigIfNeeded } from './config/migrations.js'

dotenv.config()

/** 蜂群2计划 P2：docker runner 专属段（runner: docker 时必填）。 */
const dockerSpawnSchema = z.object({
  image: z.string().min(1),
  container_name: z.string().min(1).optional(),
  network: z.string().default('dac-hive'),
  port: z.number().int().positive(),
  /** 宿主机路径 → 容器路径（典型：工作区）。docker.sock 按宿主机语义解析。 */
  host_volumes: z.record(z.string(), z.string()).default({}),
  /** 命名卷名 → 容器路径（典型：节点 home /data）。 */
  named_volumes: z.record(z.string(), z.string()).default({}),
})

const spawnSchema = z
  .object({
    // 蜂群 P1：manager 托管该节点的进程生命周期。false（默认）= 节点由外部拉起，
    // manager 只探活不管理（与现状一致，用户手动起的 DSH 不会被 manager 抢管）。
    managed: z.boolean().default(false),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).default([]),
    cwd: z.string().optional(),
    ready_timeout_ms: z.number().int().positive().default(30_000),
    // detached: true = 节点独立于拉起者存活（CLI `nodes up` 场景），必须配
    // log_file（stdout/stderr 落文件，pidfile 落 <log_file>.pid 供跨进程 down）。
    // manager 常驻启动用默认 false（节点随 manager 同生共死）。
    detached: z.boolean().default(false),
    log_file: z.string().optional(),
    // 蜂群 v1.1：节点的额外环境变量（典型：DSH_HOME 指向该节点自己的目录，
    // 会话/settings/附件与其它节点完全隔离）。
    env: z.record(z.string(), z.string()).optional(),
    restart: z
      .object({
        max_attempts: z.number().int().positive().default(3),
        base_delay_ms: z.number().int().nonnegative().default(1_000),
        max_delay_ms: z.number().int().nonnegative().default(30_000),
      })
      .default({ max_attempts: 3, base_delay_ms: 1_000, max_delay_ms: 30_000 }),
    // 蜂群2计划 P2：运行方式。process（默认）= 本机直接拉起（现状，裸机路径）；
    // docker = 经 docker.sock 以容器形态管理（compose 脊柱场景的工蜂）；
    // agent = 舰队模式（能力四）：经 node-agent 在远端宿主机拉起（spawn.host
    // 指定 agent id，本机与容器形态不写）。
    runner: z.enum(['process', 'docker', 'agent']).default('process'),
    docker: dockerSpawnSchema.optional(),
    // 能力四（舰队）：该节点由哪个 agent 执行（null=本机）。runner=agent 必填；
    // 其它 runner 写它 = 校验拒绝（执行地与形态必须一致，防接线漂移）。
    host: z.string().min(1).optional(),
    // 能力二（2026-09-20）：按节点钉版。缺省 = 跟随全局默认（版本矩阵首行）；
    // 显式值必须能在 SUPPORTED_DSH 矩阵里解析（loadConfig 校验）。
    dsh_version: z.string().min(1).optional(),
    gateway_ref: z.string().min(1).optional(),
  })
  .refine((v) => {
    if (v.runner === 'docker') return v.docker !== undefined && v.host === undefined
    if (v.runner === 'agent') return v.host !== undefined
    return v.command !== undefined && v.host === undefined
  }, {
    message: 'spawn: runner=docker needs a docker section; runner=agent needs host (an agent id); runner=process needs command; host is only valid with runner=agent',
  })

/**
 * 能力三 v1（2026-09-20）：节点原生 GUI 的 SSH 隧道元数据。
 * 未配置 = 该端点无「打开原生 GUI」能力（节点页不显示入口）。
 * 红线：ssh 私钥绝不进配置——manager 只记「怎么连」，不记「凭什么连」；
 * 隧道永远绑用户本机 loopback（local_port 是用户机器上的映射口）。
 */
const accessSchema = z.object({
  ssh_user: z.string().min(1),
  ssh_host: z.string().min(1),
  ssh_port: z.number().int().positive().default(22),
  /** 节点宿主机上 GUI 端口（容器 = 发布到宿主的 loopback 端口）。 */
  gui_port: z.number().int().positive().default(3080),
  /** 用户本机映射端口（manager 建议值，可改）。 */
  local_port: z.number().int().positive(),
  /** 体验优化：用户本机私钥路径（非密钥内容），命令带 -i；缺省用 ssh 默认密钥。 */
  ssh_key: z.string().min(1).optional(),
})

const endpointSchema = z.object({
  url: z.string().url(),
  driver: z.enum(['gateway', 'apiproxy']).default('gateway'),
  prefix: z.string().startsWith('/').default('/api-gw/v1'),
  key_ref: z.string().default(''),
  // 蜂群 P0：dsh-api-gateway 的 sandbox-mode 路由基址（方案 A 下与 /api 并存，
  // 指向 http://host:3080/api-gw/v1）。缺省 = 该端点不提供按会话沙箱模式。
  sandbox_base: z.string().url().optional(),
  sandbox_key_ref: z.string().default(''),
  // 蜂群 P1：节点进程生命周期（manager 拉起/停止/重启）。缺省 = 不托管。
  spawn: spawnSchema.optional(),
  // 能力三 v1：原生 GUI 隧道元数据。缺省 = 无「打开原生 GUI」能力。
  access: accessSchema.optional(),
})

const agentSchema = z.object({
  name: z.string().min(1),
  endpoint: z.string().min(1),
  workspace: z.string().min(1),
  public: z.boolean().default(false),
  preset: z.string().optional(),
  // 蜂群 P0：按会话沙箱模式（经 gateway sandbox-mode 路由）。缺省 = 不覆盖，
  // 沿用 DSH 部署默认。
  sandbox_mode: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
  git_remote: z.string().optional(),
  // Left unset, the DSH profile's own default applies. Set per agent so a
  // cheap model can handle dictation while a stronger one writes the weekly
  // review.
  provider: z.string().optional(),
  model: z.string().optional(),
  // 债务 E12：该工作区的治理规则（note-data 校验的外置化）。缺省 = 只做
  // 通用的凭证检查，不继承任何特定工作区的业务规则。
  validate: z
    .object({
      windows: z
        .array(z.object({ path: z.string().min(1), max: z.number().int().positive(), archive: z.string().min(1) }))
        .default([]),
      forbid_amount_fields: z.boolean().default(false),
      acct_flow_max_age_months: z.number().int().nonnegative().nullable().default(null),
    })
    .optional(),
})

const rateSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cache_read: z.number().nonnegative().optional(),
  cache_write: z.number().nonnegative().optional(),
})

/**
 * Rates live in config because they change: DeepSeek repriced V4 mid-August 2026
 * and moved it to time-of-day billing at the same time. A model with no entry
 * here records tokens with a null cost, which surfaces as "rate not configured"
 * rather than a free run.
 */
const pricingSchema = z.object({
  peak_windows_utc: z
    .array(z.object({ start: z.string(), end: z.string() }))
    .default([]),
  // 2026-09-05：周六周日全天低谷计价（DeepSeek V4 规则），默认开。
  weekends_off_peak: z.boolean().default(true),
  // 判定「周末」的时区（星期几属于人的日历，峰值窗口是 UTC 的）。
  timezone: z.string().default('Asia/Shanghai'),
  models: z
    .record(
      z.string(),
      z.object({
        off_peak: rateSchema,
        peak: rateSchema.optional(),
      }),
    )
    .default({}),
})

export const fileSchema = z.object({
  listen: z
    .object({ host: z.string().default('127.0.0.1'), port: z.number().int().positive().default(8080) })
    .default({ host: '127.0.0.1', port: 8080 }),
  endpoints: z.record(z.string(), endpointSchema).refine((v) => Object.keys(v).length > 0, {
    message: 'at least one endpoint is required',
  }),
  agents: z.record(z.string(), agentSchema).refine((v) => Object.keys(v).length > 0, {
    message: 'at least one agent is required',
  }),
  runner: z
    .object({
      timeout_minutes: z.number().int().positive().default(15),
      // Cancels a turn that produces nothing at all for this long. Deliberately
      // much shorter than the total timeout: a working turn streams frames the
      // whole time, so silence means stopped, not slow -- usually blocked on a
      // prompt nobody can answer from here. 0 disables the backstop.
      silence_timeout_minutes: z.number().int().min(0).default(5),
      max_consecutive_failures: z.number().int().positive().default(3),
      // Auto-disable after repeated failures stops a job that keeps breaking. It
      // does nothing about a job that keeps succeeding expensively -- which is
      // the way scheduled work actually drains an account, quietly and on time.
      // Unset means no ceiling.
      daily_budget_usd: z.number().positive().optional(),
    })
    .default({ timeout_minutes: 15, silence_timeout_minutes: 5, max_consecutive_failures: 3 }),
  database: z.object({ path: z.string().min(1) }).default({ path: './data/manager.db' }),
  // 蜂群2计划 修路 A2：周期对账间隔（分钟）。0 = 关闭（只 boot + 变更时对账）。
  // 对账幂等且 healOnly（人手动停的冷态节点不动、失败的 offline 节点自愈）。
  reconcile_interval_minutes: z.number().int().min(0).default(10),
  // 蜂群 P5.1：主脑派工（trigger=brain）的日预算熔断——超限拒绝并转述；
  // 人手动操作保持不拦。缺省 = 不设上限。
  brain: z
    .object({ daily_budget_usd: z.number().positive().optional() })
    .default({}),
  pricing: pricingSchema.optional(),
  // P0（hive/plan-config-version-switch）：配置结构版本——升级自动迁移的锚点
  // （缺省 = 0 = 老配置）。改结构时必须 bump CURRENT_CONFIG_VERSION
  // （src/config/migrations.ts）并配迁移，纪律见 release.md「配置变更清单」。
  config_version: z.number().int().min(0).optional(),
  // 蜂群2计划 P4：备份扩展——额外纳入备份的 docker 命名卷（compose 脊柱的
  // 主脑卷等无 spawn 段的节点 home）。
  // 线上磁盘教训（2026-09-20）：15 分钟快照 + 节点家目录打包在小盘线上会
  // 吃满磁盘——自动备份默认**关闭**，需要时显式 backup.auto: true 开启；
  // 手动备份 npm run backup 不受影响（更新前备份也照常）。
  backup: z
    .object({
      docker_volumes: z.array(z.string()).default([]),
      auto: z.boolean().default(false),
      /** 自动备份间隔（分钟）；auto: true 时生效，默认 15。小盘线上可放宽（如 1440 = 每日）。 */
      interval_minutes: z.number().int().positive().default(15),
    })
    .default({ docker_volumes: [], auto: false, interval_minutes: 15 }),
})

export interface ResolvedSpawnSpec {
  managed: boolean
  command: string
  args: string[]
  cwd: string | null
  readyTimeoutMs: number
  detached: boolean
  /** Absolute path for node stdout/stderr (and its pidfile), or null for in-memory capture. */
  logFile: string | null
  /** Extra env vars layered over the manager's own (典型：DSH_HOME 节点专属目录). */
  env: Record<string, string>
  restart: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number }
  /** 蜂群2计划 P2：运行方式（process=本机拉起 / docker=容器管理 / agent=舰队远端）。 */
  runner: 'process' | 'docker' | 'agent'
  /** 能力四（舰队）：执行该节点的 agent id；非 agent runner = null。 */
  host: string | null
  /** docker runner 专属段；process/agent runner 为 null。 */
  docker: {
    image: string
    containerName: string | null
    network: string
    port: number
    hostVolumes: Record<string, string>
    namedVolumes: Record<string, string>
  } | null
  /** 能力二：按节点钉死的 DSH 版本；null = 跟随全局默认（矩阵首行）。 */
  dshVersion?: string | null
  /** 能力二：按节点钉死的 facade ref；null = 跟随该 DSH 配对的矩阵默认。 */
  gatewayRef?: string | null
}

/** 能力三 v1：节点原生 GUI 隧道元数据（配置文件的 access 段解析结果）。 */
export interface ResolvedEndpointAccess {
  sshUser: string
  sshHost: string
  sshPort: number
  guiPort: number
  localPort: number
  /** 用户本机私钥路径（非密钥内容，命令里只带 -i 路径）；未配置 = null。 */
  sshKey: string | null
}

export interface ResolvedEndpoint {
  id: string
  url: string
  driver: 'gateway' | 'apiproxy'
  prefix: string
  /** Resolved from the env var named by `key_ref`. Never logged, never sent to a browser. */
  key: string
  /** Base URL of the gateway sandbox-mode surface; null = route unavailable. */
  sandboxBase: string | null
  /** Gateway key for the sandbox-mode route. Never logged, never sent to a browser. */
  sandboxKey: string
  /** Node lifecycle spec; null = this endpoint's DSH process is externally managed. */
  spawn: ResolvedSpawnSpec | null
  /** 原生 GUI 隧道元数据；null = 无「打开原生 GUI」能力。 */
  access: ResolvedEndpointAccess | null
}

export interface ResolvedAgent {
  id: string
  name: string
  endpoint: string
  workspacePath: string
  public: boolean
  preset: string | null
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access' | null
  gitRemote: string | null
  provider: string | null
  model: string | null
  /** 债务 E12:该工作区的治理规则;null = DEFAULT_RULES(只做通用凭证检查)。 */
  validate: ValidateRules | null
}

/**
 * P0-4：`trustProxy` 不再写死为 true。
 *
 * 全信任转发头时 `request.ip` 取 X-Forwarded-For，而登录限流以它为键 ——
 * 每次换一个 XFF 就等于没有限流，而这是暴破口令的唯一防线。
 * 所以默认**不信任**（键落在不可伪造的直连对端上），要真实客户端 IP 的部署
 * 在 `.env` 里显式声明可信的那一跳（具体地址或网段）。
 *
 * 取值：空/`false`/`0` → false；`true` → true；其余 → 原串
 * （fastify 接受 IP / CIDR / 逗号列表）。
 *
 * **不支持“跳数”写法**：`TRUST_PROXY=1` 会被 fastify 当成 IP 字串而不是 1 跳，
 * 静默误读比不支持更危险 —— 所以纯数字一律视为无效，回落为不信任
 * （由 loadConfig 推一条启动警告）。
 */
/** 债务 E7:manager.config.yaml 的文件契约类型(buildManagerConfig 等生成方共用)。 */
export type ManagerConfigFile = z.infer<typeof fileSchema>

export const parseTrustProxy = (raw: string | undefined): boolean | string => {
  const value = (raw ?? '').trim()
  if (value === '' || value.toLowerCase() === 'false' || /^\d+$/.test(value)) return false
  if (value.toLowerCase() === 'true') return true
  return value
}

export interface AppConfig {
  listen: { host: string; port: number }
  /**
   * P0-4：反代信任边界（`TRUST_PROXY`）—— 缺省/未配置 = 不信任转发头。
   * 可选：测试里手写的 AppConfig 字面量不必关心它（读取方统一 `?? false`）。
   */
  trustProxy?: boolean | string
  endpoints: Record<string, ResolvedEndpoint>
  agents: Record<string, ResolvedAgent>
  runner: {
    timeoutMs: number
    /** Cancel a turn after this long with no frames at all; 0 disables. */
    silenceMs: number
    maxConsecutiveFailures: number
    /** Ceiling for one local day's scheduled spend, or null for no ceiling. */
    dailyBudgetMicroUsd: number | null
  }
  databasePath: string
  /**
   * 债务 A5：真相源的解析后绝对路径——config 与 .env 全项目只此一处推导
   * （旧代码 index.ts 用 dist/../、provision 用 cwd 相对、backup 再一套，
   * 部署布局一变备份就备错文件）。测试字面量可省略（读取方 ?? resolve 兜底）。
   */
  configPath?: string
  envPath?: string
  /** 修路 A2：周期对账间隔（毫秒）；0 = 关闭。loadConfig 恒有值；测试字面量可省略（读取方 ?? 默认）。 */
  reconcileIntervalMs?: number
  /**
   * 蜂群 P5.1：主脑日派工预算（微美元），null = 不设上限。只拦 trigger=brain
   * 的派工；人工直连与手动派工不受影响。
   */
  brainDailyBudgetMicroUsd?: number | null
  /** Token rates and peak windows, from config or the built-in defaults. */
  pricing: PricingTable
  /** 蜂群2计划 P4：额外纳入备份的 docker 命名卷（无 spawn 段的节点 home，如脊柱主脑卷）。 */
  backupDockerVolumes?: string[]
  /**
   * 自动备份开关（backup.auto，默认 false——线上小盘教训）。true = 按
   * backup.interval_minutes 周期快照；false 只保留手动 npm run backup 与
   * 更新前备份。测试字面量可省略（读取方 ?? false）。
   */
  backupAuto?: boolean
  /** 自动备份间隔（毫秒）；auto: true 时生效，缺省 15 分钟。 */
  backupIntervalMs?: number
  sessionSecret: string
  initialUser: { username: string; password: string | null }
  /**
   * Non-fatal problems worth saying out loud at boot. Kept as data rather than
   * logged from here so the rules stay testable.
   */
  warnings: string[]
}

/**
 * Fail loudly at boot rather than at first use. A half-configured manager that
 * starts and then 500s on the first agent call is strictly worse than one that
 * refuses to start.
 */
export const loadConfig = (configPath = 'manager.config.yaml'): AppConfig => {
  const absPath = resolve(configPath)
  const raw = parseYaml(readFileSync(absPath, 'utf8')) as unknown
  // P0：配置版本化迁移（旧配置 → 新结构；版本超前/链断裂 = fail-loud）
  const migration = migrateConfigIfNeeded(absPath, raw)
  const parsed = fileSchema.safeParse(migration.doc)
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')
    throw new Error(`invalid ${configPath}:\n${detail}`)
  }
  const file = parsed.data

  // 债务 D5:env 集中 zod 校验(boot 一次 fail loud)——旧实现只手工查
  // SESSION_SECRET 长度,其余变量零校验。key_ref 动态寻址的 GW_KEY_* 仍由
  // 下方端点解析逐个校验非空。
  const parsedEnv = envSchema.safeParse(process.env)
  if (!parsedEnv.success) {
    const detail = parsedEnv.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')
    throw new Error(`invalid environment:\n${detail}`)
  }
  const sessionSecret = parsedEnv.data.SESSION_SECRET

  const endpoints: Record<string, ResolvedEndpoint> = {}
  for (const [id, ep] of Object.entries(file.endpoints)) {
    const driver = ep.driver
    const key = ep.key_ref !== '' ? (process.env[ep.key_ref] ?? '') : ''
    if (driver === 'gateway' && key === '') {
      throw new Error(`endpoint "${id}": env var ${ep.key_ref} is empty; it must match one entry of the gateway's apiKeys`)
    }
    // 0.1.2 起（v1.0.3）：apiproxy 显式配置的 prefix 必须生效——指向网关
    // facade 时就是 `/api-gw/v1/proxy`（DSH-012-ASSESSMENT「只改 base URL +
    // key 头」路线的先决条件）。未显式配置（沿用 schema 默认 '/api-gw/v1'）
    // 才回退旧行为 '/api'（0.1.1 直连宿主原生 apiproxy）；现有配置全部显式
    // 写了 prefix: /api，行为零变化。
    const prefix = driver === 'apiproxy' && ep.prefix === '/api-gw/v1' ? '/api' : ep.prefix
    const sandboxBase = ep.sandbox_base === undefined ? null : ep.sandbox_base.replace(/\/+$/, '')
    const sandboxKey = ep.sandbox_key_ref !== '' ? (process.env[ep.sandbox_key_ref] ?? '') : ''
    if (sandboxBase !== null && sandboxKey === '') {
      throw new Error(`endpoint "${id}": env var ${ep.sandbox_key_ref} is empty; it must match one entry of the gateway's apiKeys`)
    }
    // 蜂群 P1：节点的进程生命周期配置。managed: true 意味着 manager 会真的 spawn
    // 这个 DSH 进程——命令/参数要指向 dsh 的 bin.js + 该节点自己的 profile。
    const spawnRaw = ep.spawn
    // 能力二：按节点钉版必须在矩阵内可解析，fail-loud（未知版本绝不悄悄装）。
    if (spawnRaw?.dsh_version !== undefined && resolvePair(spawnRaw.dsh_version) === null) {
      throw new Error(`endpoint "${id}": spawn.dsh_version "${spawnRaw.dsh_version}" is not in SUPPORTED_DSH`)
    }
    const spawn: ResolvedSpawnSpec | null =
      spawnRaw === undefined
        ? null
        : {
            managed: spawnRaw.managed,
            command: spawnRaw.command ?? '',
            args: spawnRaw.args,
            cwd: spawnRaw.cwd === undefined ? null : resolve(spawnRaw.cwd),
            readyTimeoutMs: spawnRaw.ready_timeout_ms,
            detached: spawnRaw.detached,
            logFile: spawnRaw.log_file === undefined ? null : resolve(spawnRaw.log_file),
            env: spawnRaw.env ?? {},
            restart: {
              maxAttempts: spawnRaw.restart.max_attempts,
              baseDelayMs: spawnRaw.restart.base_delay_ms,
              maxDelayMs: spawnRaw.restart.max_delay_ms,
            },
            runner: spawnRaw.runner,
            host: spawnRaw.host ?? null,
            docker:
              spawnRaw.docker === undefined
                ? null
                : {
                    image: spawnRaw.docker.image,
                    containerName: spawnRaw.docker.container_name ?? null,
                    network: spawnRaw.docker.network,
                    port: spawnRaw.docker.port,
                    hostVolumes: spawnRaw.docker.host_volumes,
                    namedVolumes: spawnRaw.docker.named_volumes,
                  },
            dshVersion: spawnRaw.dsh_version ?? null,
            gatewayRef: spawnRaw.gateway_ref ?? null,
          }
    endpoints[id] = {
      id,
      url: ep.url.replace(/\/+$/, ''),
      driver,
      prefix: prefix.replace(/\/+$/, ''),
      key,
      sandboxBase,
      sandboxKey,
      spawn,
      // 能力三 v1：隧道元数据显式映射（snake_case → camelCase）；缺省 = null
      access:
        ep.access === undefined
          ? null
          : {
              sshUser: ep.access.ssh_user,
              sshHost: ep.access.ssh_host,
              sshPort: ep.access.ssh_port,
              guiPort: ep.access.gui_port,
              localPort: ep.access.local_port,
              sshKey: ep.access.ssh_key ?? null,
            },
    }
  }

  const agents: Record<string, ResolvedAgent> = {}
  for (const [id, a] of Object.entries(file.agents)) {
    if (endpoints[a.endpoint] === undefined) {
      throw new Error(`agent "${id}": unknown endpoint "${a.endpoint}"`)
    }
    agents[id] = {
      id,
      name: a.name,
      endpoint: a.endpoint,
      workspacePath: resolve(a.workspace),
      public: a.public,
      preset: a.preset ?? null,
      sandboxMode: a.sandbox_mode ?? null,
      gitRemote: a.git_remote ?? null,
      provider: a.provider ?? null,
      model: a.model ?? null,
      // 债务 E12:规则外置——配置缺省 = 只做通用凭证检查;snake_case 显式映射
      validate:
        a.validate === undefined
          ? null
          : {
              windows: a.validate.windows,
              forbidAmountFields: a.validate.forbid_amount_fields,
              acctFlowMaxAgeMonths: a.validate.acct_flow_max_age_months,
            },
    }
  }

  // 蜂群 P0：显式声明沙箱模式的 agent，必须落在配置了 sandbox 路由的端点上，
  // 否则声明会被静默忽略（fail loud at boot）。
  for (const [agentId, agent] of Object.entries(agents)) {
    if (agent.sandboxMode === null) continue
    const ep = endpoints[agent.endpoint]
    if (ep === undefined || ep.sandboxBase === null) {
      throw new Error(
        `agent "${agentId}" sets sandbox_mode but endpoint "${agent.endpoint}" has no sandbox_base. ` +
          'Add endpoint.sandbox_base + sandbox_key_ref (the dsh-api-gateway surface) to honour it.',
      )
    }
  }

  // DESIGN.md §6 iron rule two: an externally callable agent must not share a
  // DSH process with a private one, because DSH reads are never sandboxed.
  const byEndpoint = new Map<string, ResolvedAgent[]>()
  for (const agent of Object.values(agents)) {
    const list = byEndpoint.get(agent.endpoint) ?? []
    list.push(agent)
    byEndpoint.set(agent.endpoint, list)
  }
  for (const [endpointId, list] of byEndpoint) {
    if (list.some((a) => a.public) && list.some((a) => !a.public)) {
      const pub = list.filter((a) => a.public).map((a) => a.id).join(', ')
      const priv = list.filter((a) => !a.public).map((a) => a.id).join(', ')
      throw new Error(
        `endpoint "${endpointId}" mixes public agents (${pub}) with private ones (${priv}). ` +
          'DSH reads are never sandboxed, so a prompt-injected public agent could read private data. ' +
          'Give the public agent its own endpoint (DESIGN.md §6).',
      )
    }
    // apiproxy mux is a full-volume stream: every session on the DSH process is
    // visible, not just the ones manager created. A public agent on an apiproxy
    // endpoint means an external request could trigger subscription to that
    // stream, which is the *only* visibility boundary in this mode.
    const ep = endpoints[endpointId]
    if (ep !== undefined && ep.driver === 'apiproxy' && list.some((a) => a.public)) {
      const pub = list.filter((a) => a.public).map((a) => a.id).join(', ')
      throw new Error(
        `endpoint "${endpointId}" (driver: apiproxy) has public agents (${pub}). ` +
          'apiproxy mux exposes all sessions on the DSH process; a public agent ' +
          'must not share that visibility. Use a gateway-mode endpoint for public agents.',
      )
    }
  }

  const warnings: string[] = []
  // P0（hive/plan-config-version-switch）：升级自动迁移——旧配置在这里被
  // 翻译成新结构并写回（原文件备份 .pre-mig.bak），迁移说明进 warnings。
  warnings.push(...migration.warnings)
  for (const [endpointId, list] of byEndpoint) {
    if (list.length < 2) continue
    // A DSH session's write boundary is not its cwd. The gateway only passes cwd
    // as the session's working directory (dsh-api-gateway/src/index.ts:517) --
    // the actual sandbox comes from that DSH process's own
    // sandboxPolicy.workspaceRoot, which is process-global. So agents sharing an
    // endpoint can reach each other's workspaces regardless of what manager asks
    // for, and the runner's cwd check cannot prevent it.
    warnings.push(
      `endpoint "${endpointId}" is shared by ${list.length} agents (${list.map((a) => a.id).join(', ')}). ` +
        'A DSH sandbox root is per process, not per session, so these agents can read and write ' +
        "each other's workspaces. Give each one its own DSH process if that matters.",
    )
  }

  let pricing = DEFAULT_PRICING
  if (file.pricing !== undefined) {
    const rates: Record<string, ModelPricing> = {}
    for (const [key, entry] of Object.entries(file.pricing.models)) {
      const toRate = (r: z.infer<typeof rateSchema>): { input: number; output: number; cacheRead?: number; cacheWrite?: number } => ({
        input: r.input,
        output: r.output,
        ...(r.cache_read === undefined ? {} : { cacheRead: r.cache_read }),
        ...(r.cache_write === undefined ? {} : { cacheWrite: r.cache_write }),
      })
      rates[key] = {
        offPeak: toRate(entry.off_peak),
        ...(entry.peak === undefined ? {} : { peak: toRate(entry.peak) }),
      }
    }
    // parseUtcTime throws on a malformed window, which is what should happen:
    // a typo here would silently bill every run at the wrong rate.
    const peakWindows = file.pricing.peak_windows_utc.map((w) => ({
      startMinuteUtc: parseUtcTime(w.start),
      endMinuteUtc: parseUtcTime(w.end),
    }))
    pricing = {
      rates,
      peakWindows,
      weekendsOffPeak: file.pricing.weekends_off_peak,
      pricingTimeZone: file.pricing.timezone,
    }
  }

  const password = process.env.MANAGER_INITIAL_PASSWORD ?? ''

  const trustProxyRaw = (process.env.TRUST_PROXY ?? '').trim()
  if (/^\d+$/.test(trustProxyRaw)) {
    warnings.push(
      `TRUST_PROXY=${trustProxyRaw} does not support a hop count (it would be read as an IP string); treating proxy headers as untrusted. ` +
        'Write an address or CIDR instead, e.g. TRUST_PROXY=127.0.0.1',
    )
  }

  return {
    listen: file.listen,
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
    endpoints,
    agents,
    runner: {
      timeoutMs: file.runner.timeout_minutes * 60_000,
      silenceMs: file.runner.silence_timeout_minutes * 60_000,
      maxConsecutiveFailures: file.runner.max_consecutive_failures,
      // Money is integer micro-USD everywhere past this line, so no float ever
      // reaches a comparison or the database.
      dailyBudgetMicroUsd:
        file.runner.daily_budget_usd === undefined ? null : Math.round(file.runner.daily_budget_usd * USD_TO_MICRO),
    },
    databasePath: resolve(file.database.path),
    // 债务 A5:真相源路径只此一处推导,全项目读取
    configPath: resolve(configPath),
    envPath: resolve('.env'),
    reconcileIntervalMs: file.reconcile_interval_minutes * 60_000,
    brainDailyBudgetMicroUsd:
      file.brain.daily_budget_usd === undefined ? null : Math.round(file.brain.daily_budget_usd * USD_TO_MICRO),
    pricing,
    backupDockerVolumes: file.backup.docker_volumes,
    backupAuto: file.backup.auto,
    backupIntervalMs: file.backup.interval_minutes * 60_000,
    sessionSecret,
    initialUser: {
      username: process.env.MANAGER_USERNAME ?? 'admin',
      password: password === '' ? null : password,
    },
    warnings,
  }
}
