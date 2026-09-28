import type { FastifyReply } from 'fastify'
import { LOCALE_COOKIE, isLocale } from './i18n/index.js'

/**
 * Language switch: a hit on `?lang=xx` writes the cookie and 302s back to a **clean URL** (lang removed).
 *
 * It lives in its own module so a test can **really execute** it (instead of keeping a copy of the same logic in the test).
 *
 * Incident background (2026-09-25, user reported "clicking the language switch does nothing"):
 *   Protected pages carry `{ preHandler: requirePage }`, and preHandler runs **before** the route
 *   handler. The switch logic used to live in the route handler, so when the session was missing or
 *   expired the auth guard redirected first -- the switch never got a chance to run and the language
 *   preference was silently dropped. Measured side by side:
 *     GET /login?lang=zh-CN -> 302 with Set-Cookie: dac_lang=zh-CN  ✅ (public page)
 *     GET /nodes?lang=zh-CN -> 302 with **no cookie**               ❌ (protected page)
 *   Fix: index.ts registers it as a **global onRequest hook** (ahead of every preHandler), so every
 *   page can switch languages without each route having to remember to wire it in.
 */
export const switchLocale = (
  request: { url: string; query?: unknown },
  reply: FastifyReply,
): FastifyReply | null => {
  const requested = (request.query as { lang?: unknown } | undefined)?.lang
  if (!isLocale(requested)) return null
  reply.setCookie(LOCALE_COOKIE, requested, { path: '/', sameSite: 'lax', maxAge: 60 * 60 * 24 * 365 })
  // The redirect target is only ever a same-site path: request.url comes from the router and carries no external host (it cannot be used as a springboard).
  const [pathname, search] = request.url.split('?')
  const params = new URLSearchParams(search ?? '')
  params.delete('lang')
  const query = params.toString()
  return reply.redirect(query === '' ? (pathname ?? '/') : `${pathname}?${query}`, 302)
}
