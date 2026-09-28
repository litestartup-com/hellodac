/**
 * Outward conversations (contract: internal design library
 * `manager/topics/CONCEPTS-ALIGNED.md` §4.2/§6).
 *
 * Everything here is **pure**: inputs are the config, the API key and the load facts
 * read from the database; outputs are which service to use, which agent to pick, which
 * conversation to reuse, and how to explain the outcome to the caller. Reading the
 * database and talking to nodes stays in the route layer, so "who gets this
 * conversation" can be unit-tested, previewed in the UI, and recomputed later.
 *
 * Judge order for one call (each step is individually explainable):
 *   1. service: named in the request (optional when the key allows exactly one), and it
 *      must be within this key's scope;
 *   2. stickiness: same external user with a live conversation -> reuse it and **never
 *      re-dispatch** (moving a customer to another agent loses their memory);
 *   3. admission: daily runs and in-flight limits (no budget, no next step);
 *   4. dispatch: the freest agent of the service (sessions -> queue -> last latency,
 *      ties rotate);
 *   5. full or nobody home: say so plainly (429/503 plus a retry hint); whether to queue
 *      is the caller's decision, not something we hide.
 */
import { allowsService, hasScope, type ApiKey } from '../auth/api-key.js'
import type { AppConfig, ResolvedService } from '../config.js'
import { pickWorker, type DispatchRequest, type WorkerFacts } from '../services/dispatch.js'

export type ConversationRejection =
  /** The request named no service while the key allows more than one. */
  | { kind: 'service_required' }
  | { kind: 'unknown_service'; service: string }
  | { kind: 'service_not_allowed'; service: string }
  | { kind: 'scope_missing'; scope: string }
  | { kind: 'quota_exhausted'; limit: number; used: number }
  | { kind: 'concurrency_exhausted'; limit: number; active: number }
  | { kind: 'all_busy'; retryAfterSeconds: number; capacity: number; inUse: number }
  | { kind: 'no_agent_online' }
  | { kind: 'agent_unavailable'; agentId: string }

export type ServiceResolution =
  | { ok: true; service: ResolvedService }
  | { ok: false; reason: ConversationRejection }

/**
 * Pick the service for this call.
 *
 * A key that allows several services must be told which one: "you did not say" has to be
 * an explicit error rather than a guess, because guessing wrong routes a support request
 * into the reporting agent.
 */
export const resolveService = (config: AppConfig, key: ApiKey, requested: string | undefined): ServiceResolution => {
  const allowed = (config.services ?? []).filter((service) => allowsService(key, service.id))
  const wanted = requested?.trim()
  if (wanted === undefined || wanted === '') {
    if (allowed.length === 1) {
      const only = allowed[0]
      if (only !== undefined) return { ok: true, service: only }
    }
    // A service outside the key's scope only ever answers "not allowed"; whether it
    // exists is not disclosed (no oracle for probers).
    return { ok: false, reason: { kind: 'service_required' } }
  }
  const named = (config.services ?? []).find((service) => service.id === wanted)
  if (named === undefined) return { ok: false, reason: { kind: 'unknown_service', service: wanted } }
  if (!allowsService(key, named.id)) return { ok: false, reason: { kind: 'service_not_allowed', service: wanted } }
  return { ok: true, service: named }
}

/** Stickiness anchor: one key plus the caller's own user id equals one conversation. */
export interface StickyAnchor {
  apiKeyId: string
  externalUserId: string
}

export interface ExistingConversation {
  chatId: string
  agentId: string
  dshSessionId: string | null
}

/** Current load of one agent of the service; the caller reads these from the database. */
export interface ServiceLoad {
  agentId: string
  online: boolean
  /** Live conversations on this agent. */
  sessions: number
  /** Turns queued behind the running one (turns inside a conversation are serial). */
  queueDepth: number
  /** Duration of the most recent finished turn in ms; undefined when never measured. */
  lastTurnMs?: number
}

