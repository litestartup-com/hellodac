import type { FastifyReply } from 'fastify'
import { LOCALE_COOKIE, isLocale } from './i18n/index.js'

/**
 * 语言切换：`?lang=xx` 命中 → 写 cookie + 302 回**干净 URL**（去掉 lang）。
 *
 * 抽成独立模块是为了能被测试**真正执行**（而不是在测试里复制一份同样的逻辑）。
 *
 * 事故背景（2026-09-25 用户报「语言选择切换点了没反应」）：
 *   受保护页面挂的是 `{ preHandler: requirePage }`，preHandler 跑在路由处理函数
 *   **之前**。原先切换逻辑写在路由处理函数里，于是会话缺失/过期时认证守卫先 302，
 *   切换根本没机会执行，语言偏好被静默吞掉。实测对照：
 *     GET /login?lang=zh-CN → 302 且 Set-Cookie: dac_lang=zh-CN  ✅（公开页）
 *     GET /nodes?lang=zh-CN → 302 且**无 cookie**                ❌（受保护页）
 *   修法：由 index.ts 把它挂成**全局 onRequest 钩子**（先于所有 preHandler），
 *   任何页面都自动具备切换能力，不依赖每个路由记得接一次。
 */
export const switchLocale = (
  request: { url: string; query?: unknown },
  reply: FastifyReply,
): FastifyReply | null => {
  const requested = (request.query as { lang?: unknown } | undefined)?.lang
  if (!isLocale(requested)) return null
  reply.setCookie(LOCALE_COOKIE, requested, { path: '/', sameSite: 'lax', maxAge: 60 * 60 * 24 * 365 })
  // 回跳目标只取本站路径：request.url 由路由器给出，不含外部主机（不可被拿来做跳板）。
  const [pathname, search] = request.url.split('?')
  const params = new URLSearchParams(search ?? '')
  params.delete('lang')
  const query = params.toString()
  return reply.redirect(query === '' ? (pathname ?? '/') : `${pathname}?${query}`, 302)
}
