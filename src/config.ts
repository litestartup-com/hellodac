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

/** Hive plan 2 P2: the docker-runner-only section (required when runner: docker). */
const dockerSpawnSchema = z.object({
  image: z.string().min(1),
  container_name: z.string().min(1).optional(),
  network: z.string().default('dac-hive'),
  port: z.number().int().positive(),
  /** Host path -> container path (typically the workspace). docker.sock resolves with host semantics. */
  host_volumes: z.record(z.string(), z.string()).default({}),
  /** Named volume -> container path (typically the node home /data). */
  named_volumes: z.record(z.string(), z.string()).default({}),
})

const spawnSchema = z
  .object({
    // Hive P1: the manager owns this node's process lifecycle. false (default) = the node is started
    // externally and the manager only probes it (a DSH the user started by hand stays theirs).
    managed: z.boolean().default(false),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).default([]),
    cwd: z.string().optional(),
    ready_timeout_ms: z.number().int().positive().default(30_000),
    // detached: true = the node outlives whoever started it (CLI `nodes up`), and must pair with
    // log_file (stdout/stderr to the file, pidfile to <log_file>.pid for a cross-process down).
    // The resident manager uses the default false (the node lives and dies with the manager).
    detached: z.boolean().default(false),
    log_file: z.string().optional(),
    // Hive v1.1: extra env vars for the node (typically DSH_HOME pointing at that node's own
    // directory, so chats/settings/attachments are fully isolated from every other node).
    env: z.record(z.string(), z.string()).optional(),
    restart: z
      .object({
        max_attempts: z.number().int().positive().default(3),
        base_delay_ms: z.number().int().nonnegative().default(1_000),
        max_delay_ms: z.number().int().nonnegative().default(30_000),
      })
      .default({ max_attempts: 3, base_delay_ms: 1_000, max_delay_ms: 30_000 }),
    // Hive plan 2 P2: how the node runs. process (default) = started straight on this machine
    // (the status quo, the bare-metal path); docker = managed as a container over docker.sock
    // (the workers of the compose spine); agent = Fleet mode (Capability four): started on a
    // remote host through node-agent (spawn.host names the agent id; local and containers omit it).
    runner: z.enum(['process', 'docker', 'agent']).default('process'),
    docker: dockerSpawnSchema.optional(),
    // Capability four (Fleet): which agent runs this node (null = this machine). Required for
    // runner=agent; setting it on any other runner is rejected (where it runs must match how).
    host: z.string().min(1).optional(),
    // Capability two (2026-09-20): pin the version per node. Absent = follow the global default
    // (the first row of the version matrix); an explicit value must resolve in the SUPPORTED_DSH matrix.
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
 * Capability three v1 (2026-09-20): SSH tunnel metadata for a node's native GUI.
 * Unconfigured = this endpoint has no 'open native GUI' ability (no entry on the node page).
 * Red line: the ssh private key never enters the config -- the manager records how to connect,
 * never what proves the right to; the tunnel always binds the user's own loopback, and
 * local_port is the mapped port on the user's machine.
 */
const accessSchema = z.object({
  ssh_user: z.string().min(1),
  ssh_host: z.string().min(1),
  ssh_port: z.number().int().positive().default(22),
  /** GUI port on the node's host (for a container: the port published to the host's loopback). */
  gui_port: z.number().int().positive().default(3080),
  /** Port mapped on the user's own machine (a manager suggestion, editable). */
  local_port: z.number().int().positive(),
  /** UX nicety: private key path on the user's machine (not the key); the command carries -i; default = ssh's own key. */
  ssh_key: z.string().min(1).optional(),
})

const endpointSchema = z.object({
  url: z.string().url(),
  driver: z.enum(['gateway', 'apiproxy']).default('gateway'),
  prefix: z.string().startsWith('/').default('/api-gw/v1'),
  key_ref: z.string().default(''),
  // Hive P0: sandbox-mode route base of dsh-api-gateway (beside /api under Option A, pointing at
  // http://host:3080/api-gw/v1). Absent = the endpoint offers no per-chat sandbox mode.
  sandbox_base: z.string().url().optional(),
  sandbox_key_ref: z.string().default(''),
  // Hive P1: the node's process lifecycle (manager starts/stops/restarts it). Absent = unmanaged.
  spawn: spawnSchema.optional(),
  // Capability three v1: native GUI tunnel metadata. Absent = no 'open native GUI' ability.
  access: accessSchema.optional(),
})

const agentSchema = z.object({
  name: z.string().min(1),
  endpoint: z.string().min(1),
  workspace: z.string().min(1),
  public: z.boolean().default(false),
  preset: z.string().optional(),
  // Hive P0: per-chat sandbox mode (through the gateway sandbox-mode route). Absent = no
  // override, so the DSH deployment default stands.
  sandbox_mode: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
  git_remote: z.string().optional(),
  // Left unset, the DSH profile's own default applies. Set per agent so a
  // cheap model can handle dictation while a stronger one writes the weekly
  // review.
  provider: z.string().optional(),
  model: z.string().optional(),
  // Debt E12: this workspace's governance rules (note-data validation moved out of code).
  // Absent = only the generic credential checks, no workspace-specific business rules.
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
  // 2026-09-05: all-day off-peak pricing on Saturday and Sunday (DeepSeek V4 rule), on by default.
  weekends_off_peak: z.boolean().default(true),
  // Timezone for deciding 'weekend' (the weekday belongs to a human calendar; peak windows are UTC).
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
      // Total timeout for an OUTWARD turn (a public-API conversation). Much shorter than the
      // internal one on purpose: an outward turn holds a customer's HTTP request open, so
      // "wait a quarter of an hour" is not an option -- five minutes of nothing is already a
      // failed call the caller should hear about honestly (2026-09-29, the ask_user_question
      // hang: the outward caller rode the internal 15-minute ceiling).
      outward_timeout_minutes: z.number().int().positive().default(5),
      max_consecutive_failures: z.number().int().positive().default(3),
      // Auto-disable after repeated failures stops a job that keeps breaking. It
      // does nothing about a job that keeps succeeding expensively -- which is
      // the way scheduled work actually drains an account, quietly and on time.
      // Unset means no ceiling.
      daily_budget_usd: z.number().positive().optional(),
    })
    .default({ timeout_minutes: 15, silence_timeout_minutes: 5, outward_timeout_minutes: 5, max_consecutive_failures: 3 }),
  database: z.object({ path: z.string().min(1) }).default({ path: './data/manager.db' }),
  // Hive plan 2 Road work A2: periodic reconcile interval in minutes. 0 = off (boot + changes only).
  // Reconcile is idempotent and healOnly (a cold node a human stopped stays put; offline self-heals).
  reconcile_interval_minutes: z.number().int().min(0).default(10),
  // Hive P5.1: daily budget breaker for brain dispatch (trigger=brain) -- over the limit the
  // request is refused and relayed on; manual work is never blocked. Absent = no cap.
  brain: z
    .object({ daily_budget_usd: z.number().positive().optional() })
    .default({}),
  pricing: pricingSchema.optional(),
  // P0 (hive/plan-config-version-switch): config structure version -- the anchor for automatic
  // upgrade migration (absent = 0 = an old config). Changing the structure means bumping
  // CURRENT_CONFIG_VERSION (src/config/migrations.ts) plus a migration; see release.md's config list.
  config_version: z.number().int().min(0).optional(),
  // Hive plan 2 P4: backup extension -- docker named volumes pulled into the backup as well
  // (the home of nodes with no spawn section, such as the compose spine's brain volume).
  // A production disk lesson (2026-09-20): a 15-minute snapshot plus packing node homes fills
  // a small production disk, so automatic backup is **off** by default and needs an explicit
  // backup.auto: true; manual backup via npm run backup is unaffected (as is the pre-update one).
  backup: z
    .object({
      docker_volumes: z.array(z.string()).default([]),
      auto: z.boolean().default(false),
      /** Automatic backup interval in minutes; used when auto: true, default 15. On a small disk relax it (1440 = daily). */
      interval_minutes: z.number().int().positive().default(15),
    })
    .default({ docker_volumes: [], auto: false, interval_minutes: 15 }),
  // Outward API (design: internal design library manager/topics/public-api.md). On by default
  // but **bound to this machine only**: a facade is not reachability -- ops (nginx/firewall) decides.
  public_api: z
    .object({
      enabled: z.boolean().default(true),
      host: z.string().min(1).default('127.0.0.1'),
      port: z.number().int().positive().default(8081),
    })
    .default({ enabled: true, host: '127.0.0.1', port: 8081 }),
  // Service definitions. An empty array = no outward services ('no public API right now' is a
  // legal state, not an error). See `manager/topics/CONCEPTS-ALIGNED.md` (user, 2026-09-27).
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
          // Service-level scheduling declaration:
          // count = the number of agents wanted. **The old name agents was renamed** -- top-level
          // `agents:` is the registry ('who'), `services[].count` is the expected number ('how
          // many'); one name for two meanings is exactly what muddled the two concepts together.
          count: z.number().int().min(1).default(1),
          capacity: z
            .object({ max_sessions_per_agent: z.number().int().min(1).default(4) })
            .default({ max_sessions_per_agent: 4 }),
          // Permission tier for an outward agent (§8.5): **read-only by default**; write only when
          // drafts are needed; no full -- public traffic + full access gives the whole machine away.
          permission: z.enum(['read', 'write']).default('read'),
          // Idle chat reclaim window in hours (§8.3): default 24, editable when creating a service.
          session_idle_hours: z.number().positive().default(24),
          placement: z.enum(['spread', 'pack', 'pin']).default('spread'),
          /** Required when placement: pin: use only these machines as landing spots. */
          machines: z.array(z.string().min(1)).default([]),
          max_agents_per_machine: z.number().int().min(1).default(4),
          // Service-level override of the placement watermarks (§8; user 2026-09-27 'adjust per
          // machine'): a machine that is needed but short on memory would be vetoed by the global
          // threshold, and this service is meant to land exactly there. Other entries keep the default.
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
                /** Mount point inside the container/process, must be absolute (a relative path lands somewhere unexpected). */
                mount: z.string().startsWith('/', 'knowledge mount must be an absolute path'),
                read_only: z.boolean().default(true),
              }),
            )
            .default([]),
          // The service's outward voice (the "话术" half of "a team of agents + a read-only manual +
          // one outward voice"): role, tone, what it may answer, escalation wording. The manager
          // delivers it into the agents' workspace rules (derived file); it is free text and is
          // never interpolated into anything but that document.
          persona: z.string().max(8000).optional(),
        })
        // Strict: a wrong field name in the source of truth (an `agents:` left from the rename)
        // must error, not vanish silently -- that reads as 'the service started fewer agents'.
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
  /** Extra env vars layered over the manager's own (typically DSH_HOME, the node's own directory). */
  env: Record<string, string>
  restart: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number }
  /** Hive plan 2 P2: how it runs (process=started here / docker=container / agent=remote Fleet). */
  runner: 'process' | 'docker' | 'agent'
  /** Capability four (Fleet): the agent id that runs this node; null for any other runner. */
  host: string | null
  /** The docker-runner-only section; null for the process/agent runners. */
  docker: {
    image: string
    containerName: string | null
    network: string
    port: number
    hostVolumes: Record<string, string>
    namedVolumes: Record<string, string>
  } | null
  /** Capability two: the DSH version pinned per node; null = follow the global default (matrix row one). */
  dshVersion?: string | null
  /** Capability two: the facade ref pinned per node; null = the matrix default paired with that DSH. */
  gatewayRef?: string | null
}

