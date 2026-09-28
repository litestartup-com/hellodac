/**
 * The outward `/v1` surface (design: internal design library `manager/topics/public-api.md` §3-§6).
 *
 * This surface is **completely separate from the admin API (8080)**:
 * - keys only (`Authorization: Bearer` or `X-API-Key`), **session cookies are not accepted**;
 * - JSON only: no HTML, no static assets, no cookie plugin;
 * - an unauthenticated call never learns whether a resource exists (401/403, never a distinguishing 404).
 *
 * Audit policy: **every authenticated call leaves a trace**; a rejected call is recorded only when
 * the key itself is identifiable (revoked/expired/out of scope). Malformed keys and unknown key ids
 * are not recorded -- otherwise a fake key could flood the audit table. Unauthenticated traffic is
 * bounded by the listener-level per-IP rate limit.
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
 * What an outward conversation needs, injected by the wiring layer (this surface knows nothing about
 * supervisors or drivers):
 * - `isOnline`: whether that agent is reachable right now (the same liveness source as the admin UI);
 * - `runTurn`: run one turn on an agent and **wait for it**, returning the reply and the usage.
 */
export interface PublicApiPorts {
  isOnline: (agentId: string) => boolean
  runTurn: (input: { chatId: string; agentId: string; text: string; apiKeyId: string }) => Promise<RunOutcome>
}

export interface PublicApiDeps {
  config: AppConfig
  db: Db
  /** Absent = no conversation surface (the read-only surface still works): without wiring, the
   * conversation endpoints answer 503 instead of pretending to work. */
  ports?: PublicApiPorts
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by requireKey once authenticated; always undefined on unauthenticated paths. */
    apiKey?: ApiKey
  }
}

/** Both headers are accepted: `Authorization: Bearer` is the standard, and `X-API-Key` matches the
 * gateway convention and is easier for reverse proxies to forward. */
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

/** Human-readable failure, but **"unknown key id" and "wrong secret" are not distinguished**
 * (api-key.ts already merges both into `unknown`). */
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
      // Identifiable failures (revoked/expired) leave a trace; malformed and unknown keys fall
      // through to the listener-level rate limit.
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

/** One trace for the whole plugin: only authenticated calls are recorded (see the header comment). */
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
  /** Optional when the key allows exactly one service; mandatory when it allows several (no guessing). */
  service: z.string().min(1).max(64).optional(),
  /**
   * The caller's own user id: providing it buys stickiness -- the same user comes back to the same
   * conversation. Without it a new conversation is created every time (keeping the conversation id
   * works too, but then the caller owns de-duplication).
   */
  externalUserId: z.string().min(1).max(128).optional(),
  /** First message: when present, the first turn runs inside this very request and the reply comes back. */
  text: z.string().min(1).max(32_000).optional(),
})

const sendMessageBody = z.object({ text: z.string().min(1).max(32_000) })

/**
 * Register the `/v1` surface. The returned instance can be tested with `app.inject()` (no port).
 * Binding and startup belong to listener.ts; this file only owns routing and authentication.
 */
export const registerPublicApiRoutes = (app: FastifyInstance, deps: PublicApiDeps): void => {
  auditCalls(app, deps.db)

  /** Liveness probe: no authentication, no data (operations use it to see whether the door is up). */
  app.get('/v1/health', async () => ({ ok: true, service: 'dac-public-api', version: 1 }))

  /**
   * Which services this key may call. **Only the fields a caller needs**: member (agent) ids and
   * health stay inside -- that is operational information; callers only care which service they can
   * call and which surfaces it offers.
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
   * This key's own usage and quota.
   *
   * The money dimension waits for the task surface (only then does `run.api_key_id` have values to
   * aggregate). For now it reports how many runs happened today, how many are left and how many are
   * in flight -- real numbers computed on the spot, with no placeholder fields.
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
   * Rejection: one wording table in conversations.ts, returned together with the status code and `Retry-After`.
   * Busy and out-of-quota are both 429 but with different error codes: that is how a caller decides
   * between "back off and retry" and "not today".
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
   * Start (or reuse) an outward conversation.
   *
   * Both responses are successes, told apart by `created`: `false` means the stickiness anchor hit and
   * the original conversation is reused (the same external user must not be moved to another agent just
   * because the caller retried -- that would lose their memory). With `text`, the first turn runs in the
   * same request, so a one-shot question is **a single HTTP call**.
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

    // Stickiness: on a hit, reuse the original conversation and do not dispatch again.
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
          // A failed turn must carry its reason: the caller has to judge whether retrying helps or
          // whether the request itself has to change.
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

    // An agent missing from the config (stale service declaration) cannot take a conversation:
    // a 503 is better than creating a conversation nobody will answer.
    if (deps.config.agents[picked.agentId] === undefined) {
      return reject(reply, { kind: 'agent_unavailable', agentId: picked.agentId }, deps.db, key, 'POST /v1/conversations')
    }

    const chat = createChat(deps.db, picked.agentId, Date.now(), {
      apiKeyId: key.id,
      // No external user id = the caller keeps the conversation id itself: external_user_id stays
      // null, and the "one live conversation" partial index only covers NOT NULL rows, so these
      // conversations never collide with each other and are never hit by the stickiness lookup
      // (stickiness only applies to callers that supply an id).
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
   * Run one turn on an existing conversation.
   *
   * Ownership is checked first: a conversation that is not this key's answers 404 either way (it does
   * not distinguish "does not exist" from "not yours"), otherwise conversation ids would be probeable.
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
 * Run one turn and handle failure: null means a response was already sent (the caller just returns it).
 *
 * Failure mapping: the agent is not in the config -> 503; the turn itself failed -> 502 with the error
 * text (the outward wording is "this turn failed", not "you are misconfigured" -- quota and
 * authentication were already checked before this point).
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
    // The turn finished in a failed state: still 200 (the caller asked what happened this turn),
    // expressed through state and error -- never disguise a failed turn as a request that never
    // arrived.
    return outcome
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    recordAudit(deps.db, { actor: `api_key:${apiKeyId}`, kind: 'api_call', detail: `turn failed on ${agentId}: ${detail}` })
    await reply.code(502).send({ error: 'turn_failed', detail })
    return null
  }
}
