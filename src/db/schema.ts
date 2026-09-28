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
  /** Hive plan 2 P3: 1 = the password must be changed on first login (the initial password is one-shot; migration 10 sets 1 for existing accounts too). */
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

// Debt D1: the api_key table (northbound API key quotas) had no writer and no reader anywhere -- dead
// code, dropped in migration 13. The public API is on the M6 roadmap and will be redesigned against a real contract.

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
   * A deferred sandbox-override request (it cannot be pinned while the chat is going cold): the runner
   * applies it when the next turn creates/wakes the chat, then clears it. null = no override waiting to take effect.
   */
  accessModeOverride: text('access_mode_override'),
  /**
   * The last sandbox mode pinned through the manager (source of truth for the permission display, 2026-09-11):
   * the preset in the host's permissions projection is an intent label, and once the knobs drift the derived value
   * is custom, which no longer reflects a real sandbox -- so this column wins. null = never pinned by the manager.
   */
  accessMode: text('access_mode'),
  /**
   * Public API attribution (definition: internal design library `manager/topics/CONCEPTS-ALIGNED.md` §6).
   *
   * All three columns null = an internal chat (one the backend opened for itself). An external chat must have the first two:
   * `apiKeyId` = which key opened it (quotas, billing, audit and visibility all key off it);
   * `externalUserId` = **the caller's own user id**; the sticky anchor is "key + it" -- the same user
   * coming back in the caller's system must land in the same chat (a different chat = an amnesiac customer);
   * `serviceId` = which outward service it belongs to (still traceable after service membership changes).
   */
  apiKeyId: text('api_key_id').references(() => apiKey.id, { onDelete: 'set null' }),
  externalUserId: text('external_user_id'),
  serviceId: text('service_id'),
})

/**
 * Public API keys (design note: internal design library `manager/topics/public-api.md` §5).
 *
 * The plaintext secret is **echoed back exactly once at creation**: the database stores `id` (the public
 * prefix, used to locate the row in O(1)) and sha256(secret), so a database dump cannot be replayed. The same
 * idea as session / agent tokens, except a key belongs to a machine caller, so it also carries scopes, service range and quotas.
 */
export const apiKey = sqliteTable('api_key', {
  /** keyId: the public prefix (12 hex); it shows up in the key list and in logs/the UI, so it is not a secret. */
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** sha256(secret) hex. */
  keyHash: text('key_hash').notNull(),
  /** JSON array: services:read / usage:read / tasks:write / conversations:write / interactions:write. */
  scopes: text('scopes').notNull(),
  /** JSON array: the service ids this key may enter; ["*"] = all. Intersected with the service agent's public flag (two gates). */
  scopeServices: text('scope_services').notNull(),
  /** How many jobs may be dispatched per day; NULL = unlimited. The day boundary follows config.pricing.timezone. */
  quotaRunsDay: integer('quota_runs_day'),
  rateLimitRpm: integer('rate_limit_rpm').notNull().default(60),
  /** Cap on concurrent runs, to protect the backend and the agent (over the limit = 429). */
  maxConcurrency: integer('max_concurrency').notNull().default(4),
  expiresAt: integer('expires_at'),
  revokedAt: integer('revoked_at'),
  lastUsedAt: integer('last_used_at'),
  createdBy: text('created_by').notNull(),
  createdAt: integer('created_at').notNull(),
})

export const run = sqliteTable('run', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  /**
   * Public API billing attribution keys (design note manager/topics/public-api.md §5): NULL = not triggered by a key.
   * Spend can be split by "which key × which agent"; a key is revoked, never deleted, so revocation loses no accounting.
   */
  apiKeyId: text('api_key_id').references(() => apiKey.id, { onDelete: 'set null' }),
  /** The thread this turn belongs to. Null for cron and API runs with no chat. */
  chatId: text('chat_id'),
  /**
   * Hive P2: the chat the brain was in when it dispatched -- delegation frames are attributed to the brain chat page by it.
   * Null for everything that did not come from the brain conversation.
   */
  sourceChatId: text('source_chat_id'),
  /**
   * Hive P5.4: making concurrent-write conflicts visible. When another turn committed to the workspace during
   * the run, a note is stored (this turn worked from stale state; files may have been modified concurrently). NULL = no conflict.
   */
  conflict: text('conflict'),
  cronId: text('cron_id'),
  // Debt D1: api_key_id was dropped in migration 13 (the northbound API was never built -- a dead column)
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

/** Hive P5.3: in-app notifications (the bell). In the single-user stage there is no recipient dimension. */
export const notification = sqliteTable('notification', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  /** In-app path to open on click (/chat/xxx, /crons...); null = informational only. */
  link: text('link'),
  at: integer('at').notNull(),
  read: integer('read').notNull().default(0),
})

/** Hive plan 2 P3: the audit trail (login / password change / node operations / backup); append-only. */
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

/** Capability four (Fleet): the node-agent identity directory, one entry per server. Only token hashes are stored. */
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
  /** M4-1 rotation grace slot: the previous token's hash (cleared after ack). */
  prevTokenHash: text('prev_token_hash'),
  prevSetAt: integer('prev_set_at'),
  /** M4-3: the agent's runtime version (reported by heartbeat after a self-update; the data source for the "update pending" badge on the machines page). */
  agentVersion: text('agent_version'),
})

/** Capability four (Fleet): one-shot registration tokens (issued by the manager, expire in 15 minutes, burned on use). */
export const agentJoinToken = sqliteTable('agent_join_token', {
  tokenHash: text('token_hash').primaryKey(),
  expiresAt: integer('expires_at').notNull(),
  usedAt: integer('used_at'),
  createdAt: integer('created_at').notNull(),
})

/** Capability four (Fleet): the agent command queue (pending → delivered → done/failed). */
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

/** Capability four (Fleet M4-4): host metric trends (sampled by heartbeat every 60s, kept for 7 days). */
export const agentMetric = sqliteTable('agent_metric', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  agentId: text('agent_id').notNull(),
  at: integer('at').notNull(),
  /** CPU busy share ×10 (125 = 12.5%; INTEGER avoids the REAL compatibility trap that drift tests hit). */
  cpuPercent: integer('cpu_percent'),
  memTotal: integer('mem_total'),
  memUsed: integer('mem_used'),
  diskTotal: integer('disk_total'),
  diskFree: integer('disk_free'),
  uptime: integer('uptime'),
  platform: text('platform'),
})
