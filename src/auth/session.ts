import { createHash, randomBytes } from 'node:crypto'
import { and, eq, lt } from 'drizzle-orm'
import type { Db } from '../db/index.js'
import { schema } from '../db/index.js'

export const COOKIE_NAME = 'mgr_sid'
const TTL_MS = 30 * 24 * 60 * 60 * 1000

/**
 * The cookie carries a 256-bit random token; the database stores only its
 * sha256. A stolen database therefore cannot be replayed as a live login.
 */
const digest = (token: string): string => createHash('sha256').update(token).digest('hex')

export interface SessionUser {
  id: number
  username: string
  /** 蜂群2计划 P3：首登强制改密标记（requireUser 按它放行/拦截）。 */
  mustChangePassword: boolean
}

export const issueSession = (db: Db, userId: number): { token: string; expiresAt: number } => {
  const token = randomBytes(32).toString('base64url')
  const now = Date.now()
  const expiresAt = now + TTL_MS
  db.insert(schema.session).values({ id: digest(token), userId, expiresAt, createdAt: now }).run()
  return { token, expiresAt }
}

export const resolveSession = (db: Db, token: string | undefined): SessionUser | null => {
  if (token === undefined || token === '') return null
  const id = digest(token)
  const rows = db
    .select({
      userId: schema.session.userId,
      expiresAt: schema.session.expiresAt,
      username: schema.user.username,
      mustChangePassword: schema.user.mustChangePassword,
    })
    .from(schema.session)
    .innerJoin(schema.user, eq(schema.user.id, schema.session.userId))
    .where(eq(schema.session.id, id))
    .all()
  const row = rows[0]
  if (row === undefined) return null
  if (row.expiresAt <= Date.now()) {
    db.delete(schema.session).where(eq(schema.session.id, id)).run()
    return null
  }
  return { id: row.userId, username: row.username, mustChangePassword: row.mustChangePassword === 1 }
}

export const revokeSession = (db: Db, token: string | undefined): void => {
  if (token === undefined || token === '') return
  db.delete(schema.session).where(eq(schema.session.id, digest(token))).run()
}

/** Called at boot so an abandoned instance does not accumulate dead rows. */
export const pruneExpiredSessions = (db: Db): number => {
  const result = db.delete(schema.session).where(lt(schema.session.expiresAt, Date.now())).run()
  return result.changes
}

export const revokeAllForUser = (db: Db, userId: number): void => {
  db.delete(schema.session).where(and(eq(schema.session.userId, userId))).run()
}
