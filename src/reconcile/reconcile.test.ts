/**
 * 对账单一化（A 清单 #2）：镜像/收敛/删除的纯函数面测试。
 * convergeNodes 的 docker 认领路径已有 supervisor/docker-runner 测试覆盖；
 * 这里锁「一个真相源」的语义：insert/update/delete 全部由配置驱动。
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
// 债务 C3:临时目录收敛进 test-harness(makeDb 不落 agent 行,openDb 裸开)。
import { tempDir } from '../test-harness.js'

if (process.env.SESSION_SECRET === undefined) process.env.SESSION_SECRET = 'x'.repeat(32)

const configOf = (agents: Record<string, { name?: string; endpoint?: string; workspace?: string }>): ReturnType<typeof loadConfig> => {
  const dir = mkdtempSync(join(tmpdir(), 'reconcile-config-'))
  const file = join(dir, 'config.yaml')
  writeFileSync(file, stringify({
    listen: { host: '127.0.0.1', port: 8080 },
    endpoints: { A: { url: 'http://127.0.0.1:3080', driver: 'apiproxy' } },
    agents: Object.fromEntries(Object.entries(agents).map(([id, a]) => [id, {
      name: a.name ?? id, endpoint: a.endpoint ?? 'A', workspace: a.workspace ?? '.',
    }])),
  }), 'utf8')
  try {
    return loadConfig(file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const makeDb = () => openDb(join(tempDir('reconcile-db'), 'test.db')).db

test('mirrorAgents: insert / update / delete 全部由配置驱动（单一真相源）', () => {
  const db = makeDb()
  const first = mirrorAgents(db, configOf({ personal: { workspace: 'C:/ws1' }, brain: {} }))
  assert.deepEqual(first, { inserted: 2, updated: 0, deleted: 0 })
  // 幂等重跑：全部变 update（无重复行）。
  const second = mirrorAgents(db, configOf({ personal: { workspace: 'C:/ws1' }, brain: {} }))
  assert.deepEqual(second, { inserted: 0, updated: 2, deleted: 0 })
  // 配置删除 brain → 收敛删除（FK 教训：派生品不记住已删真相）。
  const third = mirrorAgents(db, configOf({ personal: { workspace: 'C:/ws1' } }))
  assert.deepEqual(third, { inserted: 0, updated: 1, deleted: 1 })
  const rows = db.select().from(schema.agent).all()
  assert.deepEqual(rows.map((r) => r.id).sort(), ['personal'])
  assert.equal(rows[0]?.workspacePath, resolve('C:/ws1'), '工作区按 config 解析后的绝对路径镜像')
})

test('mirrorAgentRow: 同 id 第二次调用是 update，不产生重复行', () => {
  const db = makeDb()
  const agent = { id: 'p', name: 'P', workspacePath: 'C:/w', endpoint: 'A', preset: null, gitRemote: null, public: false }
  assert.equal(mirrorAgentRow(db, agent), 'inserted')
  assert.equal(mirrorAgentRow(db, { ...agent, name: 'P2' }), 'updated')
  assert.equal(db.select().from(schema.agent).all().length, 1)
  assert.equal(db.select().from(schema.agent).all()[0]?.name, 'P2')
})

test('convergeRuns: 上一个进程遗留的 pending/running 行收敛为 failed', () => {
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
  assert.equal(rows.find((r) => r.id === 'r3')?.state, 'done', '已终态行不动')
  assert.match(rows.find((r) => r.id === 'r1')?.error ?? '', /manager restarted/)
})

/**
 * 发布前优化（2026-09-26）：中断在投递窗口里的指令同样是"上一个进程的遗留"。
 * 一条 delivered 行意味着 agent 领走了却没能回报（多半是 manager 重启打断），
 * 此后既不会被重投也不会被读，却带着整份 profile bundle 永久占库（生产实测
 * 339 KB / 2 行，清完存量后成了库里最大的一块）。boot 收敛为 failed 并清 payload。
 */
test('convergeAgentCommands: 重启遗留的 delivered 指令收敛为 failed 且清 payload，pending 不动', () => {
  const db = makeDb()
  const bundle = 'x'.repeat(50_000)
  const mk = (state: string) => ({ agentId: 'agent-x', type: 'node.spawn', payload: JSON.stringify({ nodeId: 'n', profile: bundle }), state, result: null, createdAt: Date.now(), deliveredAt: Date.now(), doneAt: null })
  db.insert(schema.agentCommand).values(mk('pending')).run()
  db.insert(schema.agentCommand).values(mk('delivered')).run()
  db.insert(schema.agentCommand).values(mk('done')).run()

  const marked = convergeAgentCommands(db)
  assert.equal(marked, 1, '只收敛 delivered')

  const rows = db.select().from(schema.agentCommand).all()
  const byState = (s: string) => rows.find((r) => r.state === s)
  assert.equal(byState('pending')?.payload.includes('profile'), true, 'pending 是真没送达的，payload 必须留着')
  assert.equal(byState('delivered'), undefined, 'delivered 已收敛')
  const failed = rows.find((r) => r.state === 'failed')
  assert.equal(failed?.payload, '{}', '收敛时必须清 payload')
  assert.match(failed?.result ?? '', /manager restarted/, 'result 说明原因')
  assert.ok((failed?.doneAt ?? 0) > 0, 'doneAt 落时间')
  assert.equal(byState('done')?.payload.includes('profile'), true, '终态行不重复处理')
})

test('修路 A2/A3: convergeNodes healOnly——cold 不动、offline restart 自愈、live 探活翻转后同 tick 自愈', async () => {
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

  // boot 形态：冷态 = 从未启动 → 拉起（走完整路径）
  const cold = new Map([['A', mk('A', 'cold')]])
  await convergeNodes(cold, config, null, () => {}, false)
  assert.deepEqual(restarts, ['A'])

  // 周期形态：人停的冷态不动；offline restart 自愈；live 探活失败同 tick 自愈；live 健康不动
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
  assert.deepEqual(restarts, ['offline-node', 'live-dead'], 'healOnly：冷态（手动停）绝不抢拉；offline 与 live 探活翻转的节点 restart 自愈')
})

test('修路 A2: startPeriodicReconcile 周期收敛，stop 后停摆', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'reconcile-ws-'))
  const config = configOf({ personal: { workspace: ws } })
  const deps = { db: makeDb(), config, supervisors: new Map() as Map<string, NodeSupervisor>, docker: null, log: () => {} }
  const stop = startPeriodicReconcile(deps, 40)
  await new Promise((resolve) => setTimeout(resolve, 150))
  stop()
  const fleetPath = join(config.agents['personal']!.workspacePath, FLEET_FILE)
  assert.ok(existsSync(fleetPath), '周期 tick 收敛了 fleet 派生品')
  const at = statSync(fleetPath).mtimeMs
  await new Promise((resolve) => setTimeout(resolve, 120))
  const after = statSync(fleetPath).mtimeMs
  assert.equal(at, after, 'stop 后不再收敛（mtime 不动）')
})

test('修路 A2: 间隔 0 = 关闭，返回 no-op 停止器', () => {
  const deps = { db: makeDb(), config: configOf({ personal: {} }), supervisors: new Map() as Map<string, NodeSupervisor>, docker: null, log: () => {} }
  const stop = startPeriodicReconcile(deps, 0)
  assert.equal(typeof stop, 'function')
  stop()
})
