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
import { z } from 'zod'
import { allowsService, hasScope, verifyApiKey, type ApiKey, type KeyScope } from '../auth/api-key.js'
import { recordAudit } from '../audit.js'
import { createChat, findLiveConversation, getChat } from '../chat/store.js'
import type { AppConfig } from '../config.js'
import type { Db } from '../db/index.js'
import type { RunOutcome } from '../runner.js'
import { checkAdmission, dispatchConversation, rejectAsHttp, resolveService } from './conversations.js'
import { quotaSnapshot } from './quota.js'
import { keySessionsByAgent, loadServiceLoad } from './service-load.js'

/**
 * 对外会话要的那几件事，由 wiring 层注入（对外面不认识 supervisor/驱动细节）：
 * - `isOnline`：该 agent 现在可不可达（与后台同一套判活口径）；
 * - `runTurn`：在某个 agent 上跑一轮并**等它结束**，返回答复与用量。
 */
export interface PublicApiPorts {
  isOnline: (agentId: string) => boolean
  runTurn: (input: { chatId: string; agentId: string; text: string; apiKeyId: string }) => Promise<RunOutcome>
}

export interface PublicApiDeps {
  config: AppConfig
  db: Db
  /** 缺省 = 不含会话面（只读面仍可用）：wiring 未注入时，会话端点回 503 而不是假装成功。 */
  ports?: PublicApiPorts
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

const createConversationBody = z.object({
  /** 钥匙只允许一个服务时可省；允许多个时必须点名（不替调用方猜）。 */
  service: z.string().min(1).max(64).optional(),
  /**
   * 调用方自己的用户 id：给了它就获得粘性——同一个用户下次再来会回到同一个会话。
   * 不给则每次都新建（调用方自己存会话号也能续，但那就得自己保证不重不漏）。
   */
  externalUserId: z.string().min(1).max(128).optional(),
  /** 第一句话：给了就在同一请求里跑完第一轮并把答复带回来。 */
  text: z.string().min(1).max(32_000).optional(),
})

const sendMessageBody = z.object({ text: z.string().min(1).max(32_000) })

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

  /**
   * 拒绝：统一走 conversations.ts 的措辞表，状态码与 `Retry-After` 一起给出。
   * 满载与配额不足都是 429，但错误码不同——调用方据此决定"退避重试"还是"今天别调了"。
   */
  const reject = (reply: FastifyReply, reason: Parameters<typeof rejectAsHttp>[0], db: Db, key: ApiKey, what: string): FastifyReply => {
    const mapped = rejectAsHttp(reason)
    recordAudit(db, { actor: `api_key:${key.id}`, kind: 'api_call', detail: `${what} → ${mapped.status} (${reason.kind})` })
    if (mapped.retryAfterSeconds !== undefined) reply.header('retry-after', String(mapped.retryAfterSeconds))
    return reply.code(mapped.status).send(mapped.body)
  }

  const usageFor = (key: ApiKey): { runsToday: number; activeRuns: number } => {
    const today = quotaSnapshot(deps.db, key)
    return { runsToday: today.used, activeRuns: today.active }
  }

