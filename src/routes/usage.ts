import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import type { AppConfig } from '../config.js'
import type { Db } from '../db/index.js'
import { findPricing } from '../pricing.js'
import { currentMonth, monthByAgent, monthByDay, monthByModel, monthTotals, spendMonths } from '../usage/store.js'

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/

export const registerUsageRoutes = (
  app: FastifyInstance,
  config: AppConfig,
  db: Db,
  requireUser: preHandlerHookHandler,
): void => {
  app.get<{ Querystring: { month?: string } }>(
    '/api/usage',
    { preHandler: requireUser },
    async (request, reply) => {
      const requested = request.query.month
      if (requested !== undefined && !MONTH_PATTERN.test(requested)) {
        return reply.code(400).send({ error: 'invalid_month', detail: 'expected YYYY-MM' })
      }
      const month = requested ?? currentMonth()

      const byModel = monthByModel(db, month).map((m) => ({
        ...m,
        // Lets the page name the model whose rate is missing, instead of
        // reporting an unexplained gap in the total.
        rateConfigured: findPricing(m.provider, m.model, config.pricing.rates) !== null,
      }))

      const byAgent = monthByAgent(db, month).map((a) => ({
        ...a,
        name: config.agents[a.agentId]?.name ?? a.agentId,
      }))

      return reply.send({
        month,
        months: spendMonths(db),
        totals: monthTotals(db, month),
        byAgent,
        byModel,
        byDay: monthByDay(db, month),
        // The page needs these to explain a peak charge; they are configuration,
        // not secrets.
        peakWindowsUtc: config.pricing.peakWindows.map((w) => ({
          start: minuteToHhmm(w.startMinuteUtc),
          end: minuteToHhmm(w.endMinuteUtc),
        })),
      })
    },
  )
}

const minuteToHhmm = (minute: number): string =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
