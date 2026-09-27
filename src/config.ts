import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import dotenv from 'dotenv'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { DEFAULT_PRICING, parseUtcTime, type ModelPricing, type PricingTable } from './pricing.js'
import { DEFAULT_THRESHOLDS, type Thresholds } from './services/placement.js'
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
  // 对外 API（设计稿：内部设计库 manager/topics/public-api.md）。缺省开启但**只绑本机**：
  // 门面存在不等于对外可达，暴露与否由运维（nginx/防火墙）决定。
  public_api: z
    .object({
      enabled: z.boolean().default(true),
      host: z.string().min(1).default('127.0.0.1'),
      port: z.number().int().positive().default(8081),
    })
    .default({ enabled: true, host: '127.0.0.1', port: 8081 }),
  // 服务定义。缺省空数组 = 没有对外服务（"当前没有对外 API"是合法状态，不是错误）。
  // 口径见内部设计库 `manager/topics/CONCEPTS-ALIGNED.md`（用户 2026-09-27 确认）。
  services: z
    .array(
      z
        .object({
          id: z
            .string()
            .regex(/^[a-z0-9][a-z0-9-]{0,40}$/, 'service id must be a lowercase slug (a-z, 0-9, -)'),
          label: z.string().min(1),
          workers: z.array(z.string().min(1)).min(1),
          surfaces: z.array(z.enum(['tasks', 'conversations'])).min(1).default(['tasks', 'conversations']),
          // 服务级调度声明：
          // count = 期望 agent 数。**旧名 agents 已按口径改名**——顶层 `agents:` 是
          // 登记表（"是谁"），`services[].count` 是期望个数（"要几个"），同名不同义
          // 是两个概念混在一起的根源。
          count: z.number().int().min(1).default(1),
          capacity: z
            .object({ max_sessions_per_agent: z.number().int().min(1).default(4) })
            .default({ max_sessions_per_agent: 4 }),
          // 对外 agent 的权限档位（口径 §8.5）：**默认只读**；需要写草稿才选 write；
          // 不提供 full —— 对外流量 + 全放开 = 把整台机器交出去，出事无法挽回。
          permission: z.enum(['read', 'write']).default('read'),
          // 会话空闲回收时长（小时，口径 §8.3）：默认 24；建服务时可改。
          session_idle_hours: z.number().positive().default(24),
          placement: z.enum(['spread', 'pack', 'pin']).default('spread'),
          /** placement: pin 时必填：只把这些机器作为落点。 */
          machines: z.array(z.string().min(1)).default([]),
          max_agents_per_machine: z.number().int().min(1).default(4),
          // 放置水位门槛的服务级覆盖（口径 §8；用户 2026-09-27 确认"按机器实际调整"）。
          // 场景：一台确实要用但内存偏小的机器——全局门槛会把它一票否决，而这个服务
          // 就是指定要落在那台机器上。只覆盖声明的项，其余沿用全局默认。
          thresholds: z
            .object({
              min_free_cpu_percent: z.number().min(0).max(100).optional(),
              min_free_mem_bytes: z.number().nonnegative().optional(),
              min_free_disk_bytes: z.number().nonnegative().optional(),
            })
            .strict()
            .optional(),
          knowledge: z
            .array(
              z.object({
                host: z.string().min(1),
                /** 容器/进程内挂载点，必须是绝对路径（相对路径会挂到意想不到的地方）。 */
                mount: z.string().startsWith('/', 'knowledge mount must be an absolute path'),
                read_only: z.boolean().default(true),
              }),
            )
            .default([]),
        })
        // 严收：真相源文件里写错一个字段名（典型：改名后残留的 `agents:`）必须报错，
        // 而不是被静默丢掉——静默丢字段的表现是"服务少起了几个 agent"，事后极难追。
        .strict(),
    )
    .default([]),
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
 * 对外 API 的一个"服务"（口径：内部设计库 `manager/topics/CONCEPTS-ALIGNED.md` §2）。
 *
 * 服务 = 对外的名字 + 一组等价 agent（可跨机器）+ 一本只读手册 + 一套对外话术。
 * 成员必须是 public agent，且按口径 §1 **各自独占进程**（一个 DSH 进程一个 agent）。
 */
