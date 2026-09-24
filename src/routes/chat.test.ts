import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import Fastify, { type FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import type { AppConfig, ResolvedAgent } from '../config.js'
import { openDb, schema, type Db } from '../db/index.js'
import { GatewayClient } from '../gateway/client.js'
import { startFakeGateway, type FakeGateway, type FakeScript } from '../gateway/fake.js'
import { FakeSessionDriver } from '../session-driver/fake.js'
import type { SessionDriver } from '../session-driver/port.js'
import { DEFAULT_PRICING } from '../pricing.js'
import { closeChatRelays, openChatRelays, registerChatRoutes } from './chat.js'
import { bindSession } from '../chat/store.js'

/**
 * The chat relay, over a real socket.
 *
 * These need an actual listening server rather than `app.inject`: the behaviour
 * under test is a stream that stays open across a request, and inject resolves
 * with a finished response.
 */

const API_KEY = 'test-key'

const agentFor = (workspacePath: string): ResolvedAgent => ({
  id: 'personal',
  name: 'Personal',
  endpoint: 'A',
  workspacePath,
  public: false,
  preset: null,
  gitRemote: null,
  provider: null,
  model: null,
  sandboxMode: null,
  validate: null,
})

const configFor = (gw: FakeGateway, agent: ResolvedAgent): AppConfig => ({
  listen: { host: '127.0.0.1', port: 0 },
  endpoints: { A: { id: 'A', url: gw.url, driver: 'gateway', prefix: gw.prefix, key: API_KEY, sandboxBase: null, sandboxKey: '', spawn: null, access: null } },
  agents: { personal: agent },
  runner: { timeoutMs: 10_000, silenceMs: 0, maxConsecutiveFailures: 3, dailyBudgetMicroUsd: null },
  databasePath: ':memory:',
  pricing: DEFAULT_PRICING,
  sessionSecret: 'x'.repeat(32),
  initialUser: { username: 'admin', password: null },
  warnings: [],
})

const apps: FastifyInstance[] = []
const gateways: FakeGateway[] = []

interface Harness {
  base: string
  db: Db
  gateway: FakeGateway
}

const boot = async (script: FakeScript, upstream?: SessionDriver): Promise<Harness> => {
  const gw = await startFakeGateway(script, API_KEY)
  gateways.push(gw)

  const dir = mkdtempSync(join(tmpdir(), 'route-chat-'))
  const workspace = mkdtempSync(join(tmpdir(), 'route-chat-ws-'))
  const { db } = openDb(join(dir, 'test.db'))
  const agent = agentFor(workspace)
  db.insert(schema.agent)
    .values({
      id: 'personal',
      name: 'Personal',
      workspacePath: workspace,
      endpoint: 'A',
      preset: null,
      gitRemote: null,
      public: 0,
      createdAt: Date.now(),
    })
    .run()

  const app = Fastify()
  apps.push(app)
  const clients = new Map([['A', new GatewayClient({ id: 'A', url: gw.url, driver: 'gateway', prefix: gw.prefix, key: API_KEY, sandboxBase: null, sandboxKey: '', spawn: null, access: null })]])
  // Auth has its own tests; every request here counts as signed in.
  const config = configFor(gw, agent)
  const endpoint = config.endpoints.A
  if (upstream !== undefined && endpoint !== undefined) endpoint.driver = 'apiproxy'
  registerChatRoutes(app, config, db, clients, async () => undefined, upstream === undefined ? undefined : new Map([['A', upstream]]))
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return { base: `http://127.0.0.1:${port}`, db, gateway: gw }
}

after(async () => {
  closeChatRelays()
  await Promise.all(apps.map((a) => a.close()))
  await Promise.all(gateways.map((g) => g.close()))
})

/**
 * Collects relayed frames until the turn reports itself finished.
 *
 * Reading to end-of-stream is not an option: the relay is deliberately kept open
 * for the next turn, so a test that waited for EOF would hang.
 */
const collectFrames = async (
  response: Response,
  stopWhen: (frame: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>[]> => {
  const reader = response.body?.getReader()
  assert.ok(reader !== undefined, 'the relay answered without a body')
  const decoder = new TextDecoder()
  const frames: Record<string, unknown>[] = []
  let buffered = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffered += decoder.decode(value, { stream: true })
    // Frames are separated by a blank line; a partial tail stays buffered.
    const blocks = buffered.split('\n\n')
    buffered = blocks.pop() ?? ''
    for (const block of blocks) {
      for (const line of block.split('\n')) {
        if (!line.startsWith('data: ')) continue
        const frame = JSON.parse(line.slice(6)) as Record<string, unknown>
        frames.push(frame)
      }
    }
    if (frames.some(stopWhen)) break
  }

  await reader.cancel()
  return frames
}

const newChat = async (base: string): Promise<string> => {
  const created = await fetch(`${base}/api/chats`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentId: 'personal' }),
  })
  assert.equal(created.status, 201)
  const body = (await created.json()) as { chat: { id: string } }
  return body.chat.id
}

