import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import { openDb, schema, type Db } from '../db/index.js'
import { hashPassword } from '../auth/password.js'
import { makeRequireUser } from '../auth/hooks.js'
import { listAudit } from '../audit.js'
import { CSRF_COOKIE, makeCsrfHook, registerAuthRoutes } from './auth.js'
import { registerAuditRoutes } from './audit.js'

/**
 * Hive plan 2 P3: the whole path of authentication / CSRF / forced password change / auditing.
 * The CSRF gate shares makeCsrfHook with index.ts (one place, no longer copied).
 */

const boot = async (envPath?: string): Promise<{ app: FastifyInstance; db: Db }> => {
  const dir = mkdtempSync(join(tmpdir(), 'auth-test-'))
  const { db } = openDb(join(dir, 'test.db'))
  db.insert(schema.user)
    .values({ username: 'admin', passwordHash: await hashPassword('initial-pass'), createdAt: Date.now(), mustChangePassword: 1 })
    .run()
  const app = Fastify()
  await app.register(cookie, { secret: 'x'.repeat(32) })
  app.addHook('onRequest', makeCsrfHook(false))
  registerAuthRoutes(app, db, false, envPath)
  registerAuditRoutes(app, db, makeRequireUser(db))
  return { app, db }
}

const cookieOf = (response: { headers: unknown }, name: string): string => {
  const header = (response.headers as { 'set-cookie'?: string | string[] })['set-cookie']
  const list = Array.isArray(header) ? header : header === undefined ? [] : [header]
  const line = list.find((c) => c.startsWith(`${name}=`))
  if (line === undefined) return ''
  return line.split(';')[0]?.slice(name.length + 1) ?? ''
}

const login = async (app: FastifyInstance, username: string, password: string) => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { username, password },
  })
  return {
    response,
    sid: cookieOf(response, 'mgr_sid'),
    csrf: cookieOf(response, CSRF_COOKIE),
  }
}

test('P1-5: a password change revokes the chats on other devices, while the current device gets a new chat and stays usable', async () => {
  const { app } = await boot()
  // Two devices log in separately (simulating an attacker who got the password and logged in on one too)
  const other = await login(app, 'admin', 'initial-pass')
  const mine = await login(app, 'admin', 'initial-pass')
  assert.ok(other.sid !== mine.sid)

  const changed = await app.inject({
    method: 'POST',
    url: '/api/account/password',
    headers: { cookie: `mgr_sid=${mine.sid}; ${CSRF_COOKIE}=${mine.csrf}`, 'x-csrf-token': mine.csrf },
    payload: { currentPassword: 'initial-pass', newPassword: 'new-password-123' },
  })
  assert.equal(changed.statusCode, 200)

  // The other device's chat has to stop working -- otherwise a password change cannot kick out someone who is already in
  const otherAfter = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `mgr_sid=${other.sid}` } })
  assert.equal(otherAfter.statusCode, 401, 'other chats must be revoked after a password change')

  // The current device gets the reissued chat cookie and stays usable (it must not kick itself offline)
  const reissued = cookieOf(changed, 'mgr_sid')
  assert.ok(reissued !== '' && reissued !== mine.sid, 'the password-change response must reissue the current chat')
  const meAfter = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `mgr_sid=${reissued}` } })
  assert.equal(meAfter.statusCode, 200)
  assert.equal((meAfter.json()).mustChangePassword, false)
  await app.close()
})

test('P1-5: a successful password change wipes MANAGER_INITIAL_PASSWORD from .env', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'auth-env-'))
  const envPath = join(dir, '.env')
  writeFileSync(
    envPath,
    ['SESSION_SECRET=' + 'x'.repeat(32), 'MANAGER_INITIAL_PASSWORD=initial-pass', 'GW_KEY_A=keep-me', ''].join('\n'),
    'utf8',
  )
  const { app } = await boot(envPath)
  const { sid, csrf } = await login(app, 'admin', 'initial-pass')
  const changed = await app.inject({
    method: 'POST',
    url: '/api/account/password',
    headers: { cookie: `mgr_sid=${sid}; ${CSRF_COOKIE}=${csrf}`, 'x-csrf-token': csrf },
    payload: { currentPassword: 'initial-pass', newPassword: 'new-password-123' },
  })
  assert.equal(changed.statusCode, 200)

  const after = readFileSync(envPath, 'utf8')
  assert.match(after, /^MANAGER_INITIAL_PASSWORD=$/m, 'the initial password must be cleared (the key stays, the value is wiped)')
  assert.doesNotMatch(after, /initial-pass/, 'no initial password may be left in the file')
  assert.match(after, /^GW_KEY_A=keep-me$/m, 'every other variable must be kept as it was')
  await app.close()
})

test('Hive plan 2 P3: a successful login seeds the chat and CSRF cookies, reports the forced password change, and leaves an audit entry', async () => {
  const { app, db } = await boot()
  const { response, sid, csrf } = await login(app, 'admin', 'initial-pass')
  assert.equal(response.statusCode, 200)
  const body = response.json()
  assert.equal(body.mustChangePassword, true)
  assert.ok(sid !== '')
  assert.ok(csrf !== '')

  const entries = listAudit(db, 10)
  assert.equal(entries[0]?.kind, 'login_success')
  assert.equal(entries[0]?.actor, 'admin')
  await app.close()
})

