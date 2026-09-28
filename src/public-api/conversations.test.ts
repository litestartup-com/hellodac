import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ApiKey } from '../auth/api-key.js'
import type { AppConfig, ResolvedService } from '../config.js'
import { checkAdmission, dispatchConversation, rejectAsHttp, resolveService } from './conversations.js'

/**
 * 对外会话的判定逻辑（口径 CONCEPTS-ALIGNED.md §4.2/§6）。
 * 每条用例都对着真实后果：挑错 agent → 客户被送错服务；粘性判断错 → 客户失忆；
 * 满载不报 → 调用方一直重试打爆集群。
 */
const service = (over: Partial<ResolvedService> = {}): ResolvedService => ({
  id: 'chat',
  label: '客服',
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
    name: '甲方',
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

test('服务选择: 钥匙只有一个服务时可省 service 字段', () => {
  const resolved = resolveService(config([service()]), key({ scopeServices: ['chat'] }), undefined)
  assert.equal(resolved.ok, true)
  if (resolved.ok) assert.equal(resolved.service.id, 'chat')
})

test('服务选择: 钥匙允许多个服务时必须点名（不替调用方猜）', () => {
  const many = config([service(), service({ id: 'report' })])
  const resolved = resolveService(many, key({ scopeServices: ['*'] }), undefined)
  assert.equal(resolved.ok, false)
  if (!resolved.ok) assert.equal(resolved.reason.kind, 'service_required')

  const named = resolveService(many, key({ scopeServices: ['*'] }), 'report')
  assert.equal(named.ok, true)
  if (named.ok) assert.equal(named.service.id, 'report')
})

test('服务选择: 名字不存在与不在范围内分开报（对内部排障），但不互相冒充', () => {
  const only = config([service()])
  const typo = resolveService(only, key({ scopeServices: ['chat'] }), 'suport')
  assert.equal(typo.ok, false)
  if (!typo.ok) assert.equal(typo.reason.kind, 'unknown_service')

  // 存在但不在钥匙范围内：报"不允许"，不确认它的存在
  const both = config([service(), service({ id: 'report' })])
  const denied = resolveService(both, key({ scopeServices: ['chat'] }), 'report')
  assert.equal(denied.ok, false)
  if (!denied.ok) assert.equal(denied.reason.kind, 'service_not_allowed')
})

test('分发: 挑最闲的 agent（会话少者优先），满载如实回报容量', () => {
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
      assert.equal(full.reason.capacity, 8, '容量 = agent 数 × 每 agent 并发上限')
      assert.equal(full.reason.inUse, 8)
    }
  }
})

test('分发: 全员离线与服务没部署分开报（一个是故障、一个是配置）', () => {
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

test('分发: 同一把钥匙的会话分散（避免一个大客户占满一个 agent）', () => {
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

test('准入: scope / 日配额 / 并发三条各自拦住，且给出可读数字', () => {
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
  assert.equal(checkAdmission(key({ quotaRunsDay: null }), { runsToday: 99_999, activeRuns: 0 }), null, '不限次数 = 只看并发')
  assert.equal(checkAdmission(key(), { runsToday: 1, activeRuns: 1 }), null)
})

test('拒绝映射: 满载给 429 + Retry-After，服务不在线给 503，越权给 4xx', () => {
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