test('composer state exposes context, model selection, and restricted access controls', async () => {
  const upstream = new FakeSessionDriver('A', {
    frames: [],
    composer: {
      model: { provider: 'deepseek', model: 'chat' },
      context: { usedTokens: 32_000, contextWindow: 128_000, breakdown: { systemTokens: 4_000, toolsTokens: 8_000, messageTokens: 20_000 } },
      accessMode: 'workspace-write',
    },
    models: {
      current: { provider: 'deepseek', model: 'chat' },
      routable: true,
      groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'chat', name: 'Chat' }, { id: 'reasoner', name: 'Reasoner' }] }],
      failures: [],
    },
  })
  const { base, db } = await boot({ frames: [] }, upstream)
  const chatId = await newChat(base)
  bindSession(db, chatId, 'fake-1')

  const current = await fetch(`${base}/api/chats/${chatId}`)
  assert.equal(current.status, 200)
  const state = await current.json() as { composer?: { context?: { percent: number }; model?: { model: string }; accessMode?: string; capabilities?: { modelSelection: boolean; accessMode: boolean; fullAccess: boolean; fullAccessForm: string } } }
  assert.equal(state.composer?.context?.percent, 25)
  assert.equal(state.composer?.model?.model, 'chat')
  assert.equal(state.composer?.accessMode, 'workspace-write')
  assert.deepEqual(state.composer?.capabilities, { modelSelection: true, accessMode: true, fullAccess: false, fullAccessForm: 'bare-metal' })

  const models = await fetch(`${base}/api/chats/${chatId}/models`)
  assert.equal(models.status, 200)
  assert.equal(((await models.json()) as { catalog: { groups: unknown[] } }).catalog.groups.length, 1)

  const selected = await fetch(`${base}/api/chats/${chatId}/model`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'deepseek', model: 'reasoner' }),
  })
  assert.equal(selected.status, 200)
  assert.deepEqual(upstream.selectedModels, [{ sessionId: 'fake-1', provider: 'deepseek', model: 'reasoner' }])

  const access = await fetch(`${base}/api/chats/${chatId}/sandbox-mode`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'read-only' }),
  })
  assert.equal(access.status, 200)
  assert.deepEqual(upstream.sandboxPins, [{ sessionId: 'fake-1', mode: 'read-only' }])
})

// ---------------------------------------------------------------------------
// cold-session sandbox switch (deferred override)
// ---------------------------------------------------------------------------

