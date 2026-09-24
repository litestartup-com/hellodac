import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { registerNodesRoutes } from './nodes.js'
import { registerProvisionRoutes } from './provision.js'
import { registerInternalRoutes } from './internal.js'
import { NodeSupervisor } from '../nodes/supervisor.js'
import { openDb } from '../db/index.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppConfig } from '../config.js'
import { DEFAULT_PRICING } from '../pricing.js'

/**
 * 债务 S3 收尾：除登录外，变更类端点也必须限流（P1）。
 *
 * 登录限流已就位（10/min，P0-4 回归），但 nodes 起停、节点增删、
 * internal 派工仍是无限流写端点——有会话/令牌的攻击者可以无限打。
 * 本测试 hammer 各写端点，断言限流确实生效（先红后绿）。
 */

const BRAIN_TOKEN = 'brain-token-42'
process.env.BRAIN_TOKEN = BRAIN_TOKEN

const configFor = (): AppConfig => {
  const dir = mkdtempSync(join(tmpdir(), 'ratelimit-mut-'))
  return {
    listen: { host: '127.0.0.1', port: 0 },
    endpoints: { A: { id: 'A', url: 'http://127.0.0.1:1', driver: 'gateway', prefix: '/api-gw/v1', key: 'k', sandboxBase: null, sandboxKey: '', spawn: null, access: null } },
    agents: {
      personal: { id: 'personal', name: '个人', endpoint: 'A', workspacePath: '.', public: false, preset: null, sandboxMode: null, gitRemote: null, provider: null, model: null, validate: null },
    },
    runner: { timeoutMs: 1_000, silenceMs: 0, maxConsecutiveFailures: 3, dailyBudgetMicroUsd: null },
    databasePath: join(dir, 'manager.db'),
    pricing: DEFAULT_PRICING,
    sessionSecret: 'x'.repeat(32),
    initialUser: { username: 'admin', password: null },
    warnings: [],
  }
}

const hammer = async (app: ReturnType<typeof Fastify>, opts: { method: 'POST' | 'DELETE'; url: string; headers?: Record<string, string> }, times: number): Promise<number[]> => {
  const codes: number[] = []
  for (let i = 0; i < times; i += 1) {
    const response = await app.inject({ ...opts, headers: { ...(opts.headers ?? {}) } })
    codes.push(response.statusCode)
  }
  await app.close()
  return codes
}

/** nodes 起停需要 supervisor；加限流的是路由本身，handler 体不必真实执行。 */
const buildNodesApp = async (): Promise<ReturnType<typeof Fastify>> => {
  const app = Fastify()
  await app.register(rateLimit, { global: false })
  const config = configFor()
  const supervisor = new NodeSupervisor('A', { probe: async () => ({ ok: false, detail: 'x' }), spawn: () => { throw new Error('no real spawn') }, killTree: () => {} })
  registerNodesRoutes(app, config, new Map([['A', supervisor]]), new Map(), new Map(), async () => {})
  // 测试里不插 agent 行会导致 handler 404/500 都没关系——429 必须出现在限流层
  return app
}

test('债务 S3: /api/nodes/:id/down 限流(20/min),窗口内超限 429', async () => {
  const app = await buildNodesApp()
  const codes = await hammer(app, { method: 'POST', url: '/api/nodes/A/down' }, 22)
  assert.ok(codes.some((c) => c === 429), `hammer 后必须出现 429,实际 ${codes.slice(0, 5).join(',')}...`)
})

const buildProvisionApp = async (): Promise<ReturnType<typeof Fastify>> => {
  const app = Fastify()
  await app.register(rateLimit, { global: false })
  const config = configFor()
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'rl-prov-')), 'test.db')).db
  registerProvisionRoutes(app, config, async () => {}, { db, supervisors: new Map(), clients: new Map(), upstreamClients: new Map() })
  return app
}

test('债务 S3: POST /api/nodes(开通节点)限流(20/min),窗口内超限 429', async () => {
  const app = await buildProvisionApp()
  const codes = await hammer(app, { method: 'POST', url: '/api/nodes', headers: { 'content-type': 'application/json' } }, 22)
  assert.ok(codes.some((c) => c === 429), `hammer 后必须出现 429,实际 ${codes.slice(0, 5).join(',')}...`)
})

const buildInternalApp = async (): Promise<ReturnType<typeof Fastify>> => {
  const app = Fastify()
  await app.register(rateLimit, { global: false })
  const config = configFor()
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'rl-int-')), 'test.db')).db
  registerInternalRoutes(app, config, db, new Map(), new Map(), { reload: () => {}, nextRunAt: () => null, problemFor: () => null } as never)
  return app
}

test('债务 S3: /api/internal/dispatch 限流(60/min),窗口内超限 429', async () => {
  const app = await buildInternalApp()
  const codes = await hammer(app, { method: 'POST', url: '/api/internal/dispatch', headers: { 'x-brain-token': BRAIN_TOKEN, 'content-type': 'application/json' } }, 62)
  assert.ok(codes.some((c) => c === 429), `hammer 后必须出现 429,实际 ${codes.slice(0, 5).join(',')}...`)
})
