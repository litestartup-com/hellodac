/**
 * 蜂群2计划 P3：审计留痕 —— 登录成败 / 改密 / 节点操作 / 备份。
 * 只追加不修改（append-only）；行数由保留策略控制（未来做轮转，本版先全留）。
 */
import { desc } from 'drizzle-orm'
import { schema, type Db } from './db/index.js'

export type AuditKind =
  | 'login_success'
  | 'login_failed'
  | 'password_change'
  | 'node_create'
  | 'node_create_host'
  | 'node_delete'
  | 'node_up'
  | 'node_down'
  | 'node_restart'
  | 'node_access_update'
  | 'node_align_version'
  | 'node_version_change'
  | 'agent_join_issued'
  | 'agent_registered'
  | 'agent_revoked'
  | 'agent_token_rotated'
  | 'agent_update_requested'
  | 'agent_deleted'
  | 'sandbox_mode'
  | 'backup'

export const recordAudit = (db: Db, entry: { actor: string; kind: AuditKind; detail: string }): void => {
  db.insert(schema.auditLog).values({ at: Date.now(), actor: entry.actor, kind: entry.kind, detail: entry.detail }).run()
}

export const listAudit = (db: Db, limit = 200): Array<{ id: number; at: number; actor: string; kind: string; detail: string }> =>
  db.select().from(schema.auditLog).orderBy(desc(schema.auditLog.at)).limit(limit).all()