test('sandbox switch on a cold session is recorded and deferred to the next turn', async () => {
  const upstream = new FakeSessionDriver('A', {
    frames: [],
    composer: { accessMode: 'read-only' },
    sandboxNotLive: true,
    fullAccess: true,
  })
  const { base, db } = await boot({ frames: [] }, upstream)
  const chatId = await newChat(base)
  bindSession(db, chatId, 'fake-1')

  const access = await fetch(`${base}/api/chats/${chatId}/sandbox-mode`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'danger-full-access' }),
  })
  assert.equal(access.status, 200)
  const body = (await access.json()) as { accessMode: string; deferred?: boolean }
  assert.equal(body.accessMode, 'danger-full-access')
  assert.equal(body.deferred, true)
  // 冷会话上不能直钉：pin 不得打到上游，而是落库。
  assert.equal(upstream.sandboxPins.length, 0)
  const row = db.select().from(schema.chat).where(eq(schema.chat.id, chatId)).get()
  assert.equal(row?.accessModeOverride, 'danger-full-access')
  // 展示真相：刷新后 composer 报的是 manager 记录的钉入值，不是宿主推导值。
  const state = (await (await fetch(`${base}/api/chats/${chatId}`)).json()) as { composer?: { accessMode?: string } }
  assert.equal(state.composer?.accessMode, 'danger-full-access')
})

// ---------------------------------------------------------------------------
// composer access-mode truth (2026-09-11: host preset label drifts from the
// sandbox knob; the manager must never display the drifted label)
// ---------------------------------------------------------------------------

test('composer reports a full-access pin after reload even when the host view would say otherwise', async () => {
  const upstream = new FakeSessionDriver('A', { frames: [], composer: { accessMode: null } })
  const { base, db } = await boot({ frames: [] }, upstream)
  const chatId = await newChat(base)
  bindSession(db, chatId, 'fake-1')

  const access = await fetch(`${base}/api/chats/${chatId}/sandbox-mode`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'danger-full-access' }),
  })
  assert.equal(access.status, 200)
  assert.equal(upstream.sandboxPins.length, 1)

  const state = (await (await fetch(`${base}/api/chats/${chatId}`)).json()) as { composer?: { accessMode?: string } }
  assert.equal(state.composer?.accessMode, 'danger-full-access')
})

test('composer passes a host-derived full-access mode through (no pin involved)', async () => {
  const upstream = new FakeSessionDriver('A', { frames: [], composer: { accessMode: 'danger-full-access' } })
  const { base, db } = await boot({ frames: [] }, upstream)
  const chatId = await newChat(base)
  bindSession(db, chatId, 'fake-1')

  const state = (await (await fetch(`${base}/api/chats/${chatId}`)).json()) as { composer?: { accessMode?: string } }
  assert.equal(state.composer?.accessMode, 'danger-full-access')
})

// ---------------------------------------------------------------------------
// Ongoing Goal 条（2026-09-11：宿主 goal 投影 → 历史与直播两条路径）
// ---------------------------------------------------------------------------

test('a host goal projection is reported in the chat state', async () => {
  const upstream = new FakeSessionDriver('A', {
    frames: [],
    goal: { id: 'g1', objective: '把文档站点发布上线', phase: 'active', blockedReason: null },
  })
  const { base, db } = await boot({ frames: [] }, upstream)
  const chatId = await newChat(base)
  bindSession(db, chatId, 'fake-1')

  const state = (await (await fetch(`${base}/api/chats/${chatId}`)).json()) as { goal?: { id?: string; objective?: string; phase?: string } }
  assert.deepEqual(state.goal, { id: 'g1', objective: '把文档站点发布上线', phase: 'active', blockedReason: null })
})

