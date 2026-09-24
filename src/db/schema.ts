import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * Eight tables, none of which holds business data.
 *
 * All notes, dashboard JSON and markdown live in the agents' workspaces as
 * ordinary files under git (DESIGN.md §0). If this database is deleted, nothing
 * of yours is lost -- only accounts, schedules, run history and the cost ledger.
 *
 * Timestamps are epoch milliseconds (integer), so SQLite comparisons are cheap
 * and no timezone ambiguity can creep in.
 */

export const user = sqliteTable('user', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: integer('created_at').notNull(),
  /** 蜂群2计划 P3：1 = 首登必须改密（初始密码一次性；迁移 10 对既有账号也置 1）。 */
  mustChangePassword: integer('must_change_password').notNull().default(0),
})

/** Server-side sessions so a login can actually be revoked (a JWT cannot). */
export const session = sqliteTable('session', {
  /** sha256 of the cookie token. The raw token exists only in the cookie. */
  id: text('id').primaryKey(),
  userId: integer('user_id').notNull(),
  expiresAt: integer('expires_at').notNull(),
  createdAt: integer('created_at').notNull(),
})

export const agent = sqliteTable('agent', {
  /** Slug used in URLs: personal / company / product. */
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  workspacePath: text('workspace_path').notNull(),
  /** Endpoint id from manager.config.yaml, not a URL. */
  endpoint: text('endpoint').notNull(),
  preset: text('preset'),
  gitRemote: text('git_remote'),
  /** 1 = callable through the outward task API. Forces a dedicated DSH process. */
  public: integer('public').notNull().default(0),
  createdAt: integer('created_at').notNull(),
})

// 债务 D1:api_key 表(北向 API key 配额)全链路无写入无读取——死代码,已随
// 迁移 13 删除。对外 API 属 M6 路线图,届时按真实契约重新设计。

export const cron = sqliteTable('cron', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  name: text('name').notNull(),
  schedule: text('schedule').notNull(),
  timezone: text('timezone').notNull().default('Asia/Shanghai'),
  prompt: text('prompt').notNull(),
  enabled: integer('enabled').notNull().default(1),
  /** Auto-disables the job once this hits the configured ceiling. */
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  lastRunAt: integer('last_run_at'),
  createdAt: integer('created_at').notNull().default(0),
  /** Why the last attempt failed. Cleared on success. */
  lastError: text('last_error'),
  /**
   * Set only when the manager disabled the job itself.
   *
   * `enabled = 0` looks identical whether the operator flipped it or the failure
   * ceiling did, and an unexplained toggle sitting off reads as your own doing.
   */
  disabledReason: text('disabled_reason'),
  /** Outcome of the last attempt: a run state, or 'skipped'. */
  lastState: text('last_state'),
})

/**
 * A multi-turn conversation, owning exactly one long-lived DSH session.
 *
 * `removedAt` hides a chat rather than deleting anything. Removing it hands the
 * gateway slot back, but the transcript stays on the gateway, so `dshSessionId`
 * remains the pointer to a conversation that still exists and can be adopted.
 */
export const chat = sqliteTable('chat', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  /** Null until the first message creates the gateway session. */
  dshSessionId: text('dsh_session_id'),
  /** The gateway's own session title when it has one, else the first message. */
  title: text('title'),
  createdAt: integer('created_at').notNull(),
  lastActiveAt: integer('last_active_at').notNull(),
  removedAt: integer('removed_at'),
  /**
   * 沙箱覆盖的延迟生效请求（会话转冷时无法立即钉入）：下回合创建/唤醒会话时
   * 由 runner 应用后清空。null = 无待生效覆盖。
   */
  accessModeOverride: text('access_mode_override'),
  /**
   * 最后一次经 manager 钉入的沙箱模式（权限展示真相源，2026-09-11）：宿主
   * permissions 投影的 preset 是意图标签，旋钮漂移后推导值为 custom，反推不出
   * 真实沙箱，故以本列为准。null = 尚未经 manager 钉入（退宿主推导/agent 默认）。
   */
  accessMode: text('access_mode'),
})

