/**
 * 对外 API 的 `/v1` 面（设计稿：内部设计库 `manager/topics/public-api.md` §3–§6）。
 *
 * 这一面**与后台（8080）完全隔离**：
 * - 只认钥匙（`Authorization: Bearer` 或 `X-API-Key`），**不认会话 cookie**；
 * - 只出 JSON，不出 HTML、不挂静态资源、不装 cookie 插件；
 * - 未通过鉴权时连"这个资源存不存在"都不透露（越权一律 401/403，不做 404 区分）。
 *
 * 审计策略：**通过鉴权的调用必留痕**；被拒的调用只在"钥匙本身可识别"时留痕
 * （吊销/过期/越权），格式错与未知 keyId 不留——否则任何人拿假钥匙刷一下就能把
 * 审计表灌满。未鉴权流量的兜底是监听器级的按 IP 限流。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { allowsService, hasScope, verifyApiKey, type ApiKey, type KeyScope } from '../auth/api-key.js'
import { recordAudit } from '../audit.js'
import type { AppConfig } from '../config.js'
import type { Db } from '../db/index.js'
import { quotaSnapshot } from './quota.js'

export interface PublicApiDeps {
  config: AppConfig
  db: Db
}

declare module 'fastify' {
  interface FastifyRequest {
    /** 通过鉴权后由 requireKey 挂上；未鉴权路径上恒为 undefined。 */
    apiKey?: ApiKey
  }
}

/** 两种头都收：`Authorization: Bearer` 是标准，`X-API-Key` 与 gateway 现状一致，便于反代转发。 */
const extractToken = (request: FastifyRequest): string | undefined => {
  const authorization = request.headers.authorization
  if (typeof authorization === 'string' && authorization.length > 7 && authorization.slice(0, 7).toLowerCase() === 'bearer ') {
    const token = authorization.slice(7).trim()
    if (token !== '') return token
  }
  const header = request.headers['x-api-key']
  if (typeof header === 'string' && header.trim() !== '') return header.trim()
  return undefined
}

/** 失败原因给人看，但**不区分"keyId 不存在"与"secret 错"**（api-key.ts 已合并为 unknown）。 */
const describeFailure = (reason: 'malformed' | 'unknown' | 'revoked' | 'expired'): string => {
  switch (reason) {
    case 'malformed':
      return 'a key is required, e.g. Authorization: Bearer dac_<id>_<secret>'
    case 'unknown':
      return 'unknown or invalid key'
    case 'revoked':
      return 'this key was revoked'
    case 'expired':
      return 'this key expired'
  }
}

const requireKey =
  (deps: PublicApiDeps, scope: KeyScope) =>
  async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const result = verifyApiKey(deps.db, extractToken(request))
    if (!result.ok) {
      // 可识别的失败（吊销/过期）留痕；malformed/unknown 交给监听器级限流兜底。
      if (result.reason === 'revoked' || result.reason === 'expired') {
        recordAudit(deps.db, {
          actor: 'api_key:unknown',
          kind: 'api_call',
          detail: `${request.method} ${request.url} → 401 (${result.reason})`,
        })
      }
      await reply.code(401).send({ error: 'unauthorized', detail: describeFailure(result.reason) })
      return
    }
    if (!hasScope(result.key, scope)) {
      recordAudit(deps.db, {
        actor: `api_key:${result.key.id}`,
        kind: 'api_call',
        detail: `${request.method} ${request.url} → 403 (missing ${scope})`,
      })
      await reply.code(403).send({ error: 'insufficient_scope', detail: `this key is not allowed to ${scope}` })
      return
    }
    request.apiKey = result.key
  }

/** 挂在插件上的统一留痕：只记通过鉴权的调用（见文件头注释的取舍）。 */
const auditCalls = (app: FastifyInstance, db: Db): void => {
  app.addHook('onResponse', async (request, reply) => {
    const key = request.apiKey
    if (key === undefined) return
    recordAudit(db, {
      actor: `api_key:${key.id}`,
      kind: 'api_call',
      detail: `${request.method} ${request.url} → ${reply.statusCode}`,
    })
  })
}

/**
 * 注册 `/v1` 面。返回的实例可直接 `app.inject()` 测试（不监听端口）。
 * 门面的启动/绑定由 listener.ts 负责，这里只管路由与鉴权。
 */
export const registerPublicApiRoutes = (app: FastifyInstance, deps: PublicApiDeps): void => {
  auditCalls(app, deps.db)

  /** 存活探针：不鉴权、不含任何数据（运维用它确认门面在不在）。 */
  app.get('/v1/health', async () => ({ ok: true, service: 'dac-public-api', version: 1 }))

  /**
   * 客户能进哪些服务。**只回对外必要的字段**：不暴露成员（agent）id 与健康状态——
   * 那是运营信息，客户只需要知道"我能调哪个服务、它支持哪种话术"。
   */
  app.get('/v1/services', { preHandler: requireKey(deps, 'services:read') }, async (request, reply) => {
    const key = request.apiKey
    if (key === undefined) return reply.code(401).send({ error: 'unauthorized' })
    const services = (deps.config.services ?? [])
      .filter((service) => allowsService(key, service.id))
      .map((service) => ({ id: service.id, label: service.label, surfaces: service.surfaces }))
    return reply.header('cache-control', 'no-store').send({ services })
  })

  /**
   * 本钥匙自己的用量与配额。
   *
   * 金额维度留到任务面落地后补（那时 `run.api_key_id` 才有值可聚合）——现在只报
   * "今天派了几个活、还剩多少、有几个在跑"，这些都是即时可算的真数，不预先摆空字段。
   */
  app.get('/v1/usage', { preHandler: requireKey(deps, 'usage:read') }, async (request, reply) => {
    const key = request.apiKey
    if (key === undefined) return reply.code(401).send({ error: 'unauthorized' })
    return reply.header('cache-control', 'no-store').send({
      key: { id: key.id, name: key.name, scopes: key.scopes, services: key.scopeServices },
      today: quotaSnapshot(deps.db, key),
    })
  })
}
