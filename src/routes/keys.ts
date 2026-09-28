/**
 * The key-management surface (the admin port 8080, behind the `requireUser` gate) -- design doc section 5.
 *
 * Strictly separate from `/v1` (the customer surface): this one uses the session cookie and is for **you**, that one uses a key and is for a **client program**.
 * The plaintext appears exactly once, in this POST's response; the list response has no secret field at all by construction.
 */
import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import { z } from 'zod'
import { KEY_SCOPES, listApiKeys, mintApiKey, revokeApiKey } from '../auth/api-key.js'
import { recordAudit } from '../audit.js'
import type { AppConfig } from '../config.js'
import type { Db } from '../db/index.js'
import { getPublicApiState } from '../public-api/listener.js'

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

const mutateLimit = { rateLimit: { max: 20, timeWindow: '1 minute' } } as const

export const registerApiKeyRoutes = (
  app: FastifyInstance,
  config: AppConfig,
  db: Db,
  requireUser: preHandlerHookHandler,
): void => {
  /** The list plus the surface state plus the assignable services (for the create form) -- none of them carries plaintext. */
  app.get('/api/keys', { preHandler: requireUser }, async (_request, reply) =>
    reply.header('cache-control', 'no-store').send({
      keys: listApiKeys(db),
      publicApi: getPublicApiState(),
      services: (config.services ?? []).map((service) => ({ id: service.id, label: service.label })),
    }),
  )

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
      return reply.code(201).send({ token, key })
    } catch (error) {
      return reply.code(400).send({ error: 'invalid_key', detail: error instanceof Error ? error.message : String(error) })
    }
  })

  app.post<{ Params: { id: string } }>('/api/keys/:id/revoke', { preHandler: requireUser, config: mutateLimit }, async (request, reply) => {
    const actor = request.currentUser?.username ?? 'unknown'
    if (!revokeApiKey(db, request.params.id)) return reply.code(404).send({ error: 'unknown_key' })
    recordAudit(db, { actor, kind: 'api_key_revoked', detail: `key ${request.params.id} revoked` })
    return reply.send({ ok: true })
  })
}
