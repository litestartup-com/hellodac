import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyReply } from 'fastify'
import cookie from '@fastify/cookie'
import { switchLocale } from './locale-switch.js'
import { LOCALE_COOKIE } from './i18n/index.js'

/**
 * 事故回归（2026-09-25 用户报「语言选择切换点了没反应」）：
 * `?lang=` 切换必须**先于认证守卫**发生，否则未登录/会话过期时被守卫的 302 吞掉。
 *
 * 实测对照（修前）：
 *   GET /login?lang=zh-CN → 302 且 Set-Cookie: dac_lang=zh-CN  ✅（公开页）
 *   GET /nodes?lang=zh-CN → 302 且**无 cookie**                ❌（受保护页）
 *
 * 这里用真实 Fastify 复现「受保护路由 = 一个会 302 的 preHandler」这一形状，
 * 并断言钩子版与处理函数版的差别——就是生产代码里那个修法。
 */

/** 与 index.ts 同构：全局 onRequest 钩子 + 一个会重定向的认证 preHandler。 */
const bootApp = (mode: 'hook' | 'inHandler'): ReturnType<typeof Fastify> => {
  const app = Fastify()
  void app.register(cookie, { secret: 'x'.repeat(32) })
  if (mode === 'hook') {
    app.addHook('onRequest', async (request, reply) => {
      const switched = switchLocale(request, reply)
      if (switched !== null) return reply
    })
  }
  // 认证守卫：形状与 makeRequirePage 一致——没有会话就 302 到登录页。
  const requirePage = async (_request: unknown, reply: FastifyReply): Promise<void> => {
    await reply.redirect('/login', 302)
  }
  app.get('/nodes', { preHandler: requirePage }, async (request, reply) => {
    if (mode === 'inHandler') {
      const switched = switchLocale(request, reply)
      if (switched !== null) return switched
    }
    return reply.send('nodes-page')
  })
  app.get('/login', async (request, reply) => {
    if (mode === 'inHandler') {
      const switched = switchLocale(request, reply)
      if (switched !== null) return switched
    }
    return reply.send('login-page')
  })
  return app
}

const cookieOf = (res: { headers: Record<string, unknown> }): string => {
  const raw = res.headers['set-cookie']
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []
  return list.find((c) => c.startsWith(LOCALE_COOKIE)) ?? ''
}

test('事故回归: 受保护页面的 ?lang= 也必须写 cookie（钩子在认证守卫之前）', async () => {
  const app = bootApp('hook')
  const res = await app.inject({ method: 'GET', url: '/nodes?lang=zh-CN' })
  // 顺序：onRequest 钩子先跑 → 写 cookie + 302 回干净 URL `/nodes`。
  // 认证守卫要到**下一次**请求（那个没有 lang 的 /nodes）才起作用——这正是我们要的：
  // 语言偏好先被记下来，用户随后被送去登录页时已经是目标语言。
  assert.equal(res.statusCode, 302)
  assert.equal(res.headers.location, '/nodes', '回跳干净 URL（守卫在下一跳才介入）')
  assert.match(cookieOf(res) || '', /^dac_lang=zh-CN/, '关键：语言 cookie 必须已经写下去')
  await app.close()
})

test('事故回归: cookie 落定后，后续请求的守卫重定向也不影响语言已生效', async () => {
  const app = bootApp('hook')
  // 第一次：切换（写 cookie、回跳）
  await app.inject({ method: 'GET', url: '/nodes?lang=zh-CN' })
  // 第二次：带着 cookie 请求——没有 lang 参数，钩子不介入，守卫正常重定向
  const second = await app.inject({
    method: 'GET',
    url: '/nodes',
    headers: { cookie: `${LOCALE_COOKIE}=zh-CN` },
  })
  assert.equal(second.statusCode, 302)
  assert.equal(second.headers.location, '/login', '这次才轮到认证守卫')
  await app.close()
})

test('事故回归: 把切换写在处理函数里就会被守卫吞掉——这就是当初的 bug', async () => {
  const app = bootApp('inHandler')
  const res = await app.inject({ method: 'GET', url: '/nodes?lang=zh-CN' })
  assert.equal(res.statusCode, 302)
  assert.equal(cookieOf(res), '', '处理函数根本没执行 → 没有 cookie（修复前的实况）')
  await app.close()
})

test('语言切换: 302 回干净 URL，lang 参数不留在地址栏', async () => {
  const app = bootApp('hook')
  const res = await app.inject({ method: 'GET', url: '/login?lang=zh-CN' })
  assert.equal(res.statusCode, 302)
  assert.equal(res.headers.location, '/login', '去掉 lang')
  assert.match(cookieOf(res) || '', /^dac_lang=zh-CN/)
  await app.close()
})

test('语言切换: 保留其它查询参数，只摘掉 lang', async () => {
  const app = bootApp('hook')
  const res = await app.inject({ method: 'GET', url: '/runs?state=failed&lang=zh-CN&agent=ops33' })
  assert.equal(res.statusCode, 302)
  const loc = String(res.headers.location)
  assert.ok(loc.startsWith('/runs?'), `回跳目标应仍是 /runs（实际 ${loc}）`)
  assert.ok(!loc.includes('lang='), 'lang 已摘掉')
  assert.ok(loc.includes('state=failed') && loc.includes('agent=ops33'), '其它参数保留')
  await app.close()
})

test('语言切换: 非法或缺失 lang 一律忽略，不写 cookie 也不重定向', async () => {
  const app = bootApp('hook')
  for (const url of ['/login', '/login?lang=zz', '/login?lang=', '/login?lang=en%3Cscript%3E']) {
    const res = await app.inject({ method: 'GET', url })
    assert.equal(res.statusCode, 200, `${url} 不该被重定向（非法值不生效、不回显）`)
    assert.equal(cookieOf(res), '', `${url} 不该写 cookie`)
  }
  await app.close()
})

test('语言切换: cookie 带 path=/ 与 lax（换页仍生效、跨站不带出去）', async () => {
  const app = bootApp('hook')
  const res = await app.inject({ method: 'GET', url: '/login?lang=zh-CN' })
  const c = cookieOf(res)
  assert.ok(c.includes('Path=/'), `path=/（否则子路径下切换会失效）：${c}`)
  assert.ok(/SameSite=Lax/i.test(c), `SameSite=Lax：${c}`)
  await app.close()
})