test('a goal projection frame reaches the browser relay', async () => {
  const goal = { id: 'g2', objective: '迁移到 0.1.2', phase: 'active', blockedReason: null }
  const { base } = await boot({
    frames: [
      { kind: 'goal', seq: 7, goal },
      { kind: 'message', text: '好。', reasoning: null, usage: { inputTokens: 1, outputTokens: 1 } },
      { kind: 'turn_end', turn: 1, reason: 'completed', detail: null },
    ],
  })
  const chatId = await newChat(base)

  const stream = await fetch(`${base}/api/chats/${chatId}/events`)
  const collected = collectFrames(stream, (f) => f.kind === 'turn_done')

  const sent = await fetch(`${base}/api/chats/${chatId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '开始迁移' }),
  })
  assert.equal(sent.status, 202)

  const frames = await collected
  const goals = frames.filter((f) => f.kind === 'goal')
  assert.equal(goals.length, 1)
  assert.deepEqual(goals[0]?.goal, goal)
})

// ---------------------------------------------------------------------------
// the relay
// ---------------------------------------------------------------------------

test('the user message is relayed once, not twice', async () => {
  // The gateway echoes the instruction back as its own `user` event, and this
  // route publishes one the moment the message arrives. Relaying both draws the
  // same bubble twice in every watching tab.
  const { base } = await boot({
    frames: [
      { kind: 'user', text: '把这周的开销汇总一下' },
      { kind: 'message', text: '好的。', reasoning: null, usage: { inputTokens: 10, outputTokens: 5 } },
      { kind: 'turn_end', turn: 1, reason: 'completed', detail: null },
    ],
  })
  const chatId = await newChat(base)

  const stream = await fetch(`${base}/api/chats/${chatId}/events`)
  assert.equal(stream.status, 200)
  const collected = collectFrames(stream, (f) => f.kind === 'turn_done')

  const sent = await fetch(`${base}/api/chats/${chatId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '把这周的开销汇总一下' }),
  })
  assert.equal(sent.status, 202)

  const frames = await collected
  const users = frames.filter((f) => f.kind === 'user')
  assert.equal(users.length, 1, `expected one user frame, got ${JSON.stringify(users)}`)
  assert.equal(users[0]?.text, '把这周的开销汇总一下')
  // The rest of the turn still arrives; the filter is not swallowing the stream.
  assert.ok(
    frames.some((f) => f.kind === 'message'),
    'the assistant reply is still relayed',
  )
  assert.ok(frames.some((f) => f.kind === 'turn_done'))
})

test('the first-turn question can be answered before the turn ends', async () => {
  const { base, db, gateway } = await boot({
    gapMs: 20,
    frames: [
      { kind: 'question_asked', questionId: 'q-1', questions: [{ id: 'choice', question: '继续吗？', options: [{ label: '继续' }] }] },
      { kind: 'sleep', ms: 400 },
      { kind: 'question_resolved', questionId: 'q-1', outcome: 'answered' },
      { kind: 'turn_end', reason: 'completed', detail: null },
    ],
  })
  const chatId = await newChat(base)
  const stream = await fetch(`${base}/api/chats/${chatId}/events`)
  const question = collectFrames(stream, (frame) => frame.kind === 'question_asked')

  const sent = await fetch(`${base}/api/chats/${chatId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '请询问我' }),
  })
  assert.equal(sent.status, 202)
  await question

  const answer = await fetch(`${base}/api/chats/${chatId}/questions/q-1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ answers: [{ id: 'choice', selected: ['继续'] }] }),
  })
  assert.equal(answer.status, 200)
  assert.equal(db.select().from(schema.chat).where(eq(schema.chat.id, chatId)).all()[0]?.dshSessionId, 'sess-1')
  assert.deepEqual(gateway.questionAnswers, [{ answers: [{ id: 'choice', selected: ['继续'] }] }])
})

