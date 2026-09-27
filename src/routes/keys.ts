/**
 * 钥匙管理面（后台 8080，`requireUser` 门内）——设计稿 §5。
 *
 * 与 `/v1`（客户面）严格分开：这里用会话 cookie 给**你**用，那里用钥匙给**客户程序**用。
 * 明文只在这条 POST 的响应里出现一次；列表响应里结构上就没有 secret 字段。
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
  /** '*' = 全部服务；数组 = 指定服务 id。 */
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
  /** 列表 + 门面状态 + 可分配的服务（供创建表单）——都不含明文。 */
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

    // 服务 id 必须真的存在：手打错一个字母 = 一把"进不去任何服务"的钥匙，
    // 而它看起来完全正常，是最难查的一类故障。
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
