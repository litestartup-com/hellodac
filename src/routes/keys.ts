/**
 * The key-management surface (the admin port 8080, behind the `requireUser` gate) -- design doc section 5.
 *
 * Strictly separate from `/v1` (the customer surface): this one uses the session cookie and is for **you**, that one uses a key and is for a **client program**.
 * The plaintext appears exactly once, in this POST's response; the list response has no secret field at all by construction.
 */
import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import { desc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { KEY_SCOPES, listApiKeys, mintApiKey, revokeApiKey } from '../auth/api-key.js'
import { recordAudit } from '../audit.js'
import type { AppConfig } from '../config.js'
import { schema, type Db } from '../db/index.js'
import { getPublicApiState } from '../public-api/listener.js'
import { probeApiKey } from '../public-api/key-probe.js'
import { activeRunsForKey, runsUsedToday, startOfLocalDay } from '../public-api/quota.js'

/** How long a key lasts when the operator gives an end date. */
const DAY_MS = 86_400_000

const createBody = z.object({
  name: z.string().min(1).max(80),
  /** '*' = every service; an array = the given service ids. */
  services: z.union([z.literal('*'), z.array(z.string().min(1)).min(1)]),
  scopes: z.array(z.enum(KEY_SCOPES)).min(1).default(['services:read', 'usage:read']),
  quotaRunsDay: z.number().int().positive().nullable().default(200),
  rateLimitRpm: z.number().int().min(1).max(6_000).default(60),
  maxConcurrency: z.number().int().min(1).max(64).default(4),
  expiresAt: z.number().int().positive().nullable().default(null),
})

/** A key's identity plus what the operator needs to hand it to a customer (never the secret). */
const keyFace = (
  db: Db,
  key: ReturnType<typeof listApiKeys>[number],
  services: Array<{ id: string; label: string }>,
): Record<string, unknown> => ({
  id: key.id,
  name: key.name,
  scopes: key.scopes,
  scopeServices: key.scopeServices,
  serviceLabels: key.scopeServices.includes('*')
    ? services.map((s) => s.label)
    : services.filter((s) => key.scopeServices.includes(s.id)).map((s) => s.label),
  quotaRunsDay: key.quotaRunsDay,
  rateLimitRpm: key.rateLimitRpm,
  maxConcurrency: key.maxConcurrency,
  expiresAt: key.expiresAt,
  revokedAt: key.revokedAt,
  lastUsedAt: key.lastUsedAt,
  createdBy: key.createdBy,
  createdAt: key.createdAt,
  // The two numbers an operator asks about: how much of the day is burned, and whether anything is
  // running right now. Counted from the run ledger, the same source the quota check reads.
  usedToday: runsUsedToday(db, key.id),
  active: activeRunsForKey(db, key.id),
})

const mutateLimit = { rateLimit: { max: 20, timeWindow: '1 minute' } } as const

export const registerApiKeyRoutes = (
  app: FastifyInstance,
  config: AppConfig,
  db: Db,
  requireUser: preHandlerHookHandler,
): void => {
  /** The list plus the surface state plus the assignable services (for the create form) -- none of them carries plaintext. */
  app.get('/api/keys', { preHandler: requireUser }, async (_request, reply) => {
    const services = (config.services ?? []).map((service) => ({ id: service.id, label: service.label }))
    const listener = getPublicApiState()
    return reply.header('cache-control', 'no-store').send({
      keys: listApiKeys(db).map((key) => keyFace(db, key, services)),
      publicApi: listener,
      services,
      // What a customer has to be told when handed a key: where to call and who to call as. The
      // operator should never have to reconstruct this from a config file.
      access: {
        baseUrl: `http://${listener.host}:${listener.port}/v1`,
        quotaResetsAt: startOfLocalDay(Date.now()) + DAY_MS,
        /** The manager's own timezone, so "resets at local midnight" is not a guess. */
        quotaTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    })
  })

  app.post('/api/keys', { preHandler: requireUser, config: mutateLimit }, async (request, reply) => {
    const parsed = createBody.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', detail: parsed.error.issues.map((i) => i.message) })
    }
    const body = parsed.data

    // The service ids must really exist: one mistyped letter makes a key that "gets into no service"
    // while looking perfectly normal, which is the hardest kind of fault to track down.
    const known = new Set((config.services ?? []).map((service) => service.id))
    const wanted = body.services === '*' ? ['*'] : body.services
    const unknown = wanted.filter((id) => id !== '*' && !known.has(id))
    if (unknown.length > 0) {
      return reply.code(400).send({ error: 'unknown_service', detail: `no such service: ${unknown.join(', ')}` })
    }

    const actor = request.currentUser?.username ?? 'unknown'
    try {
      const { token, key } = mintApiKey(db, {
        name: body.name,
        scopes: body.scopes,
        scopeServices: wanted,
        quotaRunsDay: body.quotaRunsDay,
        rateLimitRpm: body.rateLimitRpm,
        maxConcurrency: body.maxConcurrency,
        expiresAt: body.expiresAt,
        createdBy: actor,
      })
      recordAudit(db, {
        actor,
        kind: 'api_key_created',
        detail: `key ${key.id} "${key.name}" services=[${key.scopeServices.join(', ')}] scopes=[${key.scopes.join(', ')}] quota=${key.quotaRunsDay ?? 'none'}/day`,
      })
      const servicesForFace = (config.services ?? []).map((service) => ({ id: service.id, label: service.label }))
      return reply.code(201).send({ token, key: keyFace(db, key, servicesForFace) })
    } catch (error) {
      return reply.code(400).send({ error: 'invalid_key', detail: error instanceof Error ? error.message : String(error) })
    }
  })

  /**
   * One key's whole story, in one answer (the detail panel behind a list row):
   * what it may do, what it used today, the outward calls it made, and the turns it ran with their
   * costs. The calls come from the audit trail (`actor = api_key:<id>`), the turns from the run
   * ledger -- the same two sources the spend page and the quota counter read, so a detail view can
   * never disagree with them.
   */
  app.get<{ Params: { id: string } }>('/api/keys/:id', { preHandler: requireUser }, async (request, reply) => {
    const services = (config.services ?? []).map((service) => ({ id: service.id, label: service.label }))
    const key = listApiKeys(db).find((candidate) => candidate.id === request.params.id)
    if (key === undefined) return reply.code(404).send({ error: 'unknown_key' })

    const calls = db
      .select({ at: schema.auditLog.at, detail: schema.auditLog.detail })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actor, `api_key:${key.id}`))
      .orderBy(desc(schema.auditLog.at))
      .limit(20)
      .all()

    const runs = db
      .select()
      .from(schema.run)
      .where(eq(schema.run.apiKeyId, key.id))
      .orderBy(desc(schema.run.startedAt))
      .limit(20)
      .all()
    const usage = db
      .select()
      .from(schema.usageRecord)
      .where(inArray(schema.usageRecord.runId, runs.map((run) => run.id)))
      .all()
    const costOf = new Map(usage.map((row) => [row.runId, row.cost]))

    return reply.header('cache-control', 'no-store').send({
      key: keyFace(db, key, services),
      recentCalls: calls,
      recentRuns: runs.map((run) => ({
        id: run.id,
        state: run.state,
        trigger: run.trigger,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        summary: run.resultSummary,
        costMicroUsd: costOf.get(run.id) ?? null,
        error: run.error,
      })),
    })
  })

  /**
   * "Does this key work?" -- answered by making the same read-only call the customer will make.
   *
   * The token is required because the manager deliberately keeps only hashes; the answer therefore
   * lives with the operator who still has the plaintext (right after issuing, or from their own vault).
   * Nothing here spends quota or money: `GET /v1/services` and `GET /v1/usage` only.
   */
  app.post('/api/keys/probe', { preHandler: requireUser, config: mutateLimit }, async (request, reply) => {
    const parsed = z.object({ token: z.string().min(20).max(200) }).safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', detail: 'a token is required to test a key' })
    const result = await probeApiKey({ db, config, token: parsed.data.token, listener: getPublicApiState() })
    recordAudit(db, {
      actor: request.currentUser?.username ?? 'unknown',
      kind: 'api_key_probed',
      detail: `outward probe of a key against ${result.target}: ${result.ok ? 'ok' : 'failed'} (${result.steps.map((s) => `${s.path} ${s.status}`).join(', ') || 'no call made'})`,
    })
    return reply.send(result)
  })

  app.post<{ Params: { id: string } }>('/api/keys/:id/revoke', { preHandler: requireUser, config: mutateLimit }, async (request, reply) => {
    const actor = request.currentUser?.username ?? 'unknown'
    if (!revokeApiKey(db, request.params.id)) return reply.code(404).send({ error: 'unknown_key' })
    recordAudit(db, { actor, kind: 'api_key_revoked', detail: `key ${request.params.id} revoked` })
    return reply.send({ ok: true })
  })
}
