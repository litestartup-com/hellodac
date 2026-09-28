/**
 * One reconcile entry (A list #2): tests for the pure mirror/converge/delete surface.
 * convergeNodes' docker adoption path is covered by the supervisor/docker-runner tests;
 * this locks the 'one source of truth' semantics: config drives insert/update/delete.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { stringify } from 'yaml'
import { loadConfig } from '../config.js'
import { openDb, schema } from '../db/index.js'
import type { NodeSupervisor } from '../nodes/supervisor.js'
import { convergeAgentCommands, convergeNodes, convergeRuns, mirrorAgentRow, mirrorAgents, startPeriodicReconcile } from './index.js'
import { FLEET_FILE } from '../workspace/fleet-doc.js'
// Debt C3: temp directories converge into test-harness (makeDb leaves no agent row, openDb opens bare).
import { tempDir } from '../test-harness.js'

if (process.env.SESSION_SECRET === undefined) process.env.SESSION_SECRET = 'x'.repeat(32)

const configOf = (agents: Record<string, { name?: string; endpoint?: string; workspace?: string }>): ReturnType<typeof loadConfig> => {
  const dir = mkdtempSync(join(tmpdir(), 'reconcile-config-'))
  const file = join(dir, 'config.yaml')
  // §1: one endpoint per agent. The fixture derives the endpoint from the agent (pointing one agent
  // at a shared endpoint trips that hard check, which is exactly what it guards, so no sharing here).
  const resolved = Object.fromEntries(
    Object.entries(agents).map(([id, a]) => [
      id,
      { name: a.name ?? id, endpoint: a.endpoint ?? `ep-${id}`, workspace: a.workspace ?? '.' },
    ]),
  )
  const endpointIds = [...new Set(Object.values(resolved).map((a) => a.endpoint))]
  const endpoints = Object.fromEntries(
    endpointIds.map((id, index) => [id, { url: `http://127.0.0.1:${3080 + index}`, driver: 'apiproxy' }]),
  )
  writeFileSync(file, stringify({
    listen: { host: '127.0.0.1', port: 8080 },
    endpoints,
    agents: resolved,
  }), 'utf8')
  try {
    return loadConfig(file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const makeDb = () => openDb(join(tempDir('reconcile-db'), 'test.db')).db

test('mirrorAgents: insert / update / delete all driven by the config (one source of truth)', () => {
  const db = makeDb()
  const first = mirrorAgents(db, configOf({ personal: { workspace: 'C:/ws1' }, brain: {} }))
  assert.deepEqual(first, { inserted: 2, updated: 0, deleted: 0 })
  // Rerun is idempotent: everything becomes update (no duplicate rows).
  const second = mirrorAgents(db, configOf({ personal: { workspace: 'C:/ws1' }, brain: {} }))
  assert.deepEqual(second, { inserted: 0, updated: 2, deleted: 0 })
  // Dropping brain from the config -> convergence delete (FK lesson: a derived artifact forgets).
  const third = mirrorAgents(db, configOf({ personal: { workspace: 'C:/ws1' } }))
  assert.deepEqual(third, { inserted: 0, updated: 1, deleted: 1 })
  const rows = db.select().from(schema.agent).all()
  assert.deepEqual(rows.map((r) => r.id).sort(), ['personal'])
  assert.equal(rows[0]?.workspacePath, resolve('C:/ws1'), 'the workspace mirrors as the absolute path resolved from the config')
})

test('mirrorAgentRow: a second call with the same id is an update, no duplicate row', () => {
  const db = makeDb()
  const agent = { id: 'p', name: 'P', workspacePath: 'C:/w', endpoint: 'A', preset: null, gitRemote: null, public: false }
  assert.equal(mirrorAgentRow(db, agent), 'inserted')
  assert.equal(mirrorAgentRow(db, { ...agent, name: 'P2' }), 'updated')
  assert.equal(db.select().from(schema.agent).all().length, 1)
  assert.equal(db.select().from(schema.agent).all()[0]?.name, 'P2')
})

test('convergeRuns: pending/running rows left by the previous process converge to failed', () => {
  const db = makeDb()
  db.insert(schema.agent).values({ id: 'a', name: 'a', workspacePath: '.', endpoint: 'A', preset: null, gitRemote: null, public: 0, createdAt: Date.now() }).run()
  const base = { agentId: 'a', sourceChatId: null, dshSessionId: null, trigger: 'manual' as const, prompt: 'x', startedAt: Date.now(), endedAt: null, error: null, summary: null, usageTokens: null, costMicroUsd: null, peakCostMicroUsd: null, commitHash: null, changedFiles: null, state: 'running' as const, cronId: null, idempotencyKey: null, conflict: null }
  db.insert(schema.run).values({ id: 'r1', ...base }).run()
  db.insert(schema.run).values({ id: 'r2', ...base, state: 'pending' }).run()
  db.insert(schema.run).values({ id: 'r3', ...base, state: 'done' }).run()
  const marked = convergeRuns(db)
  assert.equal(marked, 2)
  const rows = db.select().from(schema.run).all()
  assert.deepEqual(rows.filter((r) => r.state === 'failed').map((r) => r.id).sort(), ['r1', 'r2'])
  assert.equal(rows.find((r) => r.id === 'r3')?.state, 'done', 'a terminal row is left alone')
  assert.match(rows.find((r) => r.id === 'r1')?.error ?? '', /manager restarted/)
})

/**
 * Pre-release hardening (2026-09-26): a command interrupted inside the delivery window is likewise a
 * leftover of the previous process. A delivered row means the agent took it but never reported back
 * (usually a manager restart); after that it is neither redelivered nor read, yet holds the whole
 * profile bundle forever (339 KB / 2 rows in production). Boot converges it to failed and clears the payload.
 */