test('a refresh restores the current turn and its unanswered question', async () => {
  const { base } = await boot({
    gapMs: 20,
    frames: [
      { kind: 'question_asked', questionId: 'q-refresh', questions: [{ id: 'choice', question: '继续吗？', options: [{ label: '继续' }] }] },
      { kind: 'sleep', ms: 500 },
      { kind: 'turn_end', reason: 'completed', detail: null },
    ],
  })
  const chatId = await newChat(base)
  const stream = await fetch(`${base}/api/chats/${chatId}/events`)
  const question = collectFrames(stream, (frame) => frame.kind === 'question_asked')

  const sent = await fetch(`${base}/api/chats/${chatId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '请询问我' }),
  })
  assert.equal(sent.status, 202)
  await question

  const reloaded = await fetch(`${base}/api/chats/${chatId}`)
  assert.equal(reloaded.status, 200)
  const body = (await reloaded.json()) as { liveFrames?: Array<{ kind: string }> }
  assert.deepEqual(body.liveFrames?.map((frame) => frame.kind), ['user', 'question_asked'])
})

test('债务卡片链: turn_done 后未作答的卡片仍可重放(刷新与新 SSE 连接都恢复)', async () => {
  const { base } = await boot({
    gapMs: 20,
    frames: [
      { kind: 'question_asked', questionId: 'q-keep', questions: [{ id: 'choice', question: '继续吗？', options: [{ label: '继续' }] }] },
      { kind: 'sleep', ms: 150 },
      // 上游故意不再发 resolved(模拟回合因超时/重连死亡)——问题还挂在宿主上
      { kind: 'turn_end', reason: 'completed', detail: null },
    ],
  })
  const chatId = await newChat(base)
  const stream = await fetch(`${base}/api/chats/${chatId}/events`)
  const done = collectFrames(stream, (f) => f.kind === 'turn_done')

  const sent = await fetch(`${base}/api/chats/${chatId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '请询问我' }),
  })
  assert.equal(sent.status, 202)
  await done

  // 刷新(GET)重放:卡片必须在
  const reloaded = await fetch(`${base}/api/chats/${chatId}`)
  const body = (await reloaded.json()) as { liveFrames?: Array<{ kind: string; questionId?: string }> }
  const kept = body.liveFrames?.filter((f) => f.kind === 'question_asked') ?? []
  assert.equal(kept.length, 1, 'turn_done 后挂起卡片仍须重放')
  assert.equal(kept[0]?.questionId, 'q-keep')

  // 新 SSE 连接:hello 之后立即重放卡片帧(断流恢复路径)
  const stream2 = await fetch(`${base}/api/chats/${chatId}/events`)
  const frames2 = await collectFrames(stream2, (f) => f.kind === 'question_asked' && f.questionId === 'q-keep')
  assert.ok(frames2.some((f) => f.kind === 'question_asked' && f.questionId === 'q-keep'), 'SSE 重连必须重放挂起卡片')
})

