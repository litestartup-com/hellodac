import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import Fastify, { type FastifyInstance } from 'fastify'
import type { AppConfig, ResolvedAgent } from '../config.js'
import { BOARD_DIR } from '../board/store.js'
import { DEFAULT_PRICING } from '../pricing.js'
import { initWorkspace } from '../workspace/init.js'
import { closeBoardWatchers, registerBoardRoutes } from './board.js'
// 债务 C3:agent 构造收敛进 test-harness。
import { agentWith } from '../test-harness.js'

const agentFor = (workspacePath: string): ResolvedAgent =>
  agentWith({ id: 'personal', name: '个人', workspacePath, preset: 'personal' })

const configFor = (agent: ResolvedAgent): AppConfig => ({
  listen: { host: '127.0.0.1', port: 0 },
  endpoints: { A: { id: 'A', url: 'http://127.0.0.1:1', driver: 'gateway', prefix: '/api-gw/v1', key: 'k', sandboxBase: null, sandboxKey: '', spawn: null, access: null } },
  agents: { [agent.id]: agent },
  runner: { timeoutMs: 1000, silenceMs: 0, maxConsecutiveFailures: 3, dailyBudgetMicroUsd: null },
  databasePath: ':memory:',
  pricing: DEFAULT_PRICING,
  sessionSecret: 'x'.repeat(32),
  initialUser: { username: 'admin', password: null },
  warnings: [],
})

const apps: FastifyInstance[] = []
const boot = async (workspacePath: string): Promise<FastifyInstance> => {
  const app = Fastify()
  // Auth has its own tests; here every request is treated as signed in.
  registerBoardRoutes(app, configFor(agentFor(workspacePath)), async () => undefined)
  await app.ready()
  apps.push(app)
  return app
}

const initialised = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'route-board-'))
  initWorkspace({ workspacePath: root, preset: 'personal', useGit: false })
  return root
}

after(async () => {
  closeBoardWatchers()
  await Promise.all(apps.map((a) => a.close()))
})

test('returns the rendered board model for an initialised workspace', async () => {
  const app = await boot(initialised())
  const response = await app.inject({ method: 'GET', url: '/api/board/personal' })

  assert.equal(response.statusCode, 200)
  const body = response.json()
  assert.equal(body.initialized, true)
  assert.equal(body.agent.preset, 'personal')
  assert.equal(body.board.title, '个人大盘')
  assert.deepEqual(body.board.problems, [])
  assert.ok(body.board.pages.length >= 3)
})

test('an uninitialised workspace is reported as such, not as an error', async () => {
  // The board page needs to tell these apart: one says "run init", the other
  // says "ask the agent for an update".
  const app = await boot(mkdtempSync(join(tmpdir(), 'route-bare-')))
  const response = await app.inject({ method: 'GET', url: '/api/board/personal' })

  assert.equal(response.statusCode, 200)
  const body = response.json()
  assert.equal(body.initialized, false)
  assert.deepEqual(body.board.pages, [])
})

test('the board is never cached', async () => {
  const app = await boot(initialised())
  const response = await app.inject({ method: 'GET', url: '/api/board/personal' })
  assert.equal(response.headers['cache-control'], 'no-store')
})

test('unknown agents are refused', async () => {
  const app = await boot(initialised())
  assert.equal((await app.inject({ method: 'GET', url: '/api/board/nope' })).statusCode, 404)
  assert.equal((await app.inject({ method: 'GET', url: '/api/board/nope/events' })).statusCode, 404)
})

test('the API exposes only board data, never arbitrary workspace files', async () => {
  const root = initialised()
  writeFileSync(join(root, 'secrets.md'), 'ssh root@10.0.0.1 hunter2\n', 'utf8')
  writeFileSync(join(root, '.env'), 'SECRET=nope\n', 'utf8')
  const app = await boot(root)

  const body = (await app.inject({ method: 'GET', url: '/api/board/personal' })).body
  assert.ok(!body.includes('hunter2'))
  assert.ok(!body.includes('SECRET=nope'))
  // There is no route that serves workspace files at all.
  for (const url of ['/board/personal/secrets.md', '/api/board/personal/.env']) {
    assert.notEqual((await app.inject({ method: 'GET', url })).statusCode, 200)
  }
})

test('a workspace with no board directory cannot be watched, and says why', async () => {
  const app = await boot(mkdtempSync(join(tmpdir(), 'route-bare-')))
  const response = await app.inject({ method: 'GET', url: '/api/board/personal/events' })
  assert.equal(response.statusCode, 503)
  assert.match(response.json<{ detail: string }>().detail, /board/)
})

test('the event stream opens with a hello frame and reports a data change', async () => {
  const root = initialised()
  const app = await boot(root)
  await app.listen({ port: 0, host: '127.0.0.1' })
  const port = (app.server.address() as { port: number }).port

  const controller = new AbortController()
  const response = await fetch(`http://127.0.0.1:${port}/api/board/personal/events`, { signal: controller.signal })

  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)

  const reader = (response.body as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()

  const hello = decoder.decode((await reader.read()).value)
  assert.ok(hello.includes('"kind":"hello"'), 'the stream announces itself')

  const changed = (async () => {
    const deadline = Date.now() + 6000
    let buffer = ''
    while (Date.now() < deadline) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      if (buffer.includes('"kind":"changed"')) return true
    }
    return false
  })()

  await new Promise((r) => setTimeout(r, 150))
  mkdirSync(join(root, BOARD_DIR), { recursive: true })
  writeFileSync(join(root, BOARD_DIR, 'overview.json'), JSON.stringify({ label: '总览', blocks: [] }), 'utf8')

  assert.equal(await changed, true, 'the open board was told the data changed')

  controller.abort()
  await reader.cancel().catch(() => undefined)
})
