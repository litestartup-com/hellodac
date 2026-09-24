import { randomUUID } from 'node:crypto'
import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import { desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { AppConfig } from '../config.js'
import type { Db } from '../db/index.js'
import { schema } from '../db/index.js'
import { scheduleProblem, type Scheduler } from '../cron/schedule.js'

/**
 * Schedule management.
 *
 * Two rules that are easy to get wrong and expensive when wrong:
 *
 * 1. **A pattern is validated before it is stored.** A typo accepted here
 *    becomes a row the scheduler cannot load, and the symptom is a job that
 *    appears active and never fires.
 * 2. **Re-enabling resets the failure count.** Switching a job back on means "I
 *    fixed the cause, try again". Leaving the counter at the ceiling would let
 *    the very next failure disable it immediately, which reads as the fix not
 *    working.
 */

const scheduleFields = {
  name: z.string().min(1).max(80),
  schedule: z.string().min(1).max(120),
  timezone: z.string().min(1).max(60).default('Asia/Shanghai'),
  prompt: z.string().min(1).max(20_000),
}

const createBody = z.object({ agentId: z.string().min(1), ...scheduleFields })

const patchBody = z
  .object({
    name: scheduleFields.name.optional(),
    schedule: scheduleFields.schedule.optional(),
    timezone: z.string().min(1).max(60).optional(),
    prompt: scheduleFields.prompt.optional(),
    enabled: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'nothing to change' })

export const registerCronRoutes = (
  app: FastifyInstance,
  config: AppConfig,
  db: Db,
  scheduler: Scheduler,
  requireUser: preHandlerHookHandler,
): void => {
  app.get('/api/crons', { preHandler: requireUser }, async () => {
    const rows = db.select().from(schema.cron).orderBy(desc(schema.cron.createdAt)).all()
    return {
      dailyBudgetMicroUsd: config.runner.dailyBudgetMicroUsd,
      maxConsecutiveFailures: config.runner.maxConsecutiveFailures,
      crons: rows.map((row) => ({
        id: row.id,
        agentId: row.agentId,
        agentName: config.agents[row.agentId]?.name ?? row.agentId,
        name: row.name,
        schedule: row.schedule,
        timezone: row.timezone,
        prompt: row.prompt,
        enabled: row.enabled === 1,
        consecutiveFailures: row.consecutiveFailures,
        lastRunAt: row.lastRunAt,
        lastState: row.lastState,
        lastError: row.lastError,
        /** Set only when the manager switched it off, never by the operator. */
        disabledReason: row.disabledReason,
        nextRunAt: scheduler.nextRunAt(row.id),
        /** Why this row could not be scheduled at all, if that happened. */
        problem: scheduler.problemFor(row.id),
      })),
    }
  })

  app.post<{ Body: unknown }>('/api/crons', { preHandler: requireUser }, async (request, reply) => {
    const parsed = createBody.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', detail: parsed.error.issues.map((i) => i.message) })
    }
    const body = parsed.data
    if (config.agents[body.agentId] === undefined) return reply.code(404).send({ error: 'unknown_agent' })

    const problem = scheduleProblem(body.schedule, body.timezone)
    if (problem !== null) return reply.code(400).send({ error: 'invalid_schedule', detail: problem })

    const id = randomUUID()
    try {
      db.insert(schema.cron)
        .values({
          id,
          agentId: body.agentId,
          name: body.name,
          schedule: body.schedule,
          timezone: body.timezone,
          prompt: body.prompt,
          enabled: 1,
          consecutiveFailures: 0,
          createdAt: Date.now(),
        })
        .run()
    } catch (error) {
      // The unique index on (agent_id, name) is the only way this fails.
      if (String(error).includes('UNIQUE')) {
        return reply.code(409).send({ error: 'duplicate_name', detail: 'this agent already has a schedule by that name' })
      }
      throw error
    }
    scheduler.reload()
    return reply.code(201).send({ id, nextRunAt: scheduler.nextRunAt(id) })
  })

  app.patch<{ Params: { id: string }; Body: unknown }>(
    '/api/crons/:id',
    { preHandler: requireUser },
    async (request, reply) => {
      const row = db.select().from(schema.cron).where(eq(schema.cron.id, request.params.id)).all()[0]
      if (row === undefined) return reply.code(404).send({ error: 'unknown_cron' })

      const parsed = patchBody.safeParse(request.body)
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', detail: parsed.error.issues.map((i) => i.message) })
      }
      const body = parsed.data

      // Validated against the pattern and zone as they will be *after* the edit,
      // since either one alone can be the thing that breaks it.
      const nextSchedule = body.schedule ?? row.schedule
      const nextTimezone = body.timezone ?? row.timezone
      const problem = scheduleProblem(nextSchedule, nextTimezone)
      if (problem !== null) return reply.code(400).send({ error: 'invalid_schedule', detail: problem })

      const turningOn = body.enabled === true && row.enabled !== 1
      db.update(schema.cron)
        .set({
          ...(body.name === undefined ? {} : { name: body.name }),
          schedule: nextSchedule,
          timezone: nextTimezone,
          ...(body.prompt === undefined ? {} : { prompt: body.prompt }),
          ...(body.enabled === undefined ? {} : { enabled: body.enabled ? 1 : 0 }),
          // Switching it back on means the cause was addressed. Keeping the
          // streak would let the next single failure disable it again.
          ...(turningOn ? { consecutiveFailures: 0, disabledReason: null, lastError: null } : {}),
        })
        .where(eq(schema.cron.id, row.id))
        .run()

      scheduler.reload()
      return { ok: true, nextRunAt: scheduler.nextRunAt(row.id) }
    },
  )

  app.delete<{ Params: { id: string } }>('/api/crons/:id', { preHandler: requireUser }, async (request, reply) => {
    const deleted = db.delete(schema.cron).where(eq(schema.cron.id, request.params.id)).run()
    if (deleted.changes === 0) return reply.code(404).send({ error: 'unknown_cron' })
    // Run history keeps its `cron_id` on purpose: the schedule is gone but what
    // it did, and what it cost, still happened.
    scheduler.reload()
    return { ok: true }
  })

  app.post<{ Params: { id: string } }>(
    '/api/crons/:id/run',
    {
      preHandler: requireUser,
      // Costs money and holds the agent, same as the manual run route.
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const row = db.select().from(schema.cron).where(eq(schema.cron.id, request.params.id)).all()[0]
      if (row === undefined) return reply.code(404).send({ error: 'unknown_cron' })
      // Forced: you asked for this one and are watching it, so neither the
      // enabled flag nor the daily budget applies (see Scheduler.attempt).
      const result = await scheduler.attempt(row.id, true)
      return reply.send(result)
    },
  )
}