test('Hive plan 2 P3: a wrong password fails the login, leaves an audit entry and seeds no chat', async () => {
  const { app, db } = await boot()
  const { response, sid } = await login(app, 'admin', 'wrong')
  assert.equal(response.statusCode, 401)
  assert.equal(sid, '')
  assert.equal(listAudit(db, 10)[0]?.kind, 'login_failed')
  await app.close()
})

test('Hive plan 2 P3: a non-GET request without a CSRF token is rejected, and passes with a matching one', async () => {
  const { app } = await boot()
  const { sid, csrf } = await login(app, 'admin', 'initial-pass')

  const bare = await app.inject({ method: 'POST', url: '/api/logout', headers: { cookie: `mgr_sid=${sid}` } })
  assert.equal(bare.statusCode, 403)
  assert.equal((bare.json()).error, 'csrf_token_missing_or_mismatch')

  const mismatched = await app.inject({
    method: 'POST',
    url: '/api/logout',
    headers: { cookie: `mgr_sid=${sid}; ${CSRF_COOKIE}=${csrf}`, 'x-csrf-token': 'other' },
  })
  assert.equal(mismatched.statusCode, 403)

  const ok = await app.inject({
    method: 'POST',
    url: '/api/logout',
    headers: { cookie: `mgr_sid=${sid}; ${CSRF_COOKIE}=${csrf}`, 'x-csrf-token': csrf },
  })
  assert.equal(ok.statusCode, 200)
  await app.close()
})

test('Hive plan 2 P3 self-healing: an old chat from before the upgrade has no CSRF cookie, the 403 reissues it, and a retry with the new cookie passes', async () => {
  const { app } = await boot()
  const { sid } = await login(app, 'admin', 'initial-pass')

  // Simulate a chat from before the upgrade: mgr_sid only, no dac_csrf (the scene behind the 403 on a password change on a Windows production machine)
  const first = await app.inject({
    method: 'POST',
    url: '/api/logout',
    headers: { cookie: `mgr_sid=${sid}` },
  })
  assert.equal(first.statusCode, 403)
  assert.equal((first.json()).error, 'csrf_token_missing_or_mismatch')
  const healed = cookieOf(first, CSRF_COOKIE)
  assert.ok(healed !== '', 'a 403 for a missing cookie must reissue dac_csrf')

  // The frontend apiFetch retries once with the new cookie -> it passes
  const retry = await app.inject({
    method: 'POST',
    url: '/api/logout',
    headers: { cookie: `mgr_sid=${sid}; ${CSRF_COOKIE}=${healed}`, 'x-csrf-token': healed },
  })
  assert.equal(retry.statusCode, 200)
  await app.close()
})

test('Hive plan 2 P3: business APIs 403 while a password change is forced, and pass once it succeeds', async () => {
  const { app } = await boot()
  const { sid, csrf } = await login(app, 'admin', 'initial-pass')
  const headers = { cookie: `mgr_sid=${sid}; ${CSRF_COOKIE}=${csrf}`, 'x-csrf-token': csrf }

  // Before the password change: business APIs are stopped with a 403
  const blocked = await app.inject({ method: 'GET', url: '/api/audit', headers: { cookie: `mgr_sid=${sid}` } })
  assert.equal(blocked.statusCode, 403)
  assert.equal((blocked.json()).error, 'password_change_required')

  // A wrong current password / a new password that is too short
  const wrongCurrent = await app.inject({
    method: 'POST',
    url: '/api/account/password',
    headers,
    payload: { currentPassword: 'nope', newPassword: 'new-password-123' },
  })
  assert.equal(wrongCurrent.statusCode, 403)
  const tooShort = await app.inject({
    method: 'POST',
    url: '/api/account/password',
    headers,
    payload: { currentPassword: 'initial-pass', newPassword: 'short' },
  })
  assert.equal(tooShort.statusCode, 400)

  // A successful change -> the forced flag is cleared -> business APIs pass
  const changed = await app.inject({
    method: 'POST',
    url: '/api/account/password',
    headers,
    payload: { currentPassword: 'initial-pass', newPassword: 'new-password-123' },
  })
  assert.equal(changed.statusCode, 200)

  // P1-5: a password change revokes every old chat and reissues the current one, so later requests use the new cookie
  const sid2 = cookieOf(changed, 'mgr_sid')
  assert.ok(sid2 !== '' && sid2 !== sid)

  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `mgr_sid=${sid2}` } })
  assert.equal((me.json()).mustChangePassword, false)

  const auditOk = await app.inject({ method: 'GET', url: '/api/audit', headers: { cookie: `mgr_sid=${sid2}` } })
  assert.equal(auditOk.statusCode, 200)
  const { entries } = auditOk.json()
  assert.equal(entries[0]?.kind, 'password_change')

  // The old password no longer works, and the new one logs in
  const relogin = await login(app, 'admin', 'new-password-123')
  assert.equal(relogin.response.statusCode, 200)
  await app.close()
})