export interface DispatchInput {
  service: ResolvedService
  load: ServiceLoad[]
  /** Conversations this key already holds per agent (spread one caller's load out). */
  keySessionsByAgent?: Record<string, number>
  /** Rotation seed so exact ties take turns (concurrent calls do not pile on one agent). */
  rotationSeed?: number
}

export type DispatchOutcome =
  | { ok: true; agentId: string; sessions: number; full: string[] }
  | { ok: false; reason: ConversationRejection }

export const dispatchConversation = (input: DispatchInput): DispatchOutcome => {
  const request: DispatchRequest = {
    workers: input.load.map(
      (item): WorkerFacts => ({
        agentId: item.agentId,
        online: item.online,
        sessions: item.sessions,
        queueDepth: item.queueDepth,
        ...(item.lastTurnMs === undefined ? {} : { lastTurnMs: item.lastTurnMs }),
      }),
    ),
    maxSessionsPerAgent: input.service.maxSessionsPerAgent ?? 4,
    ...(input.keySessionsByAgent === undefined ? {} : { keySessionsByAgent: input.keySessionsByAgent }),
    ...(input.rotationSeed === undefined ? {} : { rotationSeed: input.rotationSeed }),
  }
  const picked = pickWorker(request)
  if (picked.ok) return { ok: true, agentId: picked.agentId, sessions: picked.sessions, full: picked.full }

  if (picked.reason === 'no_worker_online') return { ok: false, reason: { kind: 'no_agent_online' } }
  // "Full" is capacity, not an error: report capacity and usage as they are, plus a rough
  // retry hint. A precise prediction would need to know when a conversation ends, and the
  // manager does not guess.
  return {
    ok: false,
    reason: {
      kind: 'all_busy',
      capacity: picked.capacity,
      inUse: picked.inUse,
      retryAfterSeconds: 5,
    },
  }
}

/** Admission check; where the numbers come from is the caller's business (both are counts). */
export const checkAdmission = (
  key: ApiKey,
  usage: { runsToday: number; activeRuns: number },
): ConversationRejection | null => {
  if (!hasScope(key, 'conversations:write')) {
    return { kind: 'scope_missing', scope: 'conversations:write' }
  }
  if (key.quotaRunsDay !== null && usage.runsToday >= key.quotaRunsDay) {
    return { kind: 'quota_exhausted', limit: key.quotaRunsDay, used: usage.runsToday }
  }
  if (usage.activeRuns >= key.maxConcurrency) {
    return { kind: 'concurrency_exhausted', limit: key.maxConcurrency, active: usage.activeRuns }
  }
  return null
}

/** Rejection -> HTTP status and wording for the caller (no internal structure leaked). */
export const rejectAsHttp = (
  reason: ConversationRejection,
): { status: number; body: Record<string, unknown>; retryAfterSeconds?: number } => {
  switch (reason.kind) {
    case 'scope_missing':
      return { status: 403, body: { error: 'forbidden', detail: `this key is missing scope ${reason.scope}` } }
    case 'service_required':
      return { status: 400, body: { error: 'service_required', detail: 'this key may call several services; name one in "service"' } }
    case 'unknown_service':
      return { status: 404, body: { error: 'unknown_service', detail: `no service named ${reason.service}` } }
    case 'service_not_allowed':
      return { status: 403, body: { error: 'service_not_allowed', detail: `this key may not call ${reason.service}` } }
    case 'quota_exhausted':
      return { status: 429, body: { error: 'quota_exhausted', used: reason.used, limit: reason.limit } }
    case 'concurrency_exhausted':
      return { status: 429, body: { error: 'too_many_in_flight', active: reason.active, limit: reason.limit } }
    case 'all_busy':
      return {
        status: 429,
        body: { error: 'all_agents_busy', capacity: reason.capacity, inUse: reason.inUse },
        retryAfterSeconds: reason.retryAfterSeconds,
      }
    case 'no_agent_online':
      return { status: 503, body: { error: 'no_agent_online', detail: 'this service currently has no reachable agent' } }
    case 'agent_unavailable':
      return { status: 503, body: { error: 'agent_unavailable', agent: reason.agentId } }
  }
}
