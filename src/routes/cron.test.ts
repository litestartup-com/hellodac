import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import Fastify, { type FastifyInstance } from 'fastify'
import type { LightMyRequestResponse } from 'fastify'
import { eq } from 'drizzle-orm'
import type { AppConfig, ResolvedAgent } from '../config.js'
import { openDb, schema, type Db } from '../db/index.js'
import type { GatewayClient } from '../gateway/client.js'
import { DEFAULT_PRICING } from '../pricing.js'
import { Scheduler } from '../cron/schedule.js'
import { registerCronRoutes } from './cron.js'

const AGENT: ResolvedAgent = {
  id: 'personal',
  name: 'Personal',
  endpoint: 'A',
  workspacePath: '/tmp/ws',
  public: false,
  preset: null,
  gitRemote: null,
  provider: null,
  model: null,
  sandboxMode: null,
  validate: null,
}

const CONFIG: AppConfig = {
  listen: { host: '127.0.0.1', port: 0 },
  endpoints: { A: { id: 'A', url: 'http://127.0.0.1:1', driver: 'gateway', prefix: '/api-gw/v1', key: 'k', sandboxBase: null, sandboxKey: '', spawn: null, access: null } },
  agents: { personal: AGENT },
  runner: { timeoutMs: 1000, silenceMs: 0, maxConsecutiveFailures: 3, dailyBudgetMicroUsd: null },
  databasePath: ':memory:',
  pricing: DEFAULT_PRICING,
  sessionSecret: 'x'.repeat(32),
  initialUser: { username: 'admin', password: null },
  warnings: [],
}

const apps: FastifyInstance[] = []
const schedulers: Scheduler[] = []

const boot = async (): Promise<{ app: FastifyInstance; db: Db }> => {
  const dir = mkdtempSync(join(tmpdir(), 'route-cron-'))
  const { db } = openDb(join(dir, 'test.db'))
  db.insert(schema.agent)
    .values({
      id: 'personal',
      name: 'Personal',
      workspacePath: dir,
      endpoint: 'A',
      preset: null,
      gitRemote: null,
      public: 0,
      createdAt: Date.now(),
    })
    .run()

  const scheduler = new Scheduler({
    db,
    config: CONFIG,
    clients: new Map<string, GatewayClient>([['A', {} as GatewayClient]]),
    log: { info: () => {}, warn: () => {}, error: () => {} },
  })
  schedulers.push(scheduler)

  const app = Fastify()
  // Auth has its own tests; here every request is treated as signed in.
  registerCronRoutes(app, CONFIG, db, scheduler, async () => undefined)
  await app.ready()
  apps.push(app)
  return { app, db }
}

after(async () => {
  for (const s of schedulers) s.stop()
  await Promise.all(apps.map((a) => a.close()))
})

const create = async (app: FastifyInstance, over: Record<string, unknown> = {}): Promise<LightMyRequestResponse> =>
  app.inject({
    method: 'POST',
    url: '/api/crons',
    payload: { agentId: 'personal', name: 'weekly', schedule: '0 8 * * 1', prompt: 'write it', ...over },
  })

const createId = async (app: FastifyInstance): Promise<string> => {
  const response = await create(app)
  assert.equal(response.statusCode, 201)
  return (response.json()).id
}

test('a valid schedule is created and gets a next run time', async () => {
  const { app } = await boot()
  const response = await create(app)
  assert.equal(response.statusCode, 201)
  const body = response.json()
  assert.ok(body.nextRunAt !== null && body.nextRunAt > Date.now(), 'it is actually scheduled')
})

test('a malformed pattern is refused at the edit, not stored', async () => {
  const { app, db } = await boot()
  const response = await create(app, { schedule: 'every tuesday-ish' })
  assert.equal(response.statusCode, 400)
  assert.equal((response.json()).error, 'invalid_schedule')
  // The point of validating here: a stored row the scheduler cannot load looks
  // active in the list and silently never fires.
  assert.equal(db.select().from(schema.cron).all().length, 0)
})

test('a pattern that never fires again is refused too', async () => {
  const { app } = await boot()
  const response = await create(app, { schedule: '0 0 30 2 *' })
  assert.equal(response.statusCode, 400)
})

test('an unknown timezone is refused', async () => {
  const { app } = await boot()
  const response = await create(app, { timezone: 'Mars/Olympus_Mons' })
  assert.equal(response.statusCode, 400)
})

test('two schedules cannot share a name on the same agent', async () => {
  const { app } = await boot()
  await create(app)
  const again = await create(app)
  assert.equal(again.statusCode, 409)
})

test('an edit is validated against the pattern and zone as they will be after it', async () => {
  const { app } = await boot()
  const id = await createId(app)
  // The pattern alone is fine; the new timezone is what breaks it.
  const response = await app.inject({
    method: 'PATCH',
    url: `/api/crons/${id}`,
    payload: { timezone: 'Nowhere/Nothing' },
  })
  assert.equal(response.statusCode, 400)
})

test('re-enabling a schedule clears the failure streak that disabled it', async () => {
  const { app, db } = await boot()
  const id = await createId(app)
  // Stand in for three failed runs having auto-disabled it.
  db.update(schema.cron)
    .set({ enabled: 0, consecutiveFailures: 3, disabledReason: 'auto', lastError: 'boom' })
    .where(eq(schema.cron.id, id))
    .run()

  const response = await app.inject({ method: 'PATCH', url: `/api/crons/${id}`, payload: { enabled: true } })
  assert.equal(response.statusCode, 200)

  const row = db.select().from(schema.cron).where(eq(schema.cron.id, id)).all()[0]
  assert.equal(row?.enabled, 1)
  // Switching it on means "I fixed the cause, try again". Left at the ceiling,
  // the very next failure would disable it instantly and read as the fix failing.
  assert.equal(row?.consecutiveFailures, 0)
  assert.equal(row?.disabledReason, null)
  assert.equal(row?.lastError, null)
})

test('disabling does not invent a reason the manager did not have', async () => {
  const { app, db } = await boot()
  const id = await createId(app)
  await app.inject({ method: 'PATCH', url: `/api/crons/${id}`, payload: { enabled: false } })

  const row = db.select().from(schema.cron).where(eq(schema.cron.id, id)).all()[0]
  assert.equal(row?.enabled, 0)
  // `disabledReason` means "the manager did this". The operator switching it off
  // must stay distinguishable from the failure ceiling switching it off.
  assert.equal(row?.disabledReason, null)
})

test('deleting a schedule keeps the run history it produced', async () => {
  const { app, db } = await boot()
  const id = await createId(app)
  db.insert(schema.run)
    .values({ id: 'r1', agentId: 'personal', cronId: id, trigger: 'cron', state: 'done', startedAt: Date.now() })
    .run()

  const response = await app.inject({ method: 'DELETE', url: `/api/crons/${id}` })
  assert.equal(response.statusCode, 200)
  assert.equal(db.select().from(schema.cron).all().length, 0)
  // The schedule is gone, but what it did and what it cost still happened.
  assert.equal(db.select().from(schema.run).all().length, 1)
})

test('the list reports the configured ceiling and budget so the UI need not guess', async () => {
  const { app } = await boot()
  await create(app)
  const body = (await app.inject({ method: 'GET', url: '/api/crons' })).json()
  assert.equal(body.maxConsecutiveFailures, 3)
  assert.equal(body.dailyBudgetMicroUsd, null)
  assert.equal(body.crons[0]?.enabled, true)
  assert.equal(body.crons[0]?.problem, null)
})