export interface ResolvedService {
  id: string
  label: string
  /** 服务成员（agent id）；同服务内成员等价，可被分发挑选。 */
  workers: string[]
  /** 对外开放的话术面：任务式（一次性派工）/ 对话式（多轮 + 人在环）。 */
  surfaces: Array<'tasks' | 'conversations'>
  /** 只读手册的挂载声明（挂载层在 P3 落实；此处先作为真相源校验并展示）。 */
  knowledge: Array<{ host: string; mount: string; readOnly: boolean }>
  /**
   * 服务级调度声明。**loadConfig 恒有值**；测试里手写的字面量可省略，
   * 读取方统一 `?? 默认`（默认值见 fileSchema：期望 1 个 agent / 每 agent 4 并发 /
   * spread / 每机 4 个 agent / 只读 / 空闲 24 小时回收）。
   */
  count?: number
  maxSessionsPerAgent?: number
  permission?: 'read' | 'write'
  sessionIdleHours?: number
  placement?: 'spread' | 'pack' | 'pin'
  machines?: string[]
  maxAgentsPerMachine?: number
  /**
   * 放置水位门槛（全局默认 + 服务级覆盖后的完整三件套）。
   * 用途：某台机器确实要用但空闲内存偏小（全局默认门槛会一票否决），
   * 就在这个服务上按实际写一组合适的门槛，而不是放宽全局门槛连累所有服务。
   */
  thresholds?: Thresholds
}

/**
 * 对外门面监听。**默认只绑本机**：对外暴露是运维动作（nginx 只反代 `/v1`），
 * 不由 manager 自己把公网口开出来。
 */
export interface ResolvedPublicApi {
  enabled: boolean
  host: string
  port: number
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

/**
 * agent 所在的机器 id（口径 §4.5 的"机器"这一层）。
 *
 * 规则只有这一处：`spawn.host`（由远端 host agent 拉起的机器）或 `'local'`（本机）。
 * 放置、快照与配置校验都读它，避免同一个概念在各处各算一遍。
 */
export const machineIdOf = (endpoints: Record<string, ResolvedEndpoint>, endpointId: string): string =>
  endpoints[endpointId]?.spawn?.host ?? 'local'

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
  /**
   * 对外门面监听与对外服务。可选：测试里手写的 AppConfig 字面量不必关心
   * （读取方统一 `?? 默认`），只有真的起门面时才需要。
   */
  publicApi?: ResolvedPublicApi
  /** 缺省 = 没有对外服务。 */
  services?: ResolvedService[]
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

  // 口径（内部设计库 `manager/topics/CONCEPTS-ALIGNED.md` §1，用户 2026-09-27 确认）：
  // **一个 DSH 进程 = 一个 agent**。这不是洁癖，是隔离前提——DSH 的沙箱根是**进程级**
  // 的（`sandboxPolicy.workspaceRoot` 进程全局，见下方注释），apiproxy 的 mux 又是
  // 按进程广播全部会话，所以同进程的两个 agent 天然能读彼此的 workspace、共享同一
  // 可见性域。对外的 agent 更是必须独占：进程里只有它一个，它的会话才全是对外的。
  //
  // 由此，历史上那两条红线（公私有混部 / apiproxy 上不许有 public agent）不再需要：
  // 一个进程只有一个 agent 时，这两种情况都不可能发生。旧报错里那句
  // "Use a gateway-mode endpoint for public agents" 也已失效（facade 0.2.x 移除了会话
  // REST 面，见 `src/gateway/client.ts` 头部与事实卡 §15），它会把用户引到死路上——
  // 所以连同旧红线一起删除，只留下面这一条硬约束。
  const byEndpoint = new Map<string, ResolvedAgent[]>()
  for (const agent of Object.values(agents)) {
    const list = byEndpoint.get(agent.endpoint) ?? []
    list.push(agent)
    byEndpoint.set(agent.endpoint, list)
  }
  for (const [endpointId, list] of byEndpoint) {
    if (list.length < 2) continue
    // A DSH session's write boundary is not its cwd. The gateway only passes cwd
    // as the session's working directory; the actual sandbox comes from that DSH
    // process's own sandboxPolicy.workspaceRoot, which is process-global. So agents
    // sharing an endpoint can reach each other's workspaces regardless of what
    // manager asks for, and the runner's cwd check cannot prevent it.
    throw new Error(
      `endpoint "${endpointId}" is shared by ${list.length} agents (${list.map((a) => a.id).join(', ')}). ` +
        'One DSH process serves exactly one agent: its sandbox root and its session visibility are ' +
        'per process, not per session, so these agents could read and write each other\'s workspaces. ' +
        'Give each agent its own endpoint (CONCEPTS-ALIGNED.md §1).',
    )
  }