/** Capability three v1: native GUI tunnel metadata (the parsed access section of the config file). */
export interface ResolvedEndpointAccess {
  sshUser: string
  sshHost: string
  sshPort: number
  guiPort: number
  localPort: number
  /** Private key path on the user's machine (not the key; the command carries only the -i path); null when unset. */
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
  /** Native GUI tunnel metadata; null = no 'open native GUI' ability. */
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
  /** Debt E12: this workspace's governance rules; null = DEFAULT_RULES (generic credential checks only). */
  validate: ValidateRules | null
}

/**
 * One 'service' of the outward API (see internal design library `manager/topics/CONCEPTS-ALIGNED.md` §2).
 *
 * A service = an outward name + a set of equivalent agents (possibly across machines) + a
 * read-only manual + one outward voice. Members must be public agents and, per §1, **each on
 * its own process** (one DSH process per agent).
 */
export interface ResolvedService {
  id: string
  label: string
  /** Service members (agent ids); within a service they are equivalent and dispatching may pick any. */
  workers: string[]
  /** The outward surfaces: task-style (one-shot dispatch) / conversation-style (multi-turn, human in the loop). */
  surfaces: Array<'tasks' | 'conversations'>
  /** Mount declaration for the read-only manual (the mount layer lands in P3; here it validates and displays). */
  knowledge: Array<{ host: string; mount: string; readOnly: boolean }>
  /**
   * Service-level scheduling declaration. **Always set by loadConfig**; a hand-written literal in
   * a test may omit it, and readers use `?? default` (see fileSchema: 1 agent wanted / 4 concurrent
   * per agent / spread / 4 agents per machine / read-only / reclaim idle after 24 hours).
   */
  count?: number
  maxSessionsPerAgent?: number
  permission?: 'read' | 'write'
  sessionIdleHours?: number
  placement?: 'spread' | 'pack' | 'pin'
  machines?: string[]
  maxAgentsPerMachine?: number
  /**
   * Placement watermarks (the full trio, global defaults plus service-level overrides).
   * The use: a machine that is really needed but short on free memory would be vetoed by the
   * global threshold, so write a fitting set here instead of loosening the global one for everyone.
   */
  thresholds?: Thresholds
  /**
   * The service's outward voice (role / tone / boundaries), free text from the declaration.
   * The manager delivers it into the member agents' workspace rules; absent = the platform
   * rules alone. Trimmed; whitespace-only is treated as absent by loadConfig.
   */
  persona?: string
}

