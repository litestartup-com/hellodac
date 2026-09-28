import { randomBytes } from 'node:crypto'
import { chmodSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from '../db/index.js'
import { schema } from '../db/index.js'
import { hashPassword, verifyPassword } from '../auth/password.js'
import { COOKIE_NAME, issueSession, resolveSession, revokeAllForUser, revokeSession } from '../auth/session.js'
import { recordAudit } from '../audit.js'
import { withConfigLock } from '../config-store.js'

/** Hive plan 2 P3: the CSRF double-submit cookie (not httpOnly; the frontend reads it into X-CSRF-Token). */
export const CSRF_COOKIE = 'dac_csrf'

/**
 * CSRF gate (P6 self-healing): a non-GET request must carry an X-CSRF-Token matching the cookie.
 * Upgrade healing: for an old session holding a valid session cookie but no csrf cookie (logged in
 * before the upgrade) the server reissues the cookie -- the frontend retries once with it, unseen.
 */
export const makeCsrfHook = (secure: boolean): preHandlerHookHandler => async (request, reply) => {
  const method = request.method ?? 'GET'
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return
  const url = (request.url ?? '').split('?')[0] ?? ''
  if (url === '/api/login' || url.startsWith('/api/internal/')) return

  const cookieToken = request.cookies[CSRF_COOKIE] ?? ''
  const hasSession = (request.cookies[COOKIE_NAME] ?? '') !== ''
  if (hasSession && cookieToken === '') {
    reply.setCookie(CSRF_COOKIE, randomBytes(24).toString('base64url'), { path: '/', sameSite: 'lax', secure })
  }
  const headerToken = request.headers['x-csrf-token']
  const headerValue = Array.isArray(headerToken) ? headerToken[0] : headerToken
  if (cookieToken === '' || headerValue !== cookieToken) {
    await reply.code(403).send({ error: 'csrf_token_missing_or_mismatch' })
  }
}

/**
 * P1-5: wipe the initial password from `.env` once the password change succeeds.
 *
 * It only matters while the DB has no user; after a password change it is a plaintext password left
 * on disk, and in container form that file is mounted rw. The key stays with an empty value (so the
 * shape of .env stays readable) and every other line, comments included, is kept as is.
 *
 * Same approach as workspace/writer: `.tmp` + rename (atomic); a failure only warns and never
 * affects the password change -- on a read-only mount or without permission the change itself must still succeed.
 */
export const clearInitialPassword = (envPath: string): boolean => {
  const text = readFileSync(envPath, 'utf8')
  const lines = text.split(/\r?\n/)
  let touched = false
  const next = lines.map((line) => {
    const match = /^(\s*MANAGER_INITIAL_PASSWORD\s*=)(.*)$/.exec(line)
    if (match === null || (match[2] ?? '') === '') return line
    touched = true
    return `${match[1]}`
  })
  if (!touched) return false
  const body = next.join(text.includes('\r\n') ? '\r\n' : '\n')
  const tmp = `${envPath}.tmp`
  writeFileSync(tmp, body, 'utf8')
  // 0600: same tightening as gen-env.sh on POSIX (a no-op on Windows)
  try {
    chmodSync(tmp, 0o600)
  } catch {
    // The permission model does not support it (Windows) -- not a failure
  }
  try {
    renameSync(tmp, envPath)
  } catch {
    // In container form `.env` is a **file-level bind mount** (compose: ./.env:/app/.env) and the
    // mount point cannot be replaced by a rename (EBUSY/EXDEV), so fall back to writing in place.
    // Atomicity yields to 'it works' here: this is cleanup, and all it does is blank one value.
    writeFileSync(envPath, body, 'utf8')
    try {
      unlinkSync(tmp)
    } catch {
      // A leftover .tmp does not affect correctness
    }
  }
  return true
}

const loginBody = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
})

const passwordBody = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(1).max(256),
})

