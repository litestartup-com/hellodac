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
  // 7 -- 蜂群 P2：主脑派工的来源会话（delegation 帧按它归属到主脑会话页）
  [
    `ALTER TABLE run ADD COLUMN source_chat_id TEXT REFERENCES chat(id) ON DELETE SET NULL`,
    `CREATE INDEX IF NOT EXISTS run_source_chat ON run(source_chat_id, started_at)`,
  ],
  // 8 -- 蜂群 P5.4：同 agent 多会话并发。
  // 「每 agent 一活 run」的唯一索引退役：DSH 自身的会话名额（maxSessions）
  // 是天然上限，manager 不再人为串行。conflict 列记录并发写冲突的显性化。
  [
    `DROP INDEX IF EXISTS run_one_live_per_agent`,
    `ALTER TABLE run ADD COLUMN conflict TEXT`,
  ],
  // 9 -- 蜂群 P5.3：站内通知（铃铛）
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
  // 10 -- 蜂群2计划 P3：首登强制改密（既有账号也转正一次：初始/随机密码都得换）
  [
    `ALTER TABLE user ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 1`,
  ],
  // 11 -- 蜂群2计划 P3：审计留痕（登录/改密/节点操作/备份）
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
  // 12 -- 债务 B5：brain 派工日账单与按 trigger 的 run 列表走索引
  [
    `CREATE INDEX IF NOT EXISTS run_trigger_started ON run(trigger, started_at)`,
  ],
  // 13 -- 债务 D1：api_key 表与 run.api_key_id 列全链路无读写(死代码)——删除。
  // 北向对外 API 属 M6 路线图,届时按真实契约重新设计(迁移只进不退,不复用旧表)。
  [
    `ALTER TABLE run DROP COLUMN api_key_id`,
    `DROP TABLE IF EXISTS api_key`,
  ],
  // 14 -- 沙箱覆盖延迟生效（2026-09-11）：宿主的 sandbox-mode 只能钉 live 会话，
  // 回合间隙会话转冷 → 用户切权限记在 chat 行，下回合创建/唤醒时由 runner 钉入。
  [
    `ALTER TABLE chat ADD COLUMN access_mode_override TEXT`,
  ],
  // 15 -- 权限展示真相源（2026-09-11）：chat 行记 manager 最后一次钉入的沙箱模式。
  // 宿主的 permissions 投影里 preset 是「最后选择预置」的意图标签，旋钮漂移后
  // （preset=read-only + sandbox=danger-full-access）推导值= custom，反推不出真实
  // 沙箱。用户拍板的权限真相以 manager 为准：钉入成功或延迟时落此列，composer
  // 展示用它覆盖宿主推导值，再退 agent 配置默认。
  [
    `ALTER TABLE chat ADD COLUMN access_mode TEXT`,
  ],
  // 16 -- 能力四（舰队）：node-agent 目录与一次性 join token（M1-2）。
  // agent_machine = 每台服务器的 agent 身份；token 只存哈希；revoked_at 吊销。
  // agent_join_token = 一次性注册 token（15 分钟过期，manager UI 签发）。
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
  // 17 -- 能力四（舰队）：agent 指令队列（M1-3）。
  // manager 入队 → agent 长轮询领取（delivered）→ 结果回报（done/failed）。
  // 持久化队列：manager 重启不丢指令；payload/result 均 JSON 文本。
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
  // 18 -- 能力四（舰队 M4-1）：agent token 轮换宽限位。
  // 轮换 = 主 token 换新 + 旧 token 进 prev 位（30 分钟宽限，防 ack 丢失把机器
  // 打砖）；agent 报 config.deliver 成功 → 清 prev；报失败 → 回滚主 token。
  [
    `ALTER TABLE agent_machine ADD COLUMN prev_token_hash TEXT`,
    `ALTER TABLE agent_machine ADD COLUMN prev_set_at INTEGER`,
  ],
  // 19 -- 能力四（舰队 M4-3）：agent 运行时版本（自更新协商告警用）。
  // 注册/心跳上报 agentVersion；机器页据此显示「待更新」徽标。
  [
    `ALTER TABLE agent_machine ADD COLUMN agent_version TEXT`,
  ],
  // 20 -- 能力四（舰队 M4-4）：主机指标趋势（CPU/内存/磁盘随心跳上报）。
  // 60s 采样；manager 侧保留 7 天自动清理。cpu_percent 为 ×10 整数（125 = 12.5%）。
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
  // 21 -- 发布前优化（2026-09-26）：清掉存量指令的 payload。
  // `agent_command.payload` 是 DB 体积唯一的大头：生产实测 126 行占 32.8 MB /
  // 全库 34 MB，其中 99 条 node.spawn 平均 273 KB（整份 DSH profile bundle 塞在
  // payload.profile 里）。领取路径只读 state='pending'，终态行再也没人读 payload，
  // 但行永久保留，并同步放大每一次加密备份（备份是全库快照）。
  // 新写入由 routes/agents.ts 的终态更新就地清空；这条只处理存量，幂等可重跑。
  [
    `UPDATE agent_command SET payload = '{}' WHERE state IN ('done', 'failed')`,
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
