import type { FastifyInstance } from 'fastify'
import { BRAND } from '../brand.js'
import { DEFAULT_LOCALE, LOCALES, dictionary, isLocale } from '../i18n/index.js'

/**
 * The client-side dictionary (DAC v1.0.0).
 *
 * Why branding and translations are not embedded in the page: the CSP is `script-src 'self'` (see security.ts), so
 * inline scripts never run -- the first B3-1 version was written that way, and only grabbing the page on a real
 * machine showed that window had nothing on it. It became a same-origin endpoint, fetched once at client start (no polling).
 *
 * The content is public information (product name, repository, UI strings), so there is no auth; it also **only**
 * emits those. An unknown locale falls back to the base locale rather than a 404: the client always gets a usable dictionary.
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
