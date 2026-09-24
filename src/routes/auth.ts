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

/** 蜂群2计划 P3：CSRF 双提交 cookie（非 httpOnly，前端读出来放进 X-CSRF-Token）。 */
export const CSRF_COOKIE = 'dac_csrf'

/**
 * CSRF 门（P6 自愈版）：非 GET 请求必须带与 cookie 一致的 X-CSRF-Token。
 * 升级场景自愈：带着有效会话但缺 csrf cookie 的老会话（升级前的登录），
 * 由服务端补发 cookie —— 前端收到该 403 后带新 cookie 自动重试一次，用户无感。
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
 * P1-5：改密成功后抹掉 `.env` 里的初始口令。
 *
 * 它只在"库里没有用户"时有意义，改密之后就纯粹是一份留在磁盘上的明文口令，
 * 而这个文件在容器形态里是 rw 挂载的。键保留、值清空（保持 .env 的形状可读），
 * 其余行连注释一起原样保留。
 *
 * 写法与 workspace/writer 一致：`.tmp` + rename（原子），失败只警告不影响改密
 * —— 只读挂载或权限不足时，改密本身仍必须成功。
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
  // 0600：与 gen-env.sh 在 POSIX 上的收紧一致（Windows 上是空操作）
  try {
    chmodSync(tmp, 0o600)
  } catch {
    // 权限模型不支持（Windows）——不是失败
  }
  try {
    renameSync(tmp, envPath)
  } catch {
    // 容器形态下 `.env` 是**文件级 bind mount**（compose: ./.env:/app/.env），
    // 挂载点不能被 rename 顶替（EBUSY/EXDEV）——回落为原地写。
    // 原子性在这一步让位于"能用"：这是清理动作，且内容只是抹掉一个值。
    writeFileSync(envPath, body, 'utf8')
    try {
      unlinkSync(tmp)
    } catch {
      // 残留的 .tmp 不影响正确性
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
  /** P1-5：改密后要抹初始口令的 `.env` 路径；省略则跳过这一步（测试与旧调用）。 */
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
        // 蜂群2计划 P3：审计留痕（失败也留，actor = 尝试的用户名）
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
   * 蜂群2计划 P3：修改密码 —— 首登强制改密的唯一出口。
   * 强度规则（D2）：新密码 ≥ 10 字符；改成功即清除强制标记。
   */
  app.post('/api/account/password', {
    // 债务 S3:改密是「有会话者暴力猜当前口令」的向量,与登录同档限流。
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

    // P1-5：口令换了，旧会话就必须失效 —— 否则"改密"踢不掉已经拿着 cookie 的
    // 攻击者，改密只是让他多知道一个密码。当前设备紧接着换发一枚新会话，
    // 所以操作者自己不会被踢下线（体验不变，安全性提高）。
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
      // 抹初始口令是"顺手清理"，不是改密的前提：只读挂载/权限不足时只警告。
      try {
        // 债务 R6:.env 写入统一走锁入口(与 provision/setup 的配置写串行)
        await withConfigLock(() => clearInitialPassword(envPath))
        app.log.info('cleared MANAGER_INITIAL_PASSWORD from .env')
      } catch (error) {
        app.log.warn(`could not clear MANAGER_INITIAL_PASSWORD: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    return reply.send({ ok: true })
  })
}
