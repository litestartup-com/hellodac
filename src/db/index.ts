import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema.js'

export type Db = ReturnType<typeof drizzle<typeof schema>>

/**
 * Migrations are plain SQL applied in order, tracked by `schema_version`.
 *
 * Deliberately not using drizzle-kit's generated migrations at boot: a first run
 * must succeed with `npm install && npm run dev` and nothing else. Drizzle is
 * still used for all queries, so the type safety is unaffected.
 *
 * Append-only: never edit a released step, always add a new one.
 */
const MIGRATIONS: readonly string[][] = [
  // 1 -- initial schema
  [
    `CREATE TABLE IF NOT EXISTS user (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       username TEXT NOT NULL UNIQUE,
       password_hash TEXT NOT NULL,
       created_at INTEGER NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS session (
       id TEXT PRIMARY KEY,
       user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
       expires_at INTEGER NOT NULL,
       created_at INTEGER NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS session_expires ON session(expires_at)`,
    `CREATE TABLE IF NOT EXISTS agent (
       id TEXT PRIMARY KEY,
       name TEXT NOT NULL,
       workspace_path TEXT NOT NULL,
       endpoint TEXT NOT NULL,
       preset TEXT,
       git_remote TEXT,
       public INTEGER NOT NULL DEFAULT 0,
       created_at INTEGER NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS api_key (
       id TEXT PRIMARY KEY,
       name TEXT NOT NULL,
       key_hash TEXT NOT NULL,
       scope_agents TEXT NOT NULL,
       scope_actions TEXT NOT NULL,
       quota_tokens_day INTEGER,
       quota_runs_day INTEGER,
       revoked INTEGER NOT NULL DEFAULT 0,
       created_at INTEGER NOT NULL,
       last_used_at INTEGER
     )`,
    `CREATE TABLE IF NOT EXISTS cron (
       id TEXT PRIMARY KEY,
       agent_id TEXT NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
       name TEXT NOT NULL,
       schedule TEXT NOT NULL,
       timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
       prompt TEXT NOT NULL,
       enabled INTEGER NOT NULL DEFAULT 1,
       consecutive_failures INTEGER NOT NULL DEFAULT 0,
       last_run_at INTEGER
     )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS cron_agent_name ON cron(agent_id, name)`,
    `CREATE TABLE IF NOT EXISTS run (
       id TEXT PRIMARY KEY,
       agent_id TEXT NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
       cron_id TEXT,
       api_key_id TEXT,
       dsh_session_id TEXT,
       trigger TEXT NOT NULL,
       idempotency_key TEXT,
       state TEXT NOT NULL,
       result_summary TEXT,
       started_at INTEGER NOT NULL,
       ended_at INTEGER,
       error TEXT
     )`,
    // Retrying an outward API call must never make an agent do the work twice.
    `CREATE UNIQUE INDEX IF NOT EXISTS run_idem ON run(agent_id, idempotency_key)
       WHERE idempotency_key IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS run_agent_state ON run(agent_id, state)`,
    `CREATE INDEX IF NOT EXISTS run_started ON run(started_at)`,
    `CREATE TABLE IF NOT EXISTS usage_record (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       run_id TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
       provider TEXT,
       model TEXT,
       input_tokens INTEGER NOT NULL DEFAULT 0,
       output_tokens INTEGER NOT NULL DEFAULT 0,
       cache_read INTEGER,
       cache_write INTEGER,
       reasoning_tokens INTEGER,
       cost INTEGER,
       at INTEGER NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS usage_at ON usage_record(at)`,
    `CREATE INDEX IF NOT EXISTS usage_run ON usage_record(run_id)`,
  ],
  // 2 -- one live run per agent
  [
    // The in-process lock cannot survive a restart, and two concurrent turns in
    // one workspace would interleave writes to the same files. This index is the
    // authority; the lock is only a fast path with a clearer error.
    `CREATE UNIQUE INDEX IF NOT EXISTS run_one_live_per_agent ON run(agent_id)
       WHERE state IN ('pending', 'running')`,
  ],
  // 3 -- multi-turn chats
  [
    // A chat owns exactly one long-lived DSH session and many turns. The session
    // id is nullable because a chat exists from the moment the user opens it,
    // while the gateway session is only created when the first message is sent.
    //
    // `removed_at` rather than DELETE, and the session id survives it. Removing
    // a chat hands the gateway slot back but does not destroy the transcript,
    // which stays on the gateway and stays reachable through this id. Dropping
    // the row would lose the only pointer to a conversation that still exists.
    `CREATE TABLE IF NOT EXISTS chat (
       id TEXT PRIMARY KEY,
       agent_id TEXT NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
       dsh_session_id TEXT,
       title TEXT,
       created_at INTEGER NOT NULL,
       last_active_at INTEGER NOT NULL,
       removed_at INTEGER
     )`,
    // The sidebar lists an agent's chats newest-first, so order by the same key.
    `CREATE INDEX IF NOT EXISTS chat_agent_active ON chat(agent_id, last_active_at)`,
    // Looking a chat up by the gateway session id is how an inbound stream frame
    // is attributed back to a chat.
    `CREATE UNIQUE INDEX IF NOT EXISTS chat_session ON chat(dsh_session_id)
       WHERE dsh_session_id IS NOT NULL`,
    // Turns keep living in `run`, so the cost ledger, cron and the outward API
    // all keep working untouched. A chat is only the thread that groups them.
    `ALTER TABLE run ADD COLUMN chat_id TEXT REFERENCES chat(id) ON DELETE SET NULL`,
    `CREATE INDEX IF NOT EXISTS run_chat ON run(chat_id, started_at)`,
  ],
  // 4 -- peak / off-peak split
  [
    // DeepSeek bills V4 at two rates, peak being exactly double off-peak for 7
    // of every 24 hours. Knowing the split is what makes "move this cron two
    // hours earlier" a decision rather than a guess.
    //
    // It has to be stored: `at` is when the run ended, but a turn is priced per
    // response and a long turn can straddle a boundary, so the split cannot be
    // recomputed from one timestamp. Existing rows keep NULL -- they were
    // written before rates were configured and their cost is unknown, which is
    // the honest value.
    `ALTER TABLE usage_record ADD COLUMN peak_cost INTEGER`,
  ],
  // 5 -- the commit each run produced
  [
    // Without this the snapshot is invisible for the runs nobody watches. A cron
    // run's outcome is returned to no one, so `git log --grep=<run id>` would be
    // the only way to find what it changed. Storing the hash makes the run list
    // answer "what did this actually do to my files".
    //
    // NULL means the run changed nothing, or that no snapshot could be taken;
    // those are different states and `error` carries the reason for the latter.
    `ALTER TABLE run ADD COLUMN commit_hash TEXT`,
  ],
  // 6 -- what a schedule has to remember between runs
  [
    // Ordering by name puts "weekly-review" above "trade-log" for no reason the
    // operator can see. Creation order is at least stable and meaningful.
    `ALTER TABLE cron ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0`,
    // A cron run reports to nobody, so "it failed three times" is useless
    // without the reason. This is the only place the cause survives.
    `ALTER TABLE cron ADD COLUMN last_error TEXT`,
    // The one thing that must never be ambiguous: whether *you* switched this
    // off or the manager did. Same `enabled = 0` either way, and a bare toggle
    // sitting off would read as your own decision.
    `ALTER TABLE cron ADD COLUMN disabled_reason TEXT`,
    // Answers "did it run yet today" without scanning the run table, and is what
    // the missed-occurrence count at boot is measured from.
    `ALTER TABLE cron ADD COLUMN last_state TEXT`,
  ],
  // 7 -- Hive P2: the source chat of a brain dispatch (a delegation frame is attributed to the brain chat page by it)
  [
    `ALTER TABLE run ADD COLUMN source_chat_id TEXT REFERENCES chat(id) ON DELETE SET NULL`,
    `CREATE INDEX IF NOT EXISTS run_source_chat ON run(source_chat_id, started_at)`,
  ],
  // 8 -- Hive P5.4: several chats of the same agent run concurrently.
  // The unique index for "one live run per agent" is retired: DSH's own session seats (maxSessions)
  // are the natural ceiling, and the manager no longer serializes by hand. The conflict column records concurrent write conflicts explicitly.
  [
    `DROP INDEX IF EXISTS run_one_live_per_agent`,
    `ALTER TABLE run ADD COLUMN conflict TEXT`,
  ],
  // 9 -- Hive P5.3: in-app notifications (the bell)
  [
    `CREATE TABLE IF NOT EXISTS notification (
       id TEXT PRIMARY KEY,
       kind TEXT NOT NULL,
       title TEXT NOT NULL,
       body TEXT NOT NULL,
       link TEXT,
       at INTEGER NOT NULL,
       read INTEGER NOT NULL DEFAULT 0
     )`,
    `CREATE INDEX IF NOT EXISTS notification_at ON notification(at)`,
  ],
  // 10 -- Hive plan 2 P3: forced password change on first login (existing accounts are converted once too: an initial or random password has to be changed)
  [
    `ALTER TABLE user ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 1`,
  ],
  // 11 -- Hive plan 2 P3: the audit trail (login / password change / node operations / backups)
  [
    `CREATE TABLE IF NOT EXISTS audit_log (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       at INTEGER NOT NULL,
       actor TEXT NOT NULL,
       kind TEXT NOT NULL,
       detail TEXT NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS audit_at ON audit_log(at)`,
  ],
  // 12 -- Debt B5: daily brain dispatch billing and the run list by trigger go through an index
  [
    `CREATE INDEX IF NOT EXISTS run_trigger_started ON run(trigger, started_at)`,
  ],
  // 13 -- Debt D1: the api_key table and the run.api_key_id column had no reads or writes anywhere (dead code) -- dropped.
  // The northbound outward API belongs to the M6 roadmap, and will be redesigned against the real contract then (migrations only move forward, so the old tables are not reused).
  [
    `ALTER TABLE run DROP COLUMN api_key_id`,
    `DROP TABLE IF EXISTS api_key`,
  ],
  // 14 -- Sandbox overrides take effect late (2026-09-11): the host's sandbox-mode can only pin a live chat,
  // and a chat goes cold between turns -> a permission switch is recorded on the chat row, and the runner pins it when the next turn creates or wakes the chat.
  [
    `ALTER TABLE chat ADD COLUMN access_mode_override TEXT`,
  ],
  // 15 -- The truth source for the permission display (2026-09-11): the chat row records the sandbox mode the manager pinned last.
  // In the host's permissions projection, preset is the intent label of "the preset chosen last", and once the knobs drift
  // (preset=read-only + sandbox=danger-full-access) the derived value is custom, which cannot be inverted back to the real
  // sandbox. The permission truth the user settled on is the manager's: this column is written when the pin succeeds or is
  // deferred, the composer shows it in place of the host's derived value, and only then falls back to the agent config default.
  [
    `ALTER TABLE chat ADD COLUMN access_mode TEXT`,
  ],
  // 16 -- Capability four (Fleet): the node-agent directory and the one-shot join token (M1-2).
  // agent_machine = one agent identity per server; only the token hash is stored; revoked_at revokes it.
  // agent_join_token = a one-shot registration token (expires in 15 minutes, issued from the manager UI).
  [
    `CREATE TABLE IF NOT EXISTS agent_machine (
       id TEXT PRIMARY KEY,
       hostname TEXT NOT NULL,
       os TEXT NOT NULL,
       arch TEXT NOT NULL,
       node_version TEXT NOT NULL,
       token_hash TEXT NOT NULL,
       joined_at INTEGER NOT NULL,
       last_seen_at INTEGER,
       revoked_at INTEGER
     )`,
    `CREATE INDEX IF NOT EXISTS agent_machine_seen ON agent_machine(last_seen_at)`,
    `CREATE TABLE IF NOT EXISTS agent_join_token (
       token_hash TEXT PRIMARY KEY,
       expires_at INTEGER NOT NULL,
       used_at INTEGER,
       created_at INTEGER NOT NULL
     )`,
  ],
  // 17 -- Capability four (Fleet): the agent command queue (M1-3).
  // The manager enqueues -> the agent claims it by long polling (delivered) -> the result is reported back (done/failed).
  // A durable queue: a manager restart loses no command; payload and result are both JSON text.
  [
    `CREATE TABLE IF NOT EXISTS agent_command (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       agent_id TEXT NOT NULL,
       type TEXT NOT NULL,
       payload TEXT NOT NULL,
       state TEXT NOT NULL DEFAULT 'pending',
       result TEXT,
       created_at INTEGER NOT NULL,
       delivered_at INTEGER,
       done_at INTEGER
     )`,
    `CREATE INDEX IF NOT EXISTS agent_command_pending ON agent_command(agent_id, state)`,
  ],
  // 18 -- Capability four (Fleet M4-1): the grace slot for agent token rotation.
  // A rotation = the main token is replaced and the old one moves into the prev slot (a 30-minute grace period, so a lost
  // ack does not brick the machine); the agent reports config.deliver success -> prev is cleared; a failure -> the main token is rolled back.
  [
    `ALTER TABLE agent_machine ADD COLUMN prev_token_hash TEXT`,
    `ALTER TABLE agent_machine ADD COLUMN prev_set_at INTEGER`,
  ],
  // 19 -- Capability four (Fleet M4-3): the agent runtime version (used for the self-update negotiation warning).
  // Registration and heartbeat report agentVersion; the machines page shows the "update pending" badge from it.
  [
    `ALTER TABLE agent_machine ADD COLUMN agent_version TEXT`,
  ],
  // 20 -- Capability four (Fleet M4-4): host metric trends (CPU / memory / disk reported with the heartbeat).
  // Sampled every 60s; the manager keeps 7 days and cleans up automatically. cpu_percent is an integer x10 (125 = 12.5%).
  [
    `CREATE TABLE IF NOT EXISTS agent_metric (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       agent_id TEXT NOT NULL,
       at INTEGER NOT NULL,
       cpu_percent INTEGER,
       mem_total INTEGER,
       mem_used INTEGER,
       disk_total INTEGER,
       disk_free INTEGER,
       uptime INTEGER,
       platform TEXT
     )`,
    `CREATE INDEX IF NOT EXISTS agent_metric_agent_at ON agent_metric(agent_id, at)`,
  ],
  // 21 -- Pre-release optimization (2026-09-26): clear the payload of the commands already stored.
  // `agent_command.payload` is the one big contributor to database size: in production 126 rows took 32.8 MB of the
  // 34 MB database, of which 99 node.spawn rows averaged 273 KB each (a whole DSH profile bundle stuffed into
  // payload.profile). The claim path only reads state='pending', so no one reads the payload of a terminal row again,
  // yet the rows are kept forever and every encrypted backup grows with them (a backup is a snapshot of the whole database).
  // New writes are cleared in place by the terminal update in routes/agents.ts; this one only handles what is already stored, and is idempotent and re-runnable.
  [
    `UPDATE agent_command SET payload = '{}' WHERE state IN ('done', 'failed')`,
  ],
  // 22 -- The outward API: the keys table + the attribution key (design doc manager/topics/public-api.md).
  // A key is revoked rather than deleted (revoked_at): the accounts and the audit have to reach a caller that was revoked; the run side still
  // uses ON DELETE SET NULL as a backstop, so really deleting a key does not turn the historical accounts into orphan rows.
  // quota_runs_day allows NULL = unlimited; the day boundary follows config.pricing.timezone (see auth/api-key.ts).
  [
    `CREATE TABLE IF NOT EXISTS api_key (
       id TEXT PRIMARY KEY,
       name TEXT NOT NULL,
       key_hash TEXT NOT NULL,
       scopes TEXT NOT NULL,
       scope_services TEXT NOT NULL,
       quota_runs_day INTEGER,
       rate_limit_rpm INTEGER NOT NULL DEFAULT 60,
       max_concurrency INTEGER NOT NULL DEFAULT 4,
       expires_at INTEGER,
       revoked_at INTEGER,
       last_used_at INTEGER,
       created_by TEXT NOT NULL,
       created_at INTEGER NOT NULL
     )`,
    `ALTER TABLE run ADD COLUMN api_key_id TEXT REFERENCES api_key(id) ON DELETE SET NULL`,
    // Both aggregating usage by key (the caller dimension of the spend page) and counting the daily quota go through this index.
    `CREATE INDEX IF NOT EXISTS run_api_key ON run(api_key_id, started_at)`,
  ],
  // 23 -- Outward chat ownership (the position in CONCEPTS-ALIGNED.md section 6): a chat has to remember "which key,
  // which user of the caller, which service" for stickiness to have an anchor, and for quota, billing and audit to have an owner.
  // All three columns null = an internal chat, so this is purely additive for existing data (no backfill, and old rows are not misread).
  [
    `ALTER TABLE chat ADD COLUMN api_key_id TEXT REFERENCES api_key(id) ON DELETE SET NULL`,
    `ALTER TABLE chat ADD COLUMN external_user_id TEXT`,
    `ALTER TABLE chat ADD COLUMN service_id TEXT`,
    // The stickiness lookup: find the chats still alive by (key, external user).
    `CREATE INDEX IF NOT EXISTS chat_api_key_user ON chat(api_key_id, external_user_id)`,
    // One and the same external user under one key can have only one live chat at a time -- a concurrent duplicate create
    // (a caller retry, or two open clients) is stopped by this unique index rather than by the race in "look it up, then insert".
    // A partial index: archived or removed chats (removed_at not null) take no part in uniqueness.
    `CREATE UNIQUE INDEX IF NOT EXISTS chat_api_key_user_live ON chat(api_key_id, external_user_id) WHERE removed_at IS NULL AND external_user_id IS NOT NULL`,
  ],
]

export interface OpenDbResult {
  db: Db
  sqlite: Database.Database
  applied: number[]
}

export const openDb = (path: string): OpenDbResult => {
  mkdirSync(dirname(path), { recursive: true })
  const sqlite = new Database(path)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('busy_timeout = 5000')

  sqlite.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)')
  const row = sqlite.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null }
  const current = row.v ?? 0

  const applied: number[] = []
  for (let i = current; i < MIGRATIONS.length; i += 1) {
    const version = i + 1
    const statements = MIGRATIONS[i]
    if (statements === undefined) continue
    const tx = sqlite.transaction(() => {
      for (const sql of statements) sqlite.exec(sql)
      sqlite.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(version, Date.now())
    })
    tx()
    applied.push(version)
  }

  return { db: drizzle(sqlite, { schema }), sqlite, applied }
}

export { schema }
