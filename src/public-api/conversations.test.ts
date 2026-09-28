import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ApiKey } from '../auth/api-key.js'
import type { AppConfig, ResolvedService } from '../config.js'
import { checkAdmission, dispatchConversation, rejectAsHttp, resolveService } from './conversations.js'

/**
 * Decision logic for outward conversations (contract CONCEPTS-ALIGNED.md §4.2/§6).
 * Every case maps to a real outcome: the wrong agent sends a customer to the wrong service; wrong stickiness loses
 * their memory; capacity that is not reported makes the caller retry until the cluster falls over.
 */
const service = (over: Partial<ResolvedService> = {}): ResolvedService => ({
  id: 'chat',
  label: 'Support',
  workers: ['a', 'b'],
  surfaces: ['conversations'],
  knowledge: [],
  count: 2,
  maxSessionsPerAgent: 4,
  permission: 'read',
  sessionIdleHours: 24,
  placement: 'pin',
  machines: ['m1'],
  maxAgentsPerMachine: 4,
  ...over,
})

const config = (services: ResolvedService[]): AppConfig =>
  ({ services, agents: {}, endpoints: {} }) as unknown as AppConfig

const key = (over: Partial<ApiKey> = {}): ApiKey =>
  ({
    id: 'k1',
    name: 'Customer Co',
    scopes: ['services:read', 'usage:read', 'conversations:write'],
    scopeServices: ['*'],
    quotaRunsDay: 200,
    rateLimitRpm: 60,
    maxConcurrency: 4,
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    createdBy: 'admin',
    createdAt: 0,
    ...over,
  })

test('service selection: a key with exactly one service may omit the service field', () => {
  const resolved = resolveService(config([service()]), key({ scopeServices: ['chat'] }), undefined)
  assert.equal(resolved.ok, true)
  if (resolved.ok) assert.equal(resolved.service.id, 'chat')
})

test('service selection: a key with several services must name one (no guessing on behalf of the caller)', () => {
  const many = config([service(), service({ id: 'report' })])
  const resolved = resolveService(many, key({ scopeServices: ['*'] }), undefined)
  assert.equal(resolved.ok, false)
  if (!resolved.ok) assert.equal(resolved.reason.kind, 'service_required')

  const named = resolveService(many, key({ scopeServices: ['*'] }), 'report')
  assert.equal(named.ok, true)
  if (named.ok) assert.equal(named.service.id, 'report')
})

test('service selection: unknown and out-of-scope are reported separately (for internal triage) but never impersonate each other', () => {
  const only = config([service()])
  const typo = resolveService(only, key({ scopeServices: ['chat'] }), 'suport')
  assert.equal(typo.ok, false)
  if (!typo.ok) assert.equal(typo.reason.kind, 'unknown_service')

  // exists but outside the scope of this key: answer "not allowed" without confirming that it exists
  const both = config([service(), service({ id: 'report' })])
  const denied = resolveService(both, key({ scopeServices: ['chat'] }), 'report')
  assert.equal(denied.ok, false)
  if (!denied.ok) assert.equal(denied.reason.kind, 'service_not_allowed')
})

test('dispatch: pick the least busy agent (fewest sessions first), and report capacity honestly when full', () => {
  const busy = dispatchConversation({
    service: service(),
    load: [
      { agentId: 'a', online: true, sessions: 3, queueDepth: 0 },
      { agentId: 'b', online: true, sessions: 1, queueDepth: 0 },
    ],
  })
  assert.equal(busy.ok, true)
  if (busy.ok) assert.equal(busy.agentId, 'b')

  const full = dispatchConversation({
    service: service(),
    load: [
      { agentId: 'a', online: true, sessions: 4, queueDepth: 0 },
      { agentId: 'b', online: true, sessions: 4, queueDepth: 0 },
    ],
  })
  assert.equal(full.ok, false)
  if (!full.ok) {
    assert.equal(full.reason.kind, 'all_busy')
    if (full.reason.kind === 'all_busy') {
      assert.equal(full.reason.capacity, 8, 'capacity = agents x per-agent session cap')
      assert.equal(full.reason.inUse, 8)
    }
  }
})

test('dispatch: everyone offline is reported apart from "service not deployed" (a failure vs a configuration)', () => {
  const offline = dispatchConversation({
    service: service(),
    load: [
      { agentId: 'a', online: false, sessions: 0, queueDepth: 0 },
      { agentId: 'b', online: false, sessions: 0, queueDepth: 0 },
    ],
  })
  assert.equal(offline.ok, false)
  if (!offline.ok) assert.equal(offline.reason.kind, 'no_agent_online')
})

test('dispatch: one key spreads its conversations out (a single big customer must not fill one agent)', () => {
  const picked = dispatchConversation({
    service: service(),
    load: [
      { agentId: 'a', online: true, sessions: 1, queueDepth: 0 },
      { agentId: 'b', online: true, sessions: 1, queueDepth: 0 },
    ],
    keySessionsByAgent: { a: 1, b: 0 },
  })
  assert.equal(picked.ok, true)
  if (picked.ok) assert.equal(picked.agentId, 'b')
})

test('admission: scope, daily quota and concurrency each block on their own, with readable numbers', () => {
  assert.deepEqual(checkAdmission(key({ scopes: ['services:read'] }), { runsToday: 0, activeRuns: 0 }), {
    kind: 'scope_missing',
    scope: 'conversations:write',
  })
  assert.deepEqual(checkAdmission(key({ quotaRunsDay: 5 }), { runsToday: 5, activeRuns: 0 }), {
    kind: 'quota_exhausted',
    limit: 5,
    used: 5,
  })
  assert.deepEqual(checkAdmission(key({ maxConcurrency: 2 }), { runsToday: 0, activeRuns: 2 }), {
    kind: 'concurrency_exhausted',
    limit: 2,
    active: 2,
  })
  assert.equal(checkAdmission(key({ quotaRunsDay: null }), { runsToday: 99_999, activeRuns: 0 }), null, 'unlimited runs = concurrency only')
  assert.equal(checkAdmission(key(), { runsToday: 1, activeRuns: 1 }), null)
})

test('rejection mapping: full gives 429 + Retry-After, offline gives 503, out of scope gives 4xx', () => {
  const busy = rejectAsHttp({ kind: 'all_busy', capacity: 8, inUse: 8, retryAfterSeconds: 5 })
  assert.equal(busy.status, 429)
  assert.equal(busy.retryAfterSeconds, 5)
  assert.equal(busy.body.error, 'all_agents_busy')

  assert.equal(rejectAsHttp({ kind: 'no_agent_online' }).status, 503)
  assert.equal(rejectAsHttp({ kind: 'quota_exhausted', limit: 5, used: 5 }).status, 429)
  assert.equal(rejectAsHttp({ kind: 'service_not_allowed', service: 'report' }).status, 403)
  assert.equal(rejectAsHttp({ kind: 'unknown_service', service: 'x' }).status, 404)
  assert.equal(rejectAsHttp({ kind: 'scope_missing', scope: 'conversations:write' }).status, 403)
  assert.equal(rejectAsHttp({ kind: 'agent_unavailable', agentId: 'a' }).status, 503)
})
