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
 * 蜂群2计划 P3：认证/CSRF/强制改密/审计 全链路。
 * CSRF 门与 index.ts 共用 makeCsrfHook（单点，不再复制）。
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

test('P1-5: 改密吊销其它设备的会话，当前设备换发新会话继续可用', async () => {
  const { app } = await boot()
  // 两台设备各自登录（模拟：攻击者拿到口令后也登录了一台）
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

  // 另一台设备的会话必须失效——否则改密踢不掉已入侵的一方
  const otherAfter = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `mgr_sid=${other.sid}` } })
  assert.equal(otherAfter.statusCode, 401, '改密后其它会话必须被吊销')

  // 当前设备拿到换发的新会话 cookie，继续可用（不能把自己也踢下线）
  const reissued = cookieOf(changed, 'mgr_sid')
  assert.ok(reissued !== '' && reissued !== mine.sid, '改密响应必须换发当前会话')
  const meAfter = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `mgr_sid=${reissued}` } })
  assert.equal(meAfter.statusCode, 200)
  assert.equal((meAfter.json()).mustChangePassword, false)
  await app.close()
})

test('P1-5: 改密成功后从 .env 抹掉 MANAGER_INITIAL_PASSWORD', async () => {
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
  assert.match(after, /^MANAGER_INITIAL_PASSWORD=$/m, '初始密码必须被清空（键保留，值抹掉）')
  assert.doesNotMatch(after, /initial-pass/, '文件里不得再留初始口令')
  assert.match(after, /^GW_KEY_A=keep-me$/m, '其它变量必须原样保留')
  await app.close()
})

test('蜂群2计划 P3: 登录成功种会话+CSRF cookie，报强制改密，审计留痕', async () => {
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

test('蜂群2计划 P3: 密码错登录失败，审计留痕且不种会话', async () => {
  const { app, db } = await boot()
  const { response, sid } = await login(app, 'admin', 'wrong')
  assert.equal(response.statusCode, 401)
  assert.equal(sid, '')
  assert.equal(listAudit(db, 10)[0]?.kind, 'login_failed')
  await app.close()
})

test('蜂群2计划 P3: 非 GET 请求缺 CSRF 令牌被拒，带一致令牌放行', async () => {
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

test('蜂群2计划 P3 自愈: 升级前老会话缺 CSRF cookie，403 补发 cookie，带新 cookie 重试即放行', async () => {
  const { app } = await boot()
  const { sid } = await login(app, 'admin', 'initial-pass')

  // 模拟升级前的老会话：只有 mgr_sid、没有 dac_csrf（Windows 生产机改密报 403 的现场）
  const first = await app.inject({
    method: 'POST',
    url: '/api/logout',
    headers: { cookie: `mgr_sid=${sid}` },
  })
  assert.equal(first.statusCode, 403)
  assert.equal((first.json()).error, 'csrf_token_missing_or_mismatch')
  const healed = cookieOf(first, CSRF_COOKIE)
  assert.ok(healed !== '', '缺 cookie 的 403 必须补发 dac_csrf')

  // 前端 apiFetch 带新 cookie 重试一次 → 放行
  const retry = await app.inject({
    method: 'POST',
    url: '/api/logout',
    headers: { cookie: `mgr_sid=${sid}; ${CSRF_COOKIE}=${healed}`, 'x-csrf-token': healed },
  })
  assert.equal(retry.statusCode, 200)
  await app.close()
})

test('蜂群2计划 P3: 强制改密期间业务 API 403，改密成功后放行', async () => {
  const { app } = await boot()
  const { sid, csrf } = await login(app, 'admin', 'initial-pass')
  const headers = { cookie: `mgr_sid=${sid}; ${CSRF_COOKIE}=${csrf}`, 'x-csrf-token': csrf }

  // 改密前：业务 API 被 403 拦截
  const blocked = await app.inject({ method: 'GET', url: '/api/audit', headers: { cookie: `mgr_sid=${sid}` } })
  assert.equal(blocked.statusCode, 403)
  assert.equal((blocked.json()).error, 'password_change_required')

  // 当前密码错 / 新密码太短
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

  // 成功改密 → 清除强制标记 → 业务 API 放行
  const changed = await app.inject({
    method: 'POST',
    url: '/api/account/password',
    headers,
    payload: { currentPassword: 'initial-pass', newPassword: 'new-password-123' },
  })
  assert.equal(changed.statusCode, 200)

  // P1-5：改密吊销全部旧会话并换发当前会话，后续请求用新 cookie
  const sid2 = cookieOf(changed, 'mgr_sid')
  assert.ok(sid2 !== '' && sid2 !== sid)

  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `mgr_sid=${sid2}` } })
  assert.equal((me.json()).mustChangePassword, false)

  const auditOk = await app.inject({ method: 'GET', url: '/api/audit', headers: { cookie: `mgr_sid=${sid2}` } })
  assert.equal(auditOk.statusCode, 200)
  const { entries } = auditOk.json()
  assert.equal(entries[0]?.kind, 'password_change')

  // 旧密码已失效，新密码可登录
  const relogin = await login(app, 'admin', 'new-password-123')
  assert.equal(relogin.response.statusCode, 200)
  await app.close()
})