test('债务卡片链: manager 重启后 GET 经 pendingAsks 恢复挂起卡片(重放可答)', async () => {
  const question = { kind: 'question_asked', seq: 0, questionId: 'q-restart', questions: [{ id: 'a', question: '重启前的问句' }] } as const
  let calls = 0
  const upstream = new FakeSessionDriver('A', {
    frames: [
      { kind: 'turn_start', seq: 0, turn: 1 },
      { kind: 'turn_end', seq: 0, turn: 1, reason: 'completed', detail: null },
    ],
    pendingAsks: () => {
      calls += 1
      // 回合开始查一次(空)——模拟「广播发生在 manager 重启前,重启后内存全丢」
      return calls === 1 ? [] : [question]
    },
  })
  const { base } = await boot({ frames: [] }, upstream)
  const chatId = await newChat(base)
  const sent = await fetch(`${base}/api/chats/${chatId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'hi' }),
  })
  assert.equal(sent.status, 202)

  // 轮询 GET 直到恢复卡片出现(回合启动/恢复查询是异步的,固定 sleep 在并行
  // 全量跑下会抖;最多 2s,任一时刻收敛即通过)。
  let reloaded: Response | null = null
  let body: { liveFrames?: Array<{ kind: string; questionId?: string }> } = {}
  for (let i = 0; i < 40; i += 1) {
    reloaded = await fetch(`${base}/api/chats/${chatId}`)
    assert.equal(reloaded.status, 200)
    body = (await reloaded.json()) as { liveFrames?: Array<{ kind: string; questionId?: string }> }
    if ((body.liveFrames ?? []).some((f) => f.kind === 'question_asked')) break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  const kept = body.liveFrames?.filter((f) => f.kind === 'question_asked') ?? []
  assert.equal(kept.length, 1, '重启后 GET 必须经恢复通道重放挂起卡片')
  assert.equal(kept[0]?.questionId, 'q-restart')
})

test('债务卡片链: 应答成功后合成 question_resolved——不依赖上游广播,卡片关闭且重放清空', async () => {
  const { base } = await boot({
    gapMs: 20,
    frames: [
      { kind: 'question_asked', questionId: 'q-ans', questions: [{ id: 'choice', question: '继续吗？', options: [{ label: '继续' }] }] },
      { kind: 'sleep', ms: 300 },
      // 上游故意不再发 resolved(模拟 runner 已死/断线窗口)
      { kind: 'turn_end', reason: 'completed', detail: null },
    ],
  })
  const chatId = await newChat(base)
  const stream = await fetch(`${base}/api/chats/${chatId}/events`)
  const question = collectFrames(stream, (f) => f.kind === 'question_asked')
  await fetch(`${base}/api/chats/${chatId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '请询问我' }),
  })
  await question

  // 第二个 SSE 连接等 resolved(同一 Response 的流只能锁一个 reader)
  const stream2 = await fetch(`${base}/api/chats/${chatId}/events`)
  const resolved = collectFrames(stream2, (f) => f.kind === 'question_resolved')
  const answer = await fetch(`${base}/api/chats/${chatId}/questions/q-ans`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ answers: [{ id: 'choice', selected: ['继续'] }] }),
  })
  assert.equal(answer.status, 200)
  const frames = await resolved
  assert.ok(frames.some((f) => f.kind === 'question_resolved' && f.questionId === 'q-ans'), '应答后必须合成 resolved 帧')

  const reloaded = await fetch(`${base}/api/chats/${chatId}`)
  const body = (await reloaded.json()) as { liveFrames?: Array<{ kind: string }> }
  assert.ok(!(body.liveFrames ?? []).some((f) => f.kind === 'question_asked'), '应答后挂起卡片必须从重放移除')
})

