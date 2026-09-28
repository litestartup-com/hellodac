import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyReply } from 'fastify'
import cookie from '@fastify/cookie'
import { switchLocale } from './locale-switch.js'
import { LOCALE_COOKIE } from './i18n/index.js'

/**
 * Incident regression (2026-09-25, a user reported "clicking the language switcher does nothing"): the `?lang=`
 * switch must happen **before the auth guard**, otherwise it is swallowed by the guard's 302 when signed out.
 *
 * Measured comparison (before the fix):
 *   GET /login?lang=zh-CN → 302 with Set-Cookie: dac_lang=zh-CN  ✅ (public page)
 *   GET /nodes?lang=zh-CN → 302 and **no cookie**               ❌ (protected page)
 *
 * A real Fastify app reproduces the shape "protected route = a preHandler that redirects 302",
 * and asserts the difference between the hook version and the handler version -- the fix in production code.
 */

/** Same shape as index.ts: a global onRequest hook plus an auth preHandler that redirects. */
const bootApp = (mode: 'hook' | 'inHandler'): ReturnType<typeof Fastify> => {
  const app = Fastify()
  void app.register(cookie, { secret: 'x'.repeat(32) })
  if (mode === 'hook') {
    app.addHook('onRequest', async (request, reply) => {
      const switched = switchLocale(request, reply)
      if (switched !== null) return reply
    })
  }
  // The auth guard: same shape as makeRequirePage -- no chat means a 302 to the login page.
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

test('Incident regression: ?lang= on a protected page must also write the cookie (the hook runs before the auth guard)', async () => {
  const app = bootApp('hook')
  const res = await app.inject({ method: 'GET', url: '/nodes?lang=zh-CN' })
  // Order: the onRequest hook runs first -> it writes the cookie and 302s back to the clean URL `/nodes`.
  // The auth guard only takes effect on the **next** request (the /nodes without lang) -- which is what we want:
  // the language preference is recorded first, so by the time the user is sent to the login page it is already in the target language.
  assert.equal(res.statusCode, 302)
  assert.equal(res.headers.location, '/nodes', 'redirects back to the clean URL (the guard only steps in on the next hop)')
  assert.match(cookieOf(res) || '', /^dac_lang=zh-CN/, 'the key point: the language cookie must already be written')
  await app.close()
})

test('Incident regression: once the cookie has landed, a later guard redirect does not undo the language taking effect', async () => {
  const app = bootApp('hook')
  // First request: the switch (writes the cookie, redirects back)
  await app.inject({ method: 'GET', url: '/nodes?lang=zh-CN' })
  // Second request: sent with the cookie, no lang parameter -- the hook stays out and the guard redirects as usual
  const second = await app.inject({
    method: 'GET',
    url: '/nodes',
    headers: { cookie: `${LOCALE_COOKIE}=zh-CN` },
  })
  assert.equal(second.statusCode, 302)
  assert.equal(second.headers.location, '/login', 'now the auth guard has its turn')
  await app.close()
})

test('Incident regression: putting the switch in the handler means the guard swallows it -- that was the original bug', async () => {
  const app = bootApp('inHandler')
  const res = await app.inject({ method: 'GET', url: '/nodes?lang=zh-CN' })
  assert.equal(res.statusCode, 302)
  assert.equal(cookieOf(res), '', 'the handler never ran -> no cookie (the state of things before the fix)')
  await app.close()
})

test('Language switch: 302 back to the clean URL, the lang parameter does not stay in the address bar', async () => {
  const app = bootApp('hook')
  const res = await app.inject({ method: 'GET', url: '/login?lang=zh-CN' })
  assert.equal(res.statusCode, 302)
  assert.equal(res.headers.location, '/login', 'lang stripped')
  assert.match(cookieOf(res) || '', /^dac_lang=zh-CN/)
  await app.close()
})

test('Language switch: other query parameters are kept, only lang is stripped', async () => {
  const app = bootApp('hook')
  const res = await app.inject({ method: 'GET', url: '/runs?state=failed&lang=zh-CN&agent=ops33' })
  assert.equal(res.statusCode, 302)
  const loc = String(res.headers.location)
  assert.ok(loc.startsWith('/runs?'), `the redirect target should still be /runs (actually ${loc})`)
  assert.ok(!loc.includes('lang='), 'lang is stripped')
  assert.ok(loc.includes('state=failed') && loc.includes('agent=ops33'), 'other parameters are kept')
  await app.close()
})

test('Language switch: an invalid or missing lang is ignored outright -- no cookie and no redirect', async () => {
  const app = bootApp('hook')
  for (const url of ['/login', '/login?lang=zz', '/login?lang=', '/login?lang=en%3Cscript%3E']) {
    const res = await app.inject({ method: 'GET', url })
    assert.equal(res.statusCode, 200, `${url} must not be redirected (an invalid value neither takes effect nor echoes back)`)
    assert.equal(cookieOf(res), '', `${url} must not write a cookie`)
  }
  await app.close()
})

test('Language switch: the cookie carries path=/ and lax (it survives navigation but is not sent cross-site)', async () => {
  const app = bootApp('hook')
  const res = await app.inject({ method: 'GET', url: '/login?lang=zh-CN' })
  const c = cookieOf(res)
  assert.ok(c.includes('Path=/'), `path=/ (otherwise the switch breaks under a sub-path): ${c}`)
  assert.ok(/SameSite=Lax/i.test(c), `SameSite=Lax: ${c}`)
  await app.close()
})