/**
 * Outward facade listener. **Bound to this machine by default**: exposing it is an ops action
 * (nginx reverse-proxies `/v1` only), not the manager opening a public port by itself.
 */
export interface ResolvedPublicApi {
  enabled: boolean
  host: string
  port: number
}

/**
 * P0-4: `trustProxy` is no longer hardcoded to true.
 *
 * Trusting every forwarding header makes `request.ip` read X-Forwarded-For, and login rate
 * limiting keys on it -- a fresh XFF each time is no limit at all, and it is the only defence
 * against password brute force. So the default is **no trust** (the key lands on the unforgeable
 * direct peer); a deployment wanting the real client IP declares the trusted hop (address or subnet) in `.env`.
 *
 * Values: empty/`false`/`0` -> false; `true` -> true; anything else -> the string as given
 * (fastify accepts an IP / CIDR / comma-separated list).
 *
 * **A hop count is not supported**: fastify reads `TRUST_PROXY=1` as an IP string, not one hop,
 * and a silent misread is more dangerous than no support -- so a bare number is always invalid
 * and falls back to no trust (loadConfig raises a startup warning).
 */
/** Debt E7: the file contract type of manager.config.yaml (shared by buildManagerConfig and friends). */
export type ManagerConfigFile = z.infer<typeof fileSchema>