export const run = sqliteTable('run', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  /** The thread this turn belongs to. Null for cron and API runs with no chat. */
  chatId: text('chat_id'),
  /**
   * 蜂群 P2：主脑派工时所在的会话——delegation 帧按它归属到主脑会话页。
   * Null for everything that did not come from the brain conversation.
   */
  sourceChatId: text('source_chat_id'),
  /**
   * 蜂群 P5.4：并发写冲突的显性化。运行期间工作区被另一个回合提交过时，
   * 记下说明（本回合基于旧状态、文件可能被并发修改）。NULL = 无冲突。
   */
  conflict: text('conflict'),
  cronId: text('cron_id'),
  // 债务 D1:api_key_id 已随迁移 13 删除(北向 API 未实现,死列)
  dshSessionId: text('dsh_session_id'),
  /** 'cron' | 'manual' | 'api' | 'capture' | 'brain' */
  trigger: text('trigger').notNull(),
  idempotencyKey: text('idempotency_key'),
  /** 'pending' | 'running' | 'done' | 'failed' | 'missed' */
  state: text('state').notNull(),
  resultSummary: text('result_summary'),
  startedAt: integer('started_at').notNull(),
  endedAt: integer('ended_at'),
  error: text('error'),
  /**
   * The commit holding whatever this run changed in the workspace.
   *
   * NULL when the run changed nothing, which is the common case for a run that
   * only read files, and also when no snapshot could be taken at all.
   */
  commitHash: text('commit_hash'),
})

/** 蜂群 P5.3：站内通知（铃铛）。单用户阶段没有收件人维度。 */
export const notification = sqliteTable('notification', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  /** 点击跳转的站内路径（/chat/xxx、/crons…），null = 纯告知。 */
  link: text('link'),
  at: integer('at').notNull(),
  read: integer('read').notNull().default(0),
})

/** 蜂群2计划 P3：审计流水（登录/改密/节点操作/备份），只追加不修改。 */
export const auditLog = sqliteTable('audit_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  at: integer('at').notNull(),
  actor: text('actor').notNull(),
  kind: text('kind').notNull(),
  detail: text('detail').notNull(),
})

/**
 * Written from the provider's reported usage on the gateway SSE stream, never
 * from dsh-token-meter (that one is a context-pressure heuristic, not billing).
 */
export const usageRecord = sqliteTable('usage_record', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  runId: text('run_id').notNull(),
  provider: text('provider'),
  model: text('model'),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  cacheRead: integer('cache_read'),
  cacheWrite: integer('cache_write'),
  reasoningTokens: integer('reasoning_tokens'),
  cost: integer('cost'),
  /**
   * The part of `cost` that was billed at the peak rate.
   *
   * Stored rather than derived: `at` is when the run ended, but a turn is priced
   * per response and a long one can straddle a peak boundary, so the split
   * cannot be recovered from a single timestamp afterwards.
   */
  peakCost: integer('peak_cost'),
  at: integer('at').notNull(),
})

/** 能力四（舰队）：每台服务器的 node-agent 身份目录。token 只存哈希。 */
export const agentMachine = sqliteTable('agent_machine', {
  id: text('id').primaryKey(),
  hostname: text('hostname').notNull(),
  os: text('os').notNull(),
  arch: text('arch').notNull(),
  nodeVersion: text('node_version').notNull(),
  tokenHash: text('token_hash').notNull(),
  joinedAt: integer('joined_at').notNull(),
  lastSeenAt: integer('last_seen_at'),
  revokedAt: integer('revoked_at'),
  /** M4-1 轮换宽限位：上一代 token 哈希（ack 后清除）。 */
  prevTokenHash: text('prev_token_hash'),
  prevSetAt: integer('prev_set_at'),
  /** M4-3：agent 运行时版本（自更新后经心跳上报；机器页「待更新」徽标数据源）。 */
  agentVersion: text('agent_version'),
})

/** 能力四（舰队）：一次性注册 token（manager 签发，15 分钟过期，一次即焚）。 */
export const agentJoinToken = sqliteTable('agent_join_token', {
  tokenHash: text('token_hash').primaryKey(),
  expiresAt: integer('expires_at').notNull(),
  usedAt: integer('used_at'),
  createdAt: integer('created_at').notNull(),
})

/** 能力四（舰队）：agent 指令队列（pending → delivered → done/failed）。 */
export const agentCommand = sqliteTable('agent_command', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  agentId: text('agent_id').notNull(),
  type: text('type').notNull(),
  payload: text('payload').notNull(),
  state: text('state').notNull().default('pending'),
  result: text('result'),
  createdAt: integer('created_at').notNull(),
  deliveredAt: integer('delivered_at'),
  doneAt: integer('done_at'),
})

/** 能力四（舰队 M4-4）：主机指标趋势（心跳 60s 采样，7 天保留）。 */
export const agentMetric = sqliteTable('agent_metric', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  agentId: text('agent_id').notNull(),
  at: integer('at').notNull(),
  /** CPU 忙占比 ×10（125 = 12.5%；INTEGER 避免 REAL 与漂移测试的兼容坑）。 */
  cpuPercent: integer('cpu_percent'),
  memTotal: integer('mem_total'),
  memUsed: integer('mem_used'),
  diskTotal: integer('disk_total'),
  diskFree: integer('disk_free'),
  uptime: integer('uptime'),
  platform: text('platform'),
})