  const warnings: string[] = []
  // P0（hive/plan-config-version-switch）：升级自动迁移——旧配置在这里被
  // 翻译成新结构并写回（原文件备份 .pre-mig.bak），迁移说明进 warnings。
  warnings.push(...migration.warnings)
  // 死路告警（事实卡 `manager/facts/dsh-facts.md` §15，2026-09-27 实测）：gateway 驱动
  // 依赖旧 `dsh-api-gateway` 的会话 REST 面（`POST /sessions`…），而 facade 0.2.3 已经
  // 把它移除（`GET /health` → 200，`POST /sessions` → 404）。这类端点探活是绿的、
  // 一发消息就 404，属于最难查的"半死"状态——所以启动就喊出来，别等人踩。
  for (const [endpointId, ep] of Object.entries(endpoints)) {
    if (ep.driver !== 'gateway') continue
    warnings.push(
      `endpoint "${endpointId}" uses the gateway driver, which is a dead path: facade 0.2.x dropped the ` +
        'session REST surface, so sessions on it answer 404 while health checks stay green. Use ' +
        'driver: apiproxy with prefix /api-gw/v1/proxy (facts/dsh-facts.md §15).',
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

  // 对外服务：成员必须是**已存在的 public agent**。成员漏标 public 会让服务静默变成
  // "谁都进不来"，而跨服务/未知成员是配置手误——两者都在 boot 时 fail-loud。
  const services: ResolvedService[] = []
  const seenServices = new Set<string>()
  for (const svc of file.services) {
    if (seenServices.has(svc.id)) {
      throw new Error(`duplicate service id "${svc.id}": service ids must be unique`)
    }
    seenServices.add(svc.id)
    for (const worker of svc.workers) {
      const agent = agents[worker]
      if (agent === undefined) {
        throw new Error(`service "${svc.id}": unknown worker "${worker}" (no such agent in agents:)`)
      }
      if (!agent.public) {
        throw new Error(
          `service "${svc.id}": worker "${worker}" is not public. A service can only be served by ` +
            'public agents; otherwise the service would be unreachable for every caller.',
        )
      }
    }
    services.push({
      id: svc.id,
      label: svc.label,
      workers: [...svc.workers],
      surfaces: [...svc.surfaces],
      knowledge: svc.knowledge.map((k) => ({ host: k.host, mount: k.mount, readOnly: k.read_only })),
      count: svc.count,
      maxSessionsPerAgent: svc.capacity.max_sessions_per_agent,
      permission: svc.permission,
      sessionIdleHours: svc.session_idle_hours,
      placement: svc.placement,
      machines: [...svc.machines],
      maxAgentsPerMachine: svc.max_agents_per_machine,
      // 门槛恒为"完整三件套"（全局默认打底，服务声明的项覆盖）：放置器拿到的是一组
      // 定值，不需要在每个调用点各自做合并——合并规则只有这一处。
      thresholds: {
        minFreeCpuPercent: svc.thresholds?.min_free_cpu_percent ?? DEFAULT_THRESHOLDS.minFreeCpuPercent,
        minFreeMemBytes: svc.thresholds?.min_free_mem_bytes ?? DEFAULT_THRESHOLDS.minFreeMemBytes,
        minFreeDiskBytes: svc.thresholds?.min_free_disk_bytes ?? DEFAULT_THRESHOLDS.minFreeDiskBytes,
      },
    })

    // 服务级调度的声明校验（口径 §8）。全部 fail-loud：
    // 这类错误若被静默忽略，表现是"agent 少了 / 铺错机器了"，事后极难追。
    if (svc.placement === 'pin' && svc.machines.length === 0) {
      throw new Error(`service "${svc.id}": placement "pin" needs machines: [<machine ids>]`)
    }
    if (svc.placement !== 'pin' && svc.machines.length > 0) {
      throw new Error(
        `service "${svc.id}": machines is only meaningful with placement "pin" (got ${svc.placement}); ` +
          'otherwise the list would be silently ignored.',
      )
    }
    if (svc.placement === 'pin' && svc.count > svc.machines.length * svc.max_agents_per_machine) {
      throw new Error(
        `service "${svc.id}": count=${svc.count} cannot fit on ${svc.machines.length} pinned machine(s) ` +
          `at ${svc.max_agents_per_machine} agents each; raise max_agents_per_machine or add machines`,
      )
    }
    // 口径 §8.2：agent 来源**二选一**——要么写 count + 模板让 DAC 自动新建，要么把
    // agent 列全直接用。自动新建尚未实现，所以现在只接受"列全"，否则"声明 3 个、
    // 实际 1 个在跑"会变成静默少配（少配的症状是对外 429，不是报错）。
    if (svc.count !== svc.workers.length) {
      throw new Error(
        `service "${svc.id}": count=${svc.count} but ${svc.workers.length} worker(s) listed. ` +
          'Automatic agent provisioning is not implemented yet, so list every agent and set count to ' +
          'match (CONCEPTS-ALIGNED.md §8.2).',
      )
    }
  }

  // 机器级隔离（口径 §4.5 第 3 道边界；用户 2026-09-27 确认"配置层也硬拦"）。
  //
  // 端点级那条只管"同进程"；机器这一层管的是"同一个 OS 用户下的文件视野"：DSH 读文件
  // 不隔离，所以同一台机器上的两个 agent 即使各占一个进程，也能互相读到对方的
  // workspace 与凭据。两条约束：
  //   1. 同一台机器不能既有对外 agent 又有对内 agent；
  //   2. 同一台机器不能同时属于两个对外服务（跨服务注入面）。
  // 未加入任何服务的对外 agent 不参与第 2 条判定（配置是分两步写的：先建 agent、
  // 再挂进服务；它一旦被挂进某个服务，规则就会在下一次加载时生效）。
  const serviceOfAgent = new Map<string, string>()
  for (const svc of services) for (const worker of svc.workers) serviceOfAgent.set(worker, svc.id)
  const agentsByMachine = new Map<string, ResolvedAgent[]>()
  for (const agent of Object.values(agents)) {
    const machine = machineIdOf(endpoints, agent.endpoint)
    const list = agentsByMachine.get(machine) ?? []
    list.push(agent)
    agentsByMachine.set(machine, list)
  }
  for (const [machine, list] of agentsByMachine) {
    const outward = list.filter((a) => a.public)
    const internal = list.filter((a) => !a.public)
    if (outward.length > 0 && internal.length > 0) {
      throw new Error(
        `machine "${machine}" hosts both outward agents (${outward.map((a) => a.id).join(', ')}) and ` +
          `internal ones (${internal.map((a) => a.id).join(', ')}). DSH reads are not sandboxed, so on one ` +
          'machine an outward agent can read the workspaces and credentials of the internal ones. Give the ' +
          'outward agents a machine of their own (CONCEPTS-ALIGNED.md §4.5).',
      )
    }
    const assigned = outward.map((a) => ({ id: a.id, service: serviceOfAgent.get(a.id) })).filter((e) => e.service !== undefined)
    const serviceIds = [...new Set(assigned.map((e) => e.service))]
    if (serviceIds.length > 1) {
      throw new Error(
        `machine "${machine}" serves ${serviceIds.length} different services (${serviceIds.join(', ')}): ` +
          `${assigned.map((e) => `${e.id}→${e.service}`).join(', ')}. One injected agent could then read the ` +
          'other service\'s workspaces. Keep one service per machine, or move one of them ' +
          '(CONCEPTS-ALIGNED.md §4.5).',
      )
    }
  }

  // 门面与后台不能同端口：真撞上时门面永远起不来，而"API 不见了"比启动失败更难查。
  if (file.public_api.enabled && file.public_api.port === file.listen.port && file.public_api.host === file.listen.host) {
    throw new Error(
      `public_api.port ${file.public_api.port} is the same as listen.port on host ${file.listen.host}: ` +
        'the outward API must have its own listener or it can never bind.',
    )
  }

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
    publicApi: {
      enabled: file.public_api.enabled,
      host: file.public_api.host,
      port: file.public_api.port,
    },
    services,
    sessionSecret,
    initialUser: {
      username: process.env.MANAGER_USERNAME ?? 'admin',
      password: password === '' ? null : password,
    },
    warnings,
  }
}