/**
 * Machine id the agent lives on (the 'machine' layer of §4.5).
 *
 * One rule only: `spawn.host` (the machine a remote host agent starts it on) or `'local'`.
 * Placement, snapshots and config validation all read it, so one concept is computed in one place.
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
   * P0-4: reverse-proxy trust boundary (`TRUST_PROXY`) -- absent/unset = no trust in forwarding headers.
   * Optional: a hand-written AppConfig literal in a test need not care (readers use `?? false`).
   */
  trustProxy?: boolean | string
  endpoints: Record<string, ResolvedEndpoint>
  agents: Record<string, ResolvedAgent>
  /**
   * Outward facade listener and outward services. Optional: a hand-written AppConfig literal in a
   * test need not care (readers use `?? default`); only actually starting the facade needs it.
   */
  publicApi?: ResolvedPublicApi
  /** Absent = no outward services. */
  services?: ResolvedService[]
  runner: {
    timeoutMs: number
    /** Cancel a turn after this long with no frames at all; 0 disables. */
    silenceMs: number
    /**
     * Total timeout for an outward (public-API) turn; always set by loadConfig. Optional in the
     * type so a hand-written test literal may omit it -- readers fall back to `timeoutMs`.
     */
    outwardTimeoutMs?: number
    maxConsecutiveFailures: number
    /** Ceiling for one local day's scheduled spend, or null for no ceiling. */
    dailyBudgetMicroUsd: number | null
  }
  databasePath: string
  /**
   * Debt A5: resolved absolute paths of the sources of truth -- derived in exactly one place
   * (old code had dist/../ in index.ts, a cwd-relative one in provision, another in backup, so a
   * layout change made backups back up the wrong file). Test literals may omit it (readers ?? resolve).
   */
  configPath?: string
  envPath?: string
  /** Road work A2: periodic reconcile interval in ms; 0 = off. Always set by loadConfig; test literals may omit it (readers ?? default). */
  reconcileIntervalMs?: number
  /**
   * Hive P5.1: the brain's daily dispatch budget in micro-USD; null = no cap. It only blocks
   * trigger=brain dispatches; a human talking directly or dispatching by hand is unaffected.
   */
  brainDailyBudgetMicroUsd?: number | null
  /** Token rates and peak windows, from config or the built-in defaults. */
  pricing: PricingTable
  /** Hive plan 2 P4: docker named volumes added to the backup (the home of nodes with no spawn section, e.g. the spine brain volume). */
  backupDockerVolumes?: string[]
  /**
   * Automatic backup switch (backup.auto, default false -- the small production disk lesson).
   * true = snapshot every backup.interval_minutes; false keeps only manual npm run backup and
   * the pre-update backup. Test literals may omit it (readers ?? false).
   */
  backupAuto?: boolean
  /** Automatic backup interval in ms; used when auto: true, 15 minutes by default. */
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
  // P0: versioned config migration (old config -> new structure; a future version or a broken chain = fail-loud)
  const migration = migrateConfigIfNeeded(absPath, raw)
  const parsed = fileSchema.safeParse(migration.doc)
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')
    throw new Error(`invalid ${configPath}:\n${detail}`)
  }
  const file = parsed.data

  // Debt D5: env is validated centrally with zod (once at boot, fail loud) -- the old code only
  // checked SESSION_SECRET's length by hand and validated nothing else. GW_KEY_* addressed
  // dynamically through key_ref are still checked for emptiness one by one in the endpoint parser.
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
    // Since 0.1.2 (v1.0.3): an explicitly configured apiproxy prefix must take effect -- pointing
    // at the gateway facade that is `/api-gw/v1/proxy` (the precondition of the DSH-012-ASSESSMENT
    // route of 'change the base URL + the key header only'). Only when it is not configured (the
    // schema default '/api-gw/v1' stands) does the old '/api' behaviour apply (0.1.1 talking to the
    // host's native apiproxy); every existing config writes prefix: /api explicitly, so nothing changes.
    const prefix = driver === 'apiproxy' && ep.prefix === '/api-gw/v1' ? '/api' : ep.prefix
    const sandboxBase = ep.sandbox_base === undefined ? null : ep.sandbox_base.replace(/\/+$/, '')
    const sandboxKey = ep.sandbox_key_ref !== '' ? (process.env[ep.sandbox_key_ref] ?? '') : ''
    if (sandboxBase !== null && sandboxKey === '') {
      throw new Error(`endpoint "${id}": env var ${ep.sandbox_key_ref} is empty; it must match one entry of the gateway's apiKeys`)
    }
    // Hive P1: the node's process lifecycle config. managed: true means the manager really spawns
    // this DSH process -- command/args must point at dsh's bin.js plus that node's own profile.
    const spawnRaw = ep.spawn
    // Capability two: a per-node pin must resolve in the matrix, fail-loud (an unknown version is never installed quietly).
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
      // Capability three v1: explicit tunnel metadata mapping (snake_case -> camelCase); absent = null
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
    const endpoint = endpoints[a.endpoint]
    if (endpoint === undefined) {
      throw new Error(`agent "${id}": unknown endpoint "${a.endpoint}"`)
    }
    // A remote workspace must **not** be resolved against the manager's own filesystem (a real
    // incident, 2026-09-28): `resolve('/home/dac/ws')` becomes `C:\home\dac\ws` on Windows, so the
    // node's session.create rejects it outright ('cwd must be an absolute path') -- and for a
    // non-root user it also left an odd directory with a Windows-style name on that Linux box, the
    // fossil of this bug. A remote agent's path belongs to **that machine's** namespace: pass it through.
    const remoteWorkspace = endpoint.spawn?.runner === 'agent'
    if (remoteWorkspace && !/^\/|^[A-Za-z]:[\\/]/.test(a.workspace)) {
      throw new Error(
        `agent "${id}": workspace "${a.workspace}" must be an absolute path on the remote machine ` +
          '(runner: agent keeps the path verbatim; relative paths cannot be resolved there).',
      )
    }
    agents[id] = {
      id,
      name: a.name,
      endpoint: a.endpoint,
      workspacePath: remoteWorkspace ? a.workspace : resolve(a.workspace),
      public: a.public,
      preset: a.preset ?? null,
      sandboxMode: a.sandbox_mode ?? null,
      gitRemote: a.git_remote ?? null,
      provider: a.provider ?? null,
      model: a.model ?? null,
      // Debt E12: rules moved out of code -- absent in config = generic credential checks only; explicit snake_case mapping
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

  // Hive P0: an agent declaring a sandbox mode must sit on an endpoint with a sandbox route,
  // otherwise the declaration would be ignored silently (fail loud at boot).
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

  // The rule (internal design library `manager/topics/CONCEPTS-ALIGNED.md` §1, user 2026-09-27):
  // **one DSH process = one agent**. Not tidiness but a precondition of isolation -- DSH's sandbox
  // root is **per process** (`sandboxPolicy.workspaceRoot` is process-global, see below) and the
  // apiproxy mux broadcasts every chat per process, so two agents in one process read each other's
  // workspace and share one visibility domain. An outward agent must be alone: only then are all
  // of its chats outward-facing.
  //
  // Hence the two historical red lines (mixing public and private / no public agent behind apiproxy)
  // are no longer needed: with one agent per process neither can happen. The old error
  // 'Use a gateway-mode endpoint for public agents' is dead too (facade 0.2.x removed the chat
  // REST surface, see the head of `src/gateway/client.ts` and the fact card §15) and sends users
  // down a blind alley -- so it went with the red lines, leaving only the hard constraint below.
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
  // P0 (hive/plan-config-version-switch): upgrade migration here -- an old config is translated
  // into the new structure and written back (the original is backed up as .pre-mig.bak); notes go to warnings.
  warnings.push(...migration.warnings)
  // Blind-alley warning (fact card `manager/facts/dsh-facts.md` §15, observed 2026-09-27): the
  // gateway driver depends on the old `dsh-api-gateway` chat REST surface (`POST /sessions`...),
  // which facade 0.2.3 removed (`GET /health` -> 200, `POST /sessions` -> 404). Such an endpoint
  // probes green and 404s on the first message -- the hardest 'half-dead' state to trace, so shout at boot.
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

  // Model pinning (`provider` + `model`) is the pair the apiproxy wire needs to land a selection on
  // the host session (session.selectModel takes both, and the manager must not guess a provider).
  // Three rules, all fail-loud, because every one of them is otherwise discovered as a **wrong or
  // missing number on the cost ledger** -- the least traceable kind of failure there is:
  //   1. half a pin (one of the two) is never a real intent: it silently falls back to the host's own
  //      default, so the config would claim a model the host is not running;
  //   2. an outward agent must be pinned at all: public traffic has to be predictable in behaviour and
  //      in price, and an unpinned agent has nothing for the manager to read back;
  //   3. the pinned model must have a rate in `pricing.models`, otherwise "cost unknown" is wired in
  //      at configuration time rather than being an honest gap for some one-off run.
  const pricedModels = new Set(Object.keys(pricing.rates))
  for (const [agentId, agent] of Object.entries(agents)) {
    const pinned = agent.provider !== null && agent.model !== null
    if ((agent.provider === null) !== (agent.model === null)) {
      throw new Error(
        `agent "${agentId}": provider and model must be set together (got provider=${JSON.stringify(agent.provider)}, ` +
          `model=${JSON.stringify(agent.model)}). One without the other cannot be landed on the host ` +
          '(session.selectModel needs both), so it would silently keep the host default.',
      )
    }
    if (!pinned && agent.public) {
      throw new Error(
        `agent "${agentId}" is public but pins no model. An outward agent must declare provider + model ` +
          '(e.g. provider: deepseek-official, model: deepseek-v4-flash): its price and behaviour have to be ' +
          'predictable, and the manager can only account a turn for the model the host confirms ' +
          '(CONCEPTS-ALIGNED.md §8.5).',
      )
    }
    if (pinned && agent.public && !pricedModels.has(agent.model as string) && !pricedModels.has(`${agent.provider}/${agent.model}`)) {
      throw new Error(
        `agent "${agentId}" is public and pins ${agent.provider}/${agent.model}, but pricing.models has no rate for it. ` +
          `Add pricing.models.${agent.model} (or the "${agent.provider}/${agent.model}" key), otherwise every ` +
          'outward turn is recorded with a null cost.',
      )
    }
  }

  const password = process.env.MANAGER_INITIAL_PASSWORD ?? ''

  // Outward services: members must be **existing public agents**. A member left unmarked turns the
  // service silently into 'nobody gets in'; a cross-service or unknown member is a typo -- both fail loud.
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
      // Whitespace-only counts as absent: an empty voice adds nothing to the delivered rules.
      ...(svc.persona === undefined || svc.persona.trim() === '' ? {} : { persona: svc.persona.trim() }),
      // The thresholds are always the full trio (global defaults with the service's entries on top):
      // the placer gets a fixed set and never merges per call site -- the merge rule lives here only.
      thresholds: {
        minFreeCpuPercent: svc.thresholds?.min_free_cpu_percent ?? DEFAULT_THRESHOLDS.minFreeCpuPercent,
        minFreeMemBytes: svc.thresholds?.min_free_mem_bytes ?? DEFAULT_THRESHOLDS.minFreeMemBytes,
        minFreeDiskBytes: svc.thresholds?.min_free_disk_bytes ?? DEFAULT_THRESHOLDS.minFreeDiskBytes,
      },
    })

    // Declaration checks for service-level scheduling (§8). All fail-loud: ignored silently, such
    // errors show up as 'fewer agents than declared / spread onto the wrong machines', untraceable later.
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
    // §8.2: the agent source is **one of two** -- count + a template so DAC creates them, or the
    // full list used as is. Auto-creation is not implemented yet, so only a full list is accepted;
    // otherwise 'three declared, one running' is silent under-provisioning (symptom: an outward 429).
    if (svc.count !== svc.workers.length) {
      throw new Error(
        `service "${svc.id}": count=${svc.count} but ${svc.workers.length} worker(s) listed. ` +
          'Automatic agent provisioning is not implemented yet, so list every agent and set count to ' +
          'match (CONCEPTS-ALIGNED.md §8.2).',
      )
    }
  }

  // Machine-level isolation (§4.5, the third boundary; user 2026-09-27: 'block it in config too').
  //
  // The endpoint-level rule only covers 'same process'; this machine layer covers 'file visibility
  // under one OS user': DSH does not isolate file reads, so two agents on one machine read each
  // other's workspace and credentials even with a process each. Two constraints:
  //   1. one machine cannot hold both an outward agent and an inward one;
  //   2. one machine cannot belong to two outward services at once (a cross-service injection surface).
  // An outward agent in no service is exempt from rule 2 (config is written in two steps: create the
  // agent, then attach it to a service; once attached, the rule takes effect on the next load).
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

  // Facade and backend cannot share a port: on a real clash the facade never starts, and 'the API is gone' is harder to trace than a failed start.
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
      outwardTimeoutMs: file.runner.outward_timeout_minutes * 60_000,
      maxConsecutiveFailures: file.runner.max_consecutive_failures,
      // Money is integer micro-USD everywhere past this line, so no float ever
      // reaches a comparison or the database.
      dailyBudgetMicroUsd:
        file.runner.daily_budget_usd === undefined ? null : Math.round(file.runner.daily_budget_usd * USD_TO_MICRO),
    },
    databasePath: resolve(file.database.path),
    // Debt A5: the source-of-truth paths are derived here only and read project-wide
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