test('stopping a question-waiting turn finishes the local run even when its stream stays open', async () => {
  const { base, db } = await boot({
    gapMs: 20,
    frames: [
      { kind: 'question_asked', questionId: 'q-stop', questions: [{ id: 'choice', question: '继续吗？', options: [{ label: '继续' }] }] },
      { kind: 'sleep', ms: 1_000 },
      { kind: 'turn_end', reason: 'completed', detail: null },
    ],
  })
  const chatId = await newChat(base)
  const stream = await fetch(`${base}/api/chats/${chatId}/events`)
  const question = collectFrames(stream, (frame) => frame.kind === 'question_asked')

  const sent = await fetch(`${base}/api/chats/${chatId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '请询问我' }),
  })
  assert.equal(sent.status, 202)
  await question

  const stopped = await fetch(`${base}/api/chats/${chatId}/cancel`, { method: 'POST' })
  assert.equal(stopped.status, 202)
  for (let i = 0; i < 25; i += 1) {
    const state = db.select({ state: schema.run.state }).from(schema.run).where(eq(schema.run.chatId, chatId)).all()[0]?.state
    if (state === 'failed') break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.equal(db.select({ state: schema.run.state }).from(schema.run).where(eq(schema.run.chatId, chatId)).all()[0]?.state, 'failed')
})

test('a browser that walks away frees its connection', async () => {
  // The failure this guards against does not look like a bug in the relay: a
  // subscriber that is never dropped keeps one of the six connections HTTP/1.1
  // gives an origin, and six of those make every later request -- including the
  // next page's HTML -- hang with nothing in the log to explain it.
  const { base } = await boot({ frames: [] })
  const chatId = await newChat(base)
  const before = openChatRelays()

  const controller = new AbortController()
  const stream = await fetch(`${base}/api/chats/${chatId}/events`, { signal: controller.signal })
  assert.equal(stream.status, 200)
  // One chunk, with the reader left open: `collectFrames` cancels the body when
  // it is done, which would end the stream and hide the very thing under test.
  const reader = stream.body?.getReader()
  assert.ok(reader !== undefined)
  await reader.read()
  assert.equal(openChatRelays(), before + 1, 'the watcher is registered')

  controller.abort()

  // The socket teardown is asynchronous; poll rather than sleep a fixed amount.
  for (let i = 0; i < 50 && openChatRelays() > before; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.equal(openChatRelays(), before, 'and unregistered once the browser is gone')
})

// ---------------------------------------------------------------------------
// archive and restore
// ---------------------------------------------------------------------------

test('archiving hides a chat, listing it as archived, and restore brings it back', async () => {
  // Archiving is a soft delete, so the round trip has to actually close: a chat
  // that disappears from both lists is indistinguishable from a deleted one.
  const { base } = await boot({ frames: [] })
  const chatId = await newChat(base)

  const archived = await fetch(`${base}/api/chats/${chatId}/remove`, { method: 'POST' })
  assert.equal(archived.status, 200)

  const live = (await (await fetch(`${base}/api/chats`)).json()) as {
    agents: { chats: { id: string }[] }[]
  }
  assert.ok(
    !live.agents.some((a) => a.chats.some((c) => c.id === chatId)),
    'an archived chat is out of the sidebar list',
  )

  const list = (await (await fetch(`${base}/api/chats/archived`)).json()) as {
    chats: { id: string; agentName: string; agentGone: boolean; removedAt: number | null }[]
  }
  const row = list.chats.find((c) => c.id === chatId)
  assert.ok(row !== undefined, 'the archived chat is listed')
  assert.equal(row.agentName, 'Personal')
  assert.equal(row.agentGone, false)
  assert.ok(typeof row.removedAt === 'number', 'the row says when it was archived')

  const restored = await fetch(`${base}/api/chats/${chatId}/restore`, { method: 'POST' })
  assert.equal(restored.status, 200)

  const after = (await (await fetch(`${base}/api/chats`)).json()) as {
    agents: { chats: { id: string }[] }[]
  }
  assert.ok(
    after.agents.some((a) => a.chats.some((c) => c.id === chatId)),
    'a restored chat is back in the sidebar list',
  )
  const emptied = (await (await fetch(`${base}/api/chats/archived`)).json()) as { chats: { id: string }[] }
  assert.ok(!emptied.chats.some((c) => c.id === chatId), 'and out of the archive')
})

test('/api/chats/archived is not read as a chat id', async () => {
  // `archived` is a static segment sharing a prefix with `/api/chats/:id`. If
  // routing ever prefers the parameter, this becomes a 404 for a chat nobody
  // created -- and the archive page silently shows nothing.
  const { base } = await boot({ frames: [] })
  const response = await fetch(`${base}/api/chats/archived`)
  assert.equal(response.status, 200)
  assert.ok(Array.isArray(((await response.json()) as { chats: unknown[] }).chats))
})

test('restoring a chat that was never archived is not an error', async () => {
  // Two tabs, one archive: the second restore must not report a failure for a
  // state that already matches what was asked for.
  const { base } = await boot({ frames: [] })
  const chatId = await newChat(base)
  const response = await fetch(`${base}/api/chats/${chatId}/restore`, { method: 'POST' })
  assert.equal(response.status, 200)
})

test('the echo arrives before the gateway is even involved', async () => {
  // The point of publishing our own copy: a second tab should show the message
  // immediately, not sit blank until a session has been created upstream.
  const { base } = await boot({
    frames: [
      { kind: 'message', text: '收到', reasoning: null, usage: { inputTokens: 1, outputTokens: 1 } },
      { kind: 'turn_end', turn: 1, reason: 'completed', detail: null },
    ],
    gapMs: 50,
  })
  const chatId = await newChat(base)

  const stream = await fetch(`${base}/api/chats/${chatId}/events`)
  const collected = collectFrames(stream, (f) => f.kind === 'user')

  void fetch(`${base}/api/chats/${chatId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '在吗' }),
  })

  const frames = await collected
  const first = frames.find((f) => f.kind === 'user')
  assert.equal(first?.text, '在吗')
  assert.ok(typeof first?.at === 'number', "manager's own echo carries a timestamp")
})