  /**
   * 开始（或复用）一次对外会话。
   *
   * 两种返回都算成功，靠 `created` 区分：`false` = 命中粘性，回到原会话（同一个外部用户
   * 不该因为调用方重试就换一个 agent，那等于让客户失忆）。带 `text` 时顺带跑第一轮，
   * 所以"一句话问答"对调用方是**一次 HTTP 调用**，不用先建会话再发消息。
   */
  app.post('/v1/conversations', { preHandler: requireKey(deps, 'conversations:write') }, async (request, reply) => {
    const key = request.apiKey
    const ports = deps.ports
    if (key === undefined) return reply.code(401).send({ error: 'unauthorized' })
    if (ports === undefined) return reply.code(503).send({ error: 'conversations_unavailable' })

    const parsed = createConversationBody.safeParse(request.body ?? {})
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', detail: parsed.error.issues.map((i) => i.message) })
    }

    const resolved = resolveService(deps.config, key, parsed.data.service)
    if (!resolved.ok) return reject(reply, resolved.reason, deps.db, key, 'POST /v1/conversations')
    const service = resolved.service

    const admission = checkAdmission(key, usageFor(key))
    if (admission !== null) return reject(reply, admission, deps.db, key, 'POST /v1/conversations')

    const externalUserId = parsed.data.externalUserId
    const text = parsed.data.text

    // 粘性：命中就直接用原会话，不重新分发。
    if (externalUserId !== undefined) {
      const existing = findLiveConversation(deps.db, key.id, externalUserId)
      if (existing !== null) {
        const replyPayload: Record<string, unknown> = {
          conversationId: existing.id,
          agentId: existing.agentId,
          service: service.id,
          created: false,
        }
        if (text !== undefined) {
          const outcome = await runTurn(deps, reply, ports, existing.id, existing.agentId, text, key.id)
          if (outcome === null) return reply
          replyPayload.reply = outcome.summary
          replyPayload.usage = outcome.usage
          replyPayload.costMicroUsd = outcome.costMicroUsd
          replyPayload.state = outcome.state
          // 失败态必须带原因：调用方要能自己判断"重试有用"还是"请求得改"。
          if (outcome.error !== null) replyPayload.error = outcome.error
        }
        return reply.header('cache-control', 'no-store').send(replyPayload)
      }
    }

    const load = loadServiceLoad(service, { db: deps.db, isOnline: ports.isOnline })
    const picked = dispatchConversation({
      service,
      load,
      keySessionsByAgent: keySessionsByAgent(deps.db, key.id, [...service.workers]),
      rotationSeed: Date.now() % 1000,
    })
    if (!picked.ok) return reject(reply, picked.reason, deps.db, key, 'POST /v1/conversations')

    // 成员不在配置里（服务声明过期）时不能建会话：宁可 503 也不要建一个没人接的会话。
    if (deps.config.agents[picked.agentId] === undefined) {
      return reject(reply, { kind: 'agent_unavailable', agentId: picked.agentId }, deps.db, key, 'POST /v1/conversations')
    }

    const chat = createChat(deps.db, picked.agentId, Date.now(), {
      apiKeyId: key.id,
      // 没给外部用户 id = 调用方自己存会话号续聊：此时 external_user_id 为 null，
      // 而"活会话唯一"那条部分索引带 IS NOT NULL 条件，所以这些会话互不干扰，
      // 也永远不会被粘性查询命中（粘性只对给了 id 的调用方生效）。
      externalUserId: externalUserId ?? null,
      serviceId: service.id,
    })
    recordAudit(deps.db, {
      actor: `api_key:${key.id}`,
      kind: 'api_call',
      detail: `conversation ${chat.id} created on ${picked.agentId} for service ${service.id}`,
    })

    const payload: Record<string, unknown> = {
      conversationId: chat.id,
      agentId: picked.agentId,
      service: service.id,
      created: true,
    }
    if (text !== undefined) {
      const outcome = await runTurn(deps, reply, ports, chat.id, picked.agentId, text, key.id)
      if (outcome === null) return reply
      payload.reply = outcome.summary
      payload.usage = outcome.usage
      payload.costMicroUsd = outcome.costMicroUsd
      payload.state = outcome.state
      if (outcome.error !== null) payload.error = outcome.error
    }
    return reply.code(201).header('cache-control', 'no-store').send(payload)
  })

  /**
   * 在某个会话上跑一轮。
   *
   * 归属检查先做：不是这把钥匙的会话一律 404（不区分"不存在"与"不是你的"，
   * 否则调用方可以拿会话号是否存在来探测别人的会话）。
   */
  app.post('/v1/conversations/:id/messages', { preHandler: requireKey(deps, 'conversations:write') }, async (request, reply) => {
    const key = request.apiKey
    const ports = deps.ports
    if (key === undefined) return reply.code(401).send({ error: 'unauthorized' })
    if (ports === undefined) return reply.code(503).send({ error: 'conversations_unavailable' })

    const params = request.params as { id?: string }
    const chatId = params.id ?? ''
    const chat = getChat(deps.db, chatId)
    if (chat === null || chat.apiKeyId !== key.id || chat.removedAt !== null) {
      return reply.code(404).send({ error: 'unknown_conversation' })
    }

    const parsed = sendMessageBody.safeParse(request.body ?? {})
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', detail: parsed.error.issues.map((i) => i.message) })
    }

    const admission = checkAdmission(key, usageFor(key))
    if (admission !== null) return reject(reply, admission, deps.db, key, `POST /v1/conversations/${chatId}/messages`)

    const outcome = await runTurn(deps, reply, ports, chat.id, chat.agentId, parsed.data.text, key.id)
    if (outcome === null) return reply
    return reply.header('cache-control', 'no-store').send({
      conversationId: chat.id,
      agentId: chat.agentId,
      reply: outcome.summary,
      state: outcome.state,
      ...(outcome.error === null ? {} : { error: outcome.error }),
      usage: outcome.usage,
      costMicroUsd: outcome.costMicroUsd,
      durationMs: outcome.durationMs,
    })
  })
}

/**
 * 跑一轮并处理失败：返回 null = 已经回过响应（调用方直接 return reply）。
 *
 * 失败映射：agent 不在配置里 = 503；回合本身失败 = 502 且带 error 文本（对外措辞是
 * "这一轮失败了"，不是"你没配对"——配额与鉴权在这一步之前已经查过）。
 */
const runTurn = async (
  deps: PublicApiDeps,
  reply: FastifyReply,
  ports: PublicApiPorts,
  chatId: string,
  agentId: string,
  text: string,
  apiKeyId: string,
): Promise<RunOutcome | null> => {
  if (deps.config.agents[agentId] === undefined) {
    await reply.code(503).send({ error: 'agent_unavailable', agent: agentId })
    return null
  }
  try {
    const outcome = await ports.runTurn({ chatId, agentId, text, apiKeyId })
    // 跑完了但结果是失败态：仍然 200 回话（调用方要的是"这一轮怎么了"），
    // 用 state 与 error 表达，避免把"回合失败"伪装成"请求没送达"。
    return outcome
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    recordAudit(deps.db, { actor: `api_key:${apiKeyId}`, kind: 'api_call', detail: `turn failed on ${agentId}: ${detail}` })
    await reply.code(502).send({ error: 'turn_failed', detail })
    return null
  }
}