test('convergeAgentCommands: a delivered command left by a restart converges to failed with the payload cleared; pending stays', () => {
  const db = makeDb()
  const bundle = 'x'.repeat(50_000)
  const mk = (state: string) => ({ agentId: 'agent-x', type: 'node.spawn', payload: JSON.stringify({ nodeId: 'n', profile: bundle }), state, result: null, createdAt: Date.now(), deliveredAt: Date.now(), doneAt: null })
  db.insert(schema.agentCommand).values(mk('pending')).run()
  db.insert(schema.agentCommand).values(mk('delivered')).run()
  db.insert(schema.agentCommand).values(mk('done')).run()

  const marked = convergeAgentCommands(db)
  assert.equal(marked, 1, 'only delivered rows converge')

  const rows = db.select().from(schema.agentCommand).all()
  const byState = (s: string) => rows.find((r) => r.state === s)
  assert.equal(byState('pending')?.payload.includes('profile'), true, 'pending truly never arrived, so its payload stays')
  assert.equal(byState('delivered'), undefined, 'delivered has converged')
  const failed = rows.find((r) => r.state === 'failed')
  assert.equal(failed?.payload, '{}', 'convergence must clear the payload')
  assert.match(failed?.result ?? '', /manager restarted/, 'result states the reason')
  assert.ok((failed?.doneAt ?? 0) > 0, 'doneAt records a time')
  assert.equal(byState('done')?.payload.includes('profile'), true, 'a terminal row is not processed twice')
})

test('Road work A2/A3: convergeNodes healOnly -- cold untouched, offline self-heals via restart, a flipped probe heals in the same tick', async () => {
  const restarts: string[] = []
  const spec = {
    managed: true, command: 'node', args: [], cwd: null, readyTimeoutMs: 1000, detached: false, logFile: null,
    env: {}, restart: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 }, runner: 'process' as const, host: null, docker: null,
  }
  const mk = (id: string, state: string, opts: { liveProbeFlips?: boolean } = {}): NodeSupervisor => {
    const current = { state }
    return {
      id,
      get current() { return { ...current } },
      restart: () => { restarts.push(id) },
      start: () => { restarts.push(id) },
      adopt: () => {},
      probeLive: async () => {
        if (opts.liveProbeFlips === true && current.state === 'live') current.state = 'offline'
      },
    } as unknown as NodeSupervisor
  }
  const config = configOf({ personal: {} })
  config.endpoints['A'] = { id: 'A', url: 'http://x', driver: 'apiproxy', prefix: '/api', key: '', sandboxBase: null, sandboxKey: '', spawn: spec, access: null }

  // Boot form: cold = never started -> start it (the full path)
  const cold = new Map([['A', mk('A', 'cold')]])
  await convergeNodes(cold, config, null, () => {}, false)
  assert.deepEqual(restarts, ['A'])

  // Periodic form: a cold node a human stopped stays; offline self-heals; a failed live probe heals in the same tick; a healthy live node stays
  restarts.length = 0
  const mixed = new Map([
    ['cold-manual', mk('cold-manual', 'cold')],
    ['offline-node', mk('offline-node', 'offline')],
    ['live-ok', mk('live-ok', 'live')],
    ['live-dead', mk('live-dead', 'live', { liveProbeFlips: true })],
  ])
  config.endpoints['cold-manual'] = config.endpoints['A']!
  config.endpoints['offline-node'] = config.endpoints['A']!
  config.endpoints['live-ok'] = config.endpoints['A']!
  config.endpoints['live-dead'] = config.endpoints['A']!
  await convergeNodes(mixed, config, null, () => {}, true)
  assert.deepEqual(restarts, ['offline-node', 'live-dead'], 'healOnly: a cold node (stopped by hand) is never grabbed; offline and probe-flipped nodes self-heal via restart')
})

test('Road work A2: startPeriodicReconcile converges on a tick and stops after stop', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'reconcile-ws-'))
  const config = configOf({ personal: { workspace: ws } })
  const deps = { db: makeDb(), config, supervisors: new Map() as Map<string, NodeSupervisor>, docker: null, log: () => {} }
  const stop = startPeriodicReconcile(deps, 40)
  await new Promise((resolve) => setTimeout(resolve, 150))
  stop()
  const fleetPath = join(config.agents['personal']!.workspacePath, FLEET_FILE)
  assert.ok(existsSync(fleetPath), 'the periodic tick converged the fleet artifact')
  const at = statSync(fleetPath).mtimeMs
  await new Promise((resolve) => setTimeout(resolve, 120))
  const after = statSync(fleetPath).mtimeMs
  assert.equal(at, after, 'nothing converges after stop (mtime unchanged)')
})

test('Road work A2: interval 0 = off, returns a no-op stopper', () => {
  const deps = { db: makeDb(), config: configOf({ personal: {} }), supervisors: new Map() as Map<string, NodeSupervisor>, docker: null, log: () => {} }
  const stop = startPeriodicReconcile(deps, 0)
  assert.equal(typeof stop, 'function')
  stop()
})