test('delegations: a chat lists the brain runs it dispatched (蜂群 P2)', async () => {
  const { base, db } = await boot({ frames: [] })
  const chatId = await newChat(base)
  const now = Date.now()
  db.insert(schema.run)
    .values({
      id: 'run-brain-1',
      agentId: 'personal',
      chatId: null,
      sourceChatId: chatId,
      cronId: null,
      dshSessionId: null,
      trigger: 'brain',
      idempotencyKey: null,
      state: 'done',
      resultSummary: '周报已更新',
      startedAt: now,
      endedAt: now,
      error: null,
      commitHash: null,
    })
    .run()

  const response = await fetch(`${base}/api/chats/${chatId}/delegations`)
  assert.equal(response.status, 200)
  const body = (await response.json()) as { delegations: Array<{ runId: string; state: string; agentName: string; summary: string | null }> }
  assert.equal(body.delegations.length, 1)
  assert.equal(body.delegations[0]?.runId, 'run-brain-1')
  assert.equal(body.delegations[0]?.state, 'done')
  assert.equal(body.delegations[0]?.agentName, 'Personal')
  assert.equal(body.delegations[0]?.summary, '周报已更新')

  const missing = await fetch(`${base}/api/chats/no-such-chat/delegations`)
  assert.equal(missing.status, 404)
})

test('vacate: an empty chat is hard-deleted; a chat with turns or a title refuses (蜂群 Q5)', async () => {
  const { base, db } = await boot({ frames: [] })
  const now = Date.now()

  const insertChat = (id: string, title: string | null) => {
    db.insert(schema.chat)
      .values({ id, agentId: 'personal', title, createdAt: now, lastActiveAt: now, removedAt: null, dshSessionId: null })
      .run()
  }

  // 空会话：删掉，行消失
  insertChat('empty-1', null)
  const vacated = await fetch(`${base}/api/chats/empty-1/vacate`, { method: 'POST' })
  assert.equal(vacated.status, 200)
  assert.deepEqual(await vacated.json(), { ok: true, vacated: true })
  assert.equal(db.select().from(schema.chat).where(eq(schema.chat.id, 'empty-1')).all().length, 0)

  // 有回合：409，行保留
  insertChat('busy-1', null)
  db.insert(schema.run)
    .values({
      id: 'run-1',
      agentId: 'personal',
      chatId: 'busy-1',
      sourceChatId: null,
      cronId: null,
      dshSessionId: null,
      trigger: 'manual',
      idempotencyKey: null,
      state: 'done',
      resultSummary: 'x',
      startedAt: now,
      endedAt: now,
      error: null,
      commitHash: null,
    })
    .run()
  const busy = await fetch(`${base}/api/chats/busy-1/vacate`, { method: 'POST' })
  assert.equal(busy.status, 409)
  assert.equal(db.select().from(schema.chat).where(eq(schema.chat.id, 'busy-1')).all().length, 1)

  // 有标题：409
  insertChat('titled-1', '被网关起过名字')
  const titled = await fetch(`${base}/api/chats/titled-1/vacate`, { method: 'POST' })
  assert.equal(titled.status, 409)

  // 未知 / 已归档：404
  const missing = await fetch(`${base}/api/chats/no-such/vacate`, { method: 'POST' })
  assert.equal(missing.status, 404)
  insertChat('gone-1', null)
  db.update(schema.chat).set({ removedAt: now }).where(eq(schema.chat.id, 'gone-1')).run()
  const archived = await fetch(`${base}/api/chats/gone-1/vacate`, { method: 'POST' })
  assert.equal(archived.status, 404)
})
