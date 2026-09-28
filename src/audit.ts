/**
 * Hive plan 2 P3: the audit trail -- login success and failure / password change / node operations / backups.
 * Append-only; the row count is bounded by the retention policy (rotation comes later, this version keeps everything).
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
  // The outward API (design doc manager/topics/public-api.md): key lifecycle and outward calls.
  | 'api_key_created'
  | 'api_key_revoked'
  | 'api_call'

export const recordAudit = (db: Db, entry: { actor: string; kind: AuditKind; detail: string }): void => {
  db.insert(schema.auditLog).values({ at: Date.now(), actor: entry.actor, kind: entry.kind, detail: entry.detail }).run()
}

export const listAudit = (db: Db, limit = 200): Array<{ id: number; at: number; actor: string; kind: string; detail: string }> =>
  db.select().from(schema.auditLog).orderBy(desc(schema.auditLog.at)).limit(limit).all()
