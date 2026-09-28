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
 * Debt S3 wrap-up: besides login, the mutating endpoints have to be rate-limited too (P1).
 *
 * Login rate limiting is in place (10/min, the P0-4 regression), but starting and stopping nodes, adding and
 * deleting nodes, and internal dispatch are still unthrottled write endpoints -- an attacker holding a
 * session or a token can hammer them without limit.
 * This test hammers each write endpoint and asserts that the limit really applies (red first, then green).
 */

const BRAIN_TOKEN = 'brain-token-42'
process.env.BRAIN_TOKEN = BRAIN_TOKEN

const configFor = (): AppConfig => {
  const dir = mkdtempSync(join(tmpdir(), 'ratelimit-mut-'))
  return {
    listen: { host: '127.0.0.1', port: 0 },
    endpoints: { A: { id: 'A', url: 'http://127.0.0.1:1', driver: 'gateway', prefix: '/api-gw/v1', key: 'k', sandboxBase: null, sandboxKey: '', spawn: null, access: null } },
    agents: {
      personal: { id: 'personal', name: 'Personal', endpoint: 'A', workspacePath: '.', public: false, preset: null, sandboxMode: null, gitRemote: null, provider: null, model: null, validate: null },
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

/** Starting and stopping nodes needs a supervisor; the rate limit sits on the route itself, so the handler body need not really run. */
const buildNodesApp = async (): Promise<ReturnType<typeof Fastify>> => {
  const app = Fastify()
  await app.register(rateLimit, { global: false })
  const config = configFor()
  const supervisor = new NodeSupervisor('A', { probe: async () => ({ ok: false, detail: 'x' }), spawn: () => { throw new Error('no real spawn') }, killTree: () => {} })
  registerNodesRoutes(app, config, new Map([['A', supervisor]]), new Map(), new Map(), async () => {})
  // Not inserting an agent row in the test can make the handler 404 or 500 -- that is fine: the 429 has to come from the rate-limit layer
  return app
}

test('Debt S3: /api/nodes/:id/down is rate-limited (20/min), and over the limit 429s inside the window', async () => {
  const app = await buildNodesApp()
  const codes = await hammer(app, { method: 'POST', url: '/api/nodes/A/down' }, 22)
  assert.ok(codes.some((c) => c === 429), `a 429 must appear after the hammering, got ${codes.slice(0, 5).join(',')}...`)
})

const buildProvisionApp = async (): Promise<ReturnType<typeof Fastify>> => {
  const app = Fastify()
  await app.register(rateLimit, { global: false })
  const config = configFor()
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'rl-prov-')), 'test.db')).db
  registerProvisionRoutes(app, config, async () => {}, { db, supervisors: new Map(), clients: new Map(), upstreamClients: new Map() })
  return app
}

test('Debt S3: POST /api/nodes (provisioning a node) is rate-limited (20/min), and over the limit 429s inside the window', async () => {
  const app = await buildProvisionApp()
  const codes = await hammer(app, { method: 'POST', url: '/api/nodes', headers: { 'content-type': 'application/json' } }, 22)
  assert.ok(codes.some((c) => c === 429), `a 429 must appear after the hammering, got ${codes.slice(0, 5).join(',')}...`)
})

const buildInternalApp = async (): Promise<ReturnType<typeof Fastify>> => {
  const app = Fastify()
  await app.register(rateLimit, { global: false })
  const config = configFor()
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'rl-int-')), 'test.db')).db
  registerInternalRoutes(app, config, db, new Map(), new Map(), { reload: () => {}, nextRunAt: () => null, problemFor: () => null } as never)
  return app
}

test('Debt S3: /api/internal/dispatch is rate-limited (60/min), and over the limit 429s inside the window', async () => {
  const app = await buildInternalApp()
  const codes = await hammer(app, { method: 'POST', url: '/api/internal/dispatch', headers: { 'x-brain-token': BRAIN_TOKEN, 'content-type': 'application/json' } }, 62)
  assert.ok(codes.some((c) => c === 429), `a 429 must appear after the hammering, got ${codes.slice(0, 5).join(',')}...`)
})
