import type { FastifyInstance } from 'fastify'
import { BRAND } from '../brand.js'
import { DEFAULT_LOCALE, LOCALES, dictionary, isLocale } from '../i18n/index.js'

/**
 * 客户端字典（DAC v1.0.0）。
 *
 * 为什么不把品牌与译文内嵌在页面里：CSP 是 `script-src 'self'`（见 security.ts），
 * 内联脚本一律不执行——B3-1 第一版就是这么写的，实机抓页面才发现 window 上
 * 什么都没有。改成同源接口，客户端启动时取一次（不轮询）。
 *
 * 内容是公开信息（产品名、仓库、UI 文案），因此不做鉴权；它也**只能**吐出这些。
 * 未知语言回退基准语言而不是 404：客户端永远能拿到一份可用字典。
 */
export const registerI18nRoutes = (app: FastifyInstance): void => {
  app.get<{ Params: { locale: string } }>('/api/i18n/:locale', async (request, reply) => {
    const locale = isLocale(request.params.locale) ? request.params.locale : DEFAULT_LOCALE
    return reply.header('cache-control', 'no-cache').send({
      locale,
      locales: LOCALES,
      brand: BRAND,
      dict: dictionary(locale),
    })
  })
}