export const registerAuthRoutes = (
  app: FastifyInstance,
  db: Db,
  secure: boolean,
  /** P1-5: the `.env` path whose initial password gets wiped after a change; omit to skip (tests, older callers). */
  envPath?: string,
): void => {
  app.post(
    '/api/login',
    {
      // Rate limited independently of everything else: this is the one endpoint
      // an attacker can hammer without credentials.
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const parsed = loginBody.safeParse(request.body)
      if (!parsed.success) return reply.code(400).send({ error: 'bad_request' })
      const { username, password } = parsed.data

      const rows = db.select().from(schema.user).where(eq(schema.user.username, username)).all()
      const found = rows[0]

      // Same generic message and comparable work whether or not the user
      // exists, so the response cannot be used to enumerate accounts.
      const ok = found === undefined ? false : await verifyPassword(found.passwordHash, password)
      if (!ok || found === undefined) {
        // Hive plan 2 P3: audit trail (also on failure; actor = the username attempted)
        recordAudit(db, { actor: username, kind: 'login_failed', detail: 'sign-in failed' })
        return reply.code(401).send({ error: 'invalid_credentials' })
      }
      recordAudit(db, { actor: username, kind: 'login_success', detail: 'signed in' })

      const { token, expiresAt } = issueSession(db, found.id)
      const csrf = randomBytes(24).toString('base64url')
      reply.setCookie(CSRF_COOKIE, csrf, { path: '/', sameSite: 'lax', secure, expires: new Date(expiresAt) })
      return reply
        .setCookie(COOKIE_NAME, token, {
          path: '/',
          httpOnly: true,
          sameSite: 'lax',
          secure,
          expires: new Date(expiresAt),
        })
        .send({ ok: true, username: found.username, mustChangePassword: found.mustChangePassword === 1 })
    },
  )

  app.post('/api/logout', async (request, reply) => {
    revokeSession(db, request.cookies[COOKIE_NAME])
    return reply
      .clearCookie(COOKIE_NAME, { path: '/' })
      .clearCookie(CSRF_COOKIE, { path: '/' })
      .send({ ok: true })
  })

  app.get('/api/me', async (request, reply) => {
    const user = resolveSession(db, request.cookies[COOKIE_NAME])
    if (user === null) return reply.code(401).send({ error: 'unauthorized' })
    return reply.send({ username: user.username, mustChangePassword: user.mustChangePassword })
  })

  /**
   * Hive plan 2 P3: change the password -- the only way out of the forced first-login change.
   * Strength rule (D2): the new password is >= 10 characters; a success clears the forced flag.
   */
  app.post('/api/account/password', {
    // Debt S3: a password change is a vector for brute-forcing the current password with a session, so it is rate-limited like login.
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const user = resolveSession(db, request.cookies[COOKIE_NAME])
    if (user === null) return reply.code(401).send({ error: 'unauthorized' })
    const parsed = passwordBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request' })
    if (parsed.data.newPassword.length < 10) {
      recordAudit(db, { actor: user.username, kind: 'password_change', detail: 'failed: the new password is shorter than 10 characters' })
      return reply.code(400).send({ error: 'password_too_short' })
    }
    const rows = db.select().from(schema.user).where(eq(schema.user.id, user.id)).all()
    const found = rows[0]
    if (found === undefined) return reply.code(401).send({ error: 'unauthorized' })
    const ok = await verifyPassword(found.passwordHash, parsed.data.currentPassword)
    if (!ok) {
      recordAudit(db, { actor: user.username, kind: 'password_change', detail: 'failed: the current password is wrong' })
      return reply.code(403).send({ error: 'invalid_current_password' })
    }
    db.update(schema.user)
      .set({ passwordHash: await hashPassword(parsed.data.newPassword), mustChangePassword: 0 })
      .where(eq(schema.user.id, user.id))
      .run()

    // P1-5: a new password must invalidate the old sessions -- otherwise the change cannot kick out
    // an attacker already holding a cookie and only tells them one more password. This device gets a
    // fresh session right after, so the operator is not logged out (same experience, better security).
    revokeAllForUser(db, user.id)
    const { token, expiresAt } = issueSession(db, user.id)
    const csrf = randomBytes(24).toString('base64url')
    reply.setCookie(CSRF_COOKIE, csrf, { path: '/', sameSite: 'lax', secure, expires: new Date(expiresAt) })
    reply.setCookie(COOKIE_NAME, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure,
      expires: new Date(expiresAt),
    })

    recordAudit(db, { actor: user.username, kind: 'password_change', detail: 'succeeded (other sessions were revoked)' })

    if (envPath !== undefined) {
      // Wiping the initial password is housekeeping, not a precondition of the change: a read-only mount or missing permission only warns.
      try {
        // Debt R6: .env writes all go through the locked entry (serialised with provision/setup config writes)
        await withConfigLock(() => clearInitialPassword(envPath))
        app.log.info('cleared MANAGER_INITIAL_PASSWORD from .env')
      } catch (error) {
        app.log.warn(`could not clear MANAGER_INITIAL_PASSWORD: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    return reply.send({ ok: true })
  })
}
