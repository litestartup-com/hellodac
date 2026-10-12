import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import Fastify, { type FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import type { AppConfig, ResolvedAgent } from '../config.js'
import { openDb, schema, type Db } from '../db/index.js'
import { FakeSessionDriver, type FakeScript } from '../session-driver/fake.js'
import type { SessionDriver } from '../session-driver/port.js'
import type { MuxListener } from '../upstream/mux.js'
import type { GatewayFrame } from '../frames.js'
import { UpstreamError } from '../upstream/rpc.js'
import { DEFAULT_PRICING } from '../pricing.js'
import { closeChatRelays, openChatRelays, registerChatRoutes } from './chat.js'
import { bindSession } from '../chat/store.js'

/**
 * The chat routes and the relay, over a real socket and the SessionDriver port.
 *
 * These need an actual listening server rather than `app.inject`: the behaviour
 * under test is a stream that stays open across a request, and inject resolves
 * with a finished response.
 *
 * The upstream is the scripted in-memory fake (session-driver/fake.ts), keyed by
 * the endpoint id in the `upstreamClients` map that `registerChatRoutes` takes
 * since the gateway retirement -- there is no gateway HTTP server to stand up
 * any more, and nothing in these tests touches the wire.
 */

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

const configFor = (agent: ResolvedAgent): AppConfig => ({
  listen: { host: '127.0.0.1', port: 0 },
  // The url is never dialled: the SessionDriver for endpoint A arrives through
  // the upstreamClients map, not through the wire.
  endpoints: { A: { id: 'A', url: 'http://127.0.0.1:1/api', driver: 'apiproxy', prefix: '', key: 'test-key', sandboxBase: null, sandboxKey: '', spawn: null, access: null } },
  agents: { personal: agent },
  runner: { timeoutMs: 10_000, silenceMs: 0, maxConsecutiveFailures: 3, dailyBudgetMicroUsd: null },
  databasePath: ':memory:',
  pricing: DEFAULT_PRICING,
  sessionSecret: 'x'.repeat(32),
  initialUser: { username: 'admin', password: null },
  warnings: [],
})

const apps: FastifyInstance[] = []

interface Harness {
  base: string
  db: Db
  config: AppConfig
  workspace: string
  upstream: SessionDriver
}

const boot = async (upstream?: SessionDriver): Promise<Harness> => {
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
  const driver = upstream ?? new FakeSessionDriver('A', { frames: [] })
  const upstreamClients = new Map<string, SessionDriver>([['A', driver]])
  const config = configFor(agent)
  // Auth has its own tests; every request here counts as signed in.
  registerChatRoutes(app, config, db, async () => undefined, upstreamClients)
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return { base: `http://127.0.0.1:${port}`, db, config, workspace, upstream: driver }
}

after(async () => {
  closeChatRelays()
  await Promise.all(apps.map((a) => a.close()))
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

const postJson = async (url: string, body: unknown): Promise<Response> =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

const sendMessage = async (base: string, chatId: string, text: string): Promise<Response> =>
  postJson(`${base}/api/chats/${chatId}/messages`, { text })

// ---- frame fixtures --------------------------------------------------------

const turnEnd = (turn = 1): GatewayFrame => ({ kind: 'turn_end', seq: 0, turn, reason: 'completed', detail: null })

const messageFrame = (text: string): GatewayFrame => ({
  kind: 'message', seq: 0, text, reasoning: null, usage: { inputTokens: 10, outputTokens: 5 },
})

const questionFrame = (questionId: string): GatewayFrame => ({
  kind: 'question_asked',
  seq: 0,
  questionId,
  questions: [{ id: 'choice', question: 'Continue?', options: [{ label: 'Continue' }] }],
})

/** Polls a condition every 20ms rather than sleeping a fixed (flaky) amount. */
const eventually = async (check: () => boolean, what: string, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail(`timed out waiting for ${what}`)
}

/**
 * A fake whose frames the test pumps by hand: the turn stays live (and the chat
 * stays "busy") until it is handed a turn_end -- the port-world replacement for
 * the old scripted gateway's `sleep` frames. The listener set mirrors the
 * fake's own, minus unsubscribed entries, so a pump never reaches a dead turn.
 */
class ManualFake extends FakeSessionDriver {
  private readonly live = new Set<MuxListener>()
  constructor(script: FakeScript) {
    super('A', script)
  }
  override subscribe(sessionId: string, listener: MuxListener): () => void {
    this.live.add(listener)
    const unsubscribe = super.subscribe(sessionId, listener)
    return () => {
      this.live.delete(listener)
      unsubscribe()
    }
  }
  /** Delivers one frame to the current subscribers, like the host's stream would. */
  pump(sessionId: string, frame: GatewayFrame): void {
    for (const listener of [...this.live]) listener(sessionId, frame)
  }
}

const runStates = (db: Db, chatId: string): string[] =>
  db.select({ state: schema.run.state }).from(schema.run).where(eq(schema.run.chatId, chatId)).all().map((r) => r.state)

/** Waits until the turn under test has subscribed, so a pumped frame cannot be lost. */
const awaitTurn = async (fake: ManualFake, sessionId = 'fake-1'): Promise<void> => {
  await eventually(() => fake.activeSubscriberCount(sessionId) > 0, 'the turn to subscribe to its session')
}

/** Lets the running turn of a chat finish: pump turn_end, then wait for the run row to settle. */
const finishTurn = async (db: Db, fake: ManualFake, chatId: string, sessionId = 'fake-1'): Promise<void> => {
  await awaitTurn(fake, sessionId)
  fake.pump(sessionId, turnEnd())
  await eventually(
    () => runStates(db, chatId).every((state) => state !== 'running'),
    'the turn to finish',
  )
}

// ---------------------------------------------------------------------------
// composer state
// ---------------------------------------------------------------------------

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
  const { base, db } = await boot(upstream)
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

  const selected = await postJson(`${base}/api/chats/${chatId}/model`, { provider: 'deepseek', model: 'reasoner' })
  assert.equal(selected.status, 200)
  assert.deepEqual(upstream.selectedModels, [{ sessionId: 'fake-1', provider: 'deepseek', model: 'reasoner' }])

  const access = await postJson(`${base}/api/chats/${chatId}/sandbox-mode`, { mode: 'read-only' })
  assert.equal(access.status, 200)
  assert.deepEqual(upstream.sandboxPins, [{ sessionId: 'fake-1', mode: 'read-only' }])
})

// ---------------------------------------------------------------------------
// cold-session sandbox switch (deferred override)
// ---------------------------------------------------------------------------

test('sandbox switch on a cold session is recorded and deferred to the next turn', async () => {
  // The script object stays mutable on purpose: FakeSessionDriver reads
  // sandboxNotLive per call, so the test can flip the host back to live and
  // watch the deferred override land on the next turn.
  const script: FakeScript = {
    frames: [turnEnd()],
    composer: { accessMode: 'read-only' },
    sandboxNotLive: true,
    fullAccess: true,
  }
  const upstream = new FakeSessionDriver('A', script)
  const { base, db } = await boot(upstream)
  const chatId = await newChat(base)
  bindSession(db, chatId, 'fake-1')

  const access = await postJson(`${base}/api/chats/${chatId}/sandbox-mode`, { mode: 'danger-full-access' })
  assert.equal(access.status, 200)
  const body = (await access.json()) as { accessMode: string; deferred?: boolean }
  assert.equal(body.accessMode, 'danger-full-access')
  assert.equal(body.deferred, true)
  // A pin cannot go straight through on a cold chat: the pin must not reach upstream, it goes to the database.
  assert.equal(upstream.sandboxPins.length, 0)
  const row = () => db.select().from(schema.chat).where(eq(schema.chat.id, chatId)).get()
  assert.equal(row()?.accessModeOverride, 'danger-full-access')
  // Display truth: after a reload the composer reports the pinned value the manager recorded, not the host-derived one.
  const state = (await (await fetch(`${base}/api/chats/${chatId}`)).json()) as { composer?: { accessMode?: string } }
  assert.equal(state.composer?.accessMode, 'danger-full-access')

  // The host comes back: the next turn (a continuation of the bound session) pins
  // the deferred override through the port and clears the record.
  script.sandboxNotLive = false
  const sent = await sendMessage(base, chatId, 'carry on')
  assert.equal(sent.status, 202)
  await eventually(() => upstream.sandboxPins.length === 1, 'the next turn to pin the deferred override')
  assert.deepEqual(upstream.sandboxPins, [{ sessionId: 'fake-1', mode: 'danger-full-access' }])
  await eventually(() => row()?.accessModeOverride === null, 'the override to be cleared once pinned')
  await eventually(() => runStates(db, chatId).every((s) => s !== 'running'), 'the turn to finish')
})

// ---------------------------------------------------------------------------
// composer access-mode truth (2026-09-11: host preset label drifts from the
// sandbox knob; the manager must never display the drifted label)
// ---------------------------------------------------------------------------

test('composer reports a full-access pin after reload even when the host view would say otherwise', async () => {
  const upstream = new FakeSessionDriver('A', { frames: [], composer: { accessMode: null } })
  const { base, db } = await boot(upstream)
  const chatId = await newChat(base)
  bindSession(db, chatId, 'fake-1')

  const access = await postJson(`${base}/api/chats/${chatId}/sandbox-mode`, { mode: 'danger-full-access' })
  assert.equal(access.status, 200)
  assert.equal(upstream.sandboxPins.length, 1)

  const state = (await (await fetch(`${base}/api/chats/${chatId}`)).json()) as { composer?: { accessMode?: string } }
  assert.equal(state.composer?.accessMode, 'danger-full-access')
})

test('composer passes a host-derived full-access mode through (no pin involved)', async () => {
  const upstream = new FakeSessionDriver('A', { frames: [], composer: { accessMode: 'danger-full-access' } })
  const { base, db } = await boot(upstream)
  const chatId = await newChat(base)
  bindSession(db, chatId, 'fake-1')

  const state = (await (await fetch(`${base}/api/chats/${chatId}`)).json()) as { composer?: { accessMode?: string } }
  assert.equal(state.composer?.accessMode, 'danger-full-access')
})

// ---------------------------------------------------------------------------
// The ongoing goal bar (2026-09-11: the host goal projection -> both the history and the live path)
// ---------------------------------------------------------------------------

test('a host goal projection is reported in the chat state', async () => {
  const upstream = new FakeSessionDriver('A', {
    frames: [],
    goal: { id: 'g1', objective: 'Publish the documentation site', phase: 'active', blockedReason: null },
  })
  const { base, db } = await boot(upstream)
  const chatId = await newChat(base)
  bindSession(db, chatId, 'fake-1')

  const state = (await (await fetch(`${base}/api/chats/${chatId}`)).json()) as { goal?: { id?: string; objective?: string; phase?: string } }
  assert.deepEqual(state.goal, { id: 'g1', objective: 'Publish the documentation site', phase: 'active', blockedReason: null })
})

test('a goal projection frame reaches the browser relay', async () => {
  const goal = { id: 'g2', objective: 'Migrate to 0.1.2', phase: 'active', blockedReason: null }
  const upstream = new FakeSessionDriver('A', {
    frames: [
      { kind: 'goal', seq: 7, goal },
      messageFrame('On it.'),
      turnEnd(),
    ],
  })
  const { base } = await boot(upstream)
  const chatId = await newChat(base)

  const stream = await fetch(`${base}/api/chats/${chatId}/events`)
  const collected = collectFrames(stream, (f) => f.kind === 'turn_done')

  const sent = await sendMessage(base, chatId, 'start the migration')
  assert.equal(sent.status, 202)

  const frames = await collected
  const goals = frames.filter((f) => f.kind === 'goal')
  assert.equal(goals.length, 1)
  assert.deepEqual(goals[0]?.goal, goal)
})

// ---------------------------------------------------------------------------
// history: always through the upstream, cached, and the host title renames
// ---------------------------------------------------------------------------

/** Counts history reads and serves a host title plus one durable event. */
class CountingFake extends FakeSessionDriver {
  historyCalls = 0
  override async history(sessionId: string) {
    this.historyCalls += 1
    const host = await super.history(sessionId)
    return {
      ...host,
      title: 'Host-set title',
      events: [{ kind: 'message', seq: 0, text: 'an earlier turn' }],
    }
  }
}

test('history is read through the upstream, cached, and the host title renames the chat', async () => {
  const upstream = new CountingFake('A', { frames: [] })
  const { base, db } = await boot(upstream)
  const chatId = await newChat(base)
  bindSession(db, chatId, 'fake-1')

  const first = await fetch(`${base}/api/chats/${chatId}`)
  assert.equal(first.status, 200)
  const body = (await first.json()) as { sessionState: string; events: unknown[]; chat: { title: string | null } }
  assert.equal(body.sessionState, 'cold')
  assert.equal(body.events.length, 1, 'the events come from upstream.history()')
  assert.equal(body.chat.title, 'Host-set title', 'the host title renames the chat')
  assert.equal(upstream.historyCalls, 1)

  // A second open within the TTL is served from the cache: the host log read is
  // the expensive call the cache exists to avoid.
  const second = await fetch(`${base}/api/chats/${chatId}`)
  assert.equal(second.status, 200)
  assert.equal(upstream.historyCalls, 1, 'the cached history is not re-read')

  // A sandbox switch invalidates the cache: the next read goes to the host again.
  const pinned = await postJson(`${base}/api/chats/${chatId}/sandbox-mode`, { mode: 'read-only' })
  assert.equal(pinned.status, 200)
  const third = await fetch(`${base}/api/chats/${chatId}`)
  assert.equal(third.status, 200)
  assert.equal(upstream.historyCalls, 2, 'the switch invalidated the cache')
})

/** Fails history reads per session id: one lost (not_found), one unreachable. */
class ThrowingFake extends FakeSessionDriver {
  override async history(sessionId: string) {
    if (sessionId === 'lost-1') throw new UpstreamError('not_found', 'upstream session.history: session not found')
    if (sessionId === 'down-1') throw new Error('host on fire')
    return super.history(sessionId)
  }
}

test('history failures: only not_found makes a session lost; anything else is a 502', async () => {
  const { base, db } = await boot(new ThrowingFake('A', { frames: [] }))

  const lostChat = await newChat(base)
  bindSession(db, lostChat, 'lost-1')
  const lost = await fetch(`${base}/api/chats/${lostChat}`)
  assert.equal(lost.status, 200)
  assert.equal(((await lost.json()) as { sessionState: string }).sessionState, 'lost')

  const downChat = await newChat(base)
  bindSession(db, downChat, 'down-1')
  const down = await fetch(`${base}/api/chats/${downChat}`)
  assert.equal(down.status, 502)
  // The error string is kept as 'gateway_unreachable' for API parity; the
  // detail is the upstream failure's own text.
  assert.deepEqual(await down.json(), { error: 'gateway_unreachable', detail: 'host on fire' })
})

// ---------------------------------------------------------------------------
// resolve(): the 404/409/500 ladder
// ---------------------------------------------------------------------------

test('resolve: 500 when the endpoint has no driver, 409 when the agent is gone', async () => {
  const { base, db, config, workspace } = await boot()

  // An agent whose endpoint 'B' is in the config but has no SessionDriver in
  // the map: every session-touching route must answer 500 endpoint_not_configured.
  const ghost: ResolvedAgent = { ...agentFor(workspace), id: 'ghost', name: 'Ghost', endpoint: 'B' }
  config.agents.ghost = ghost
  db.insert(schema.agent)
    .values({ id: 'ghost', name: 'Ghost', workspacePath: workspace, endpoint: 'B', preset: null, gitRemote: null, public: 0, createdAt: Date.now() })
    .run()

  const created = await postJson(`${base}/api/chats`, { agentId: 'ghost' })
  assert.equal(created.status, 201)
  const ghostChatId = ((await created.json()) as { chat: { id: string } }).chat.id

  const missingDriver = await fetch(`${base}/api/chats/${ghostChatId}`)
  assert.equal(missingDriver.status, 500)
  assert.deepEqual(await missingDriver.json(), { error: 'endpoint_not_configured' })

  const send = await sendMessage(base, ghostChatId, 'hello')
  assert.equal(send.status, 500)
  assert.deepEqual(await send.json(), { error: 'endpoint_not_configured' })

  // A chat whose agent is nowhere in the config: 409 agent_gone. The agent row
  // exists in the DB (chat.agent_id is a foreign key) but not in config.agents,
  // which is exactly the "the config moved on without this chat" situation.
  db.insert(schema.agent)
    .values({ id: 'nobody', name: 'Nobody', workspacePath: workspace, endpoint: 'A', preset: null, gitRemote: null, public: 0, createdAt: Date.now() })
    .run()
  db.insert(schema.chat)
    .values({ id: 'orphan-1', agentId: 'nobody', title: null, createdAt: Date.now(), lastActiveAt: Date.now(), removedAt: null, dshSessionId: null })
    .run()
  const orphan = await fetch(`${base}/api/chats/orphan-1`)
  assert.equal(orphan.status, 409)
  assert.equal(((await orphan.json()) as { error: string }).error, 'agent_gone')
})

// ---------------------------------------------------------------------------
// the relay
// ---------------------------------------------------------------------------

test('the user message is relayed once, not twice', async () => {
  // The host echoes the instruction back as its own `user` frame, and this
  // route publishes one the moment the message arrives. Relaying both draws the
  // same bubble twice in every watching tab.
  const upstream = new FakeSessionDriver('A', {
    frames: [
      { kind: 'user', seq: 0, text: 'Sum up the spending for this week' },
      messageFrame('Here you go.'),
      turnEnd(),
    ],
  })
  const { base } = await boot(upstream)
  const chatId = await newChat(base)

  const stream = await fetch(`${base}/api/chats/${chatId}/events`)
  assert.equal(stream.status, 200)
  const collected = collectFrames(stream, (f) => f.kind === 'turn_done')

  const sent = await sendMessage(base, chatId, 'Sum up the spending for this week')
  assert.equal(sent.status, 202)

  const frames = await collected
  const users = frames.filter((f) => f.kind === 'user')
  assert.equal(users.length, 1, `expected one user frame, got ${JSON.stringify(users)}`)
  assert.equal(users[0]?.text, 'Sum up the spending for this week')
  // The rest of the turn still arrives; the filter is not swallowing the stream.
  assert.ok(
    frames.some((f) => f.kind === 'message'),
    'the assistant reply is still relayed',
  )
  assert.ok(frames.some((f) => f.kind === 'turn_done'))
})

test('the first-turn question can be answered before the turn ends', async () => {
  const upstream = new ManualFake({ frames: [] })
  const { base, db } = await boot(upstream)
  const chatId = await newChat(base)
  const stream = await fetch(`${base}/api/chats/${chatId}/events`)
  const question = collectFrames(stream, (frame) => frame.kind === 'question_asked')

  const sent = await sendMessage(base, chatId, 'ask me something')
  assert.equal(sent.status, 202)
  await awaitTurn(upstream)
  upstream.pump('fake-1', questionFrame('q-1'))
  await question

  const answer = await postJson(`${base}/api/chats/${chatId}/questions/q-1`, { answers: [{ id: 'choice', selected: ['Continue'] }] })
  assert.equal(answer.status, 200)
  assert.equal(db.select().from(schema.chat).where(eq(schema.chat.id, chatId)).all()[0]?.dshSessionId, 'fake-1')
  // The questionId is the rpc id of the port's respond contract.
  assert.deepEqual(upstream.answered, [{ rpcId: 'q-1', sessionId: 'fake-1', answer: { answers: [{ id: 'choice', selected: ['Continue'] }] } }])

  await finishTurn(db, upstream, chatId)
})

test('a refresh restores the current turn and its unanswered question', async () => {
  const upstream = new ManualFake({ frames: [] })
  const { base, db } = await boot(upstream)
  const chatId = await newChat(base)
  const stream = await fetch(`${base}/api/chats/${chatId}/events`)
  const question = collectFrames(stream, (frame) => frame.kind === 'question_asked')

  const sent = await sendMessage(base, chatId, 'ask me something')
  assert.equal(sent.status, 202)
  await awaitTurn(upstream)
  upstream.pump('fake-1', questionFrame('q-refresh'))
  await question

  const reloaded = await fetch(`${base}/api/chats/${chatId}`)
  assert.equal(reloaded.status, 200)
  const body = (await reloaded.json()) as { liveFrames?: Array<{ kind: string }> }
  assert.deepEqual(body.liveFrames?.map((frame) => frame.kind), ['user', 'question_asked'])

  await finishTurn(db, upstream, chatId)
})

test('debt card chain: a card left unanswered after turn_done is still replayed (both a refresh and a new SSE connection recover it)', async () => {
  const upstream = new ManualFake({ frames: [] })
  const { base } = await boot(upstream)
  const chatId = await newChat(base)
  const stream = await fetch(`${base}/api/chats/${chatId}/events`)
  const done = collectFrames(stream, (f) => f.kind === 'turn_done')

  const sent = await sendMessage(base, chatId, 'ask me something')
  assert.equal(sent.status, 202)
  await awaitTurn(upstream)
  upstream.pump('fake-1', questionFrame('q-keep'))
  // The upstream deliberately never sends a resolved frame (simulating a turn
  // that died from a timeout or a reconnect) -- the question is still parked on
  // the host, and the turn ends with the card open.
  upstream.pump('fake-1', turnEnd())
  await done

  // A refresh (GET) replays: the card must be there
  const reloaded = await fetch(`${base}/api/chats/${chatId}`)
  const body = (await reloaded.json()) as { liveFrames?: Array<{ kind: string; questionId?: string }> }
  const kept = body.liveFrames?.filter((f) => f.kind === 'question_asked') ?? []
  assert.equal(kept.length, 1, 'a pending card must still be replayed after turn_done')
  assert.equal(kept[0]?.questionId, 'q-keep')

  // A new SSE connection: the card frame is replayed right after hello (the stream-recovery path)
  const stream2 = await fetch(`${base}/api/chats/${chatId}/events`)
  const frames2 = await collectFrames(stream2, (f) => f.kind === 'question_asked' && f.questionId === 'q-keep')
  assert.ok(frames2.some((f) => f.kind === 'question_asked' && f.questionId === 'q-keep'), 'an SSE reconnect must replay the pending card')
})

test('debt card chain: after a manager restart a GET recovers the pending card through pendingAsks (replayed and answerable)', async () => {
  const question = { kind: 'question_asked', seq: 0, questionId: 'q-restart', questions: [{ id: 'a', question: 'a question from before the restart' }] } as const
  let calls = 0
  const upstream = new FakeSessionDriver('A', {
    frames: [
      { kind: 'turn_start', seq: 0, turn: 1 },
      turnEnd(),
    ],
    pendingAsks: () => {
      calls += 1
      // The turn start queries once (empty) -- simulating "the broadcast happened before the manager restarted, so all in-memory state is gone afterwards"
      return calls === 1 ? [] : [question]
    },
  })
  const { base } = await boot(upstream)
  const chatId = await newChat(base)
  const sent = await sendMessage(base, chatId, 'hi')
  assert.equal(sent.status, 202)

  // Poll GET until the recovered card shows up (the turn start and the recovery query are asynchronous, and a
  // fixed sleep is flaky when the whole suite runs in parallel; at most 2s, and converging at any point passes).
  let body: { liveFrames?: Array<{ kind: string; questionId?: string }> } = {}
  for (let i = 0; i < 40; i += 1) {
    const reloaded = await fetch(`${base}/api/chats/${chatId}`)
    assert.equal(reloaded.status, 200)
    body = (await reloaded.json()) as { liveFrames?: Array<{ kind: string; questionId?: string }> }
    if ((body.liveFrames ?? []).some((f) => f.kind === 'question_asked')) break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  const kept = body.liveFrames?.filter((f) => f.kind === 'question_asked') ?? []
  assert.equal(kept.length, 1, 'after a restart a GET must replay the pending card through the recovery channel')
  assert.equal(kept[0]?.questionId, 'q-restart')
})

test('debt card chain: a successful answer synthesises question_resolved -- without relying on an upstream broadcast, the card closes and the replay empties', async () => {
  const upstream = new ManualFake({ frames: [] })
  const { base, db } = await boot(upstream)
  const chatId = await newChat(base)
  const stream = await fetch(`${base}/api/chats/${chatId}/events`)
  const question = collectFrames(stream, (f) => f.kind === 'question_asked')
  await sendMessage(base, chatId, 'ask me something')
  await awaitTurn(upstream)
  // The upstream deliberately never sends a resolved frame (simulating a runner
  // that is already dead or a disconnect window).
  upstream.pump('fake-1', questionFrame('q-ans'))
  await question

  // A second SSE connection waits for resolved (only one reader can lock the stream of a given Response)
  const stream2 = await fetch(`${base}/api/chats/${chatId}/events`)
  const resolved = collectFrames(stream2, (f) => f.kind === 'question_resolved')
  const answer = await postJson(`${base}/api/chats/${chatId}/questions/q-ans`, { answers: [{ id: 'choice', selected: ['Continue'] }] })
  assert.equal(answer.status, 200)
  const frames = await resolved
  assert.ok(frames.some((f) => f.kind === 'question_resolved' && f.questionId === 'q-ans'), 'a resolved frame must be synthesised after the answer')

  const reloaded = await fetch(`${base}/api/chats/${chatId}`)
  const body = (await reloaded.json()) as { liveFrames?: Array<{ kind: string }> }
  assert.ok(!(body.liveFrames ?? []).some((f) => f.kind === 'question_asked'), 'the pending card must be removed from the replay after the answer')

  await finishTurn(db, upstream, chatId)
})

test('stopping a question-waiting turn finishes the local run even when its stream stays open', async () => {
  const upstream = new ManualFake({ frames: [] })
  const { base, db } = await boot(upstream)
  const chatId = await newChat(base)
  const stream = await fetch(`${base}/api/chats/${chatId}/events`)
  const question = collectFrames(stream, (frame) => frame.kind === 'question_asked')

  const sent = await sendMessage(base, chatId, 'ask me something')
  assert.equal(sent.status, 202)
  await awaitTurn(upstream)
  upstream.pump('fake-1', questionFrame('q-stop'))
  await question

  const stopped = await fetch(`${base}/api/chats/${chatId}/cancel`, { method: 'POST' })
  assert.equal(stopped.status, 202)
  await eventually(() => runStates(db, chatId)[0] === 'failed', 'the stopped run to be marked failed')
  assert.equal(upstream.cancels, 1, 'the stop is handed to the upstream through the port')
})

test('a browser that walks away frees its connection', async () => {
  // The failure this guards against does not look like a bug in the relay: a
  // subscriber that is never dropped keeps one of the six connections HTTP/1.1
  // gives an origin, and six of those make every later request -- including the
  // next page's HTML -- hang with nothing in the log to explain it.
  const { base } = await boot()
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
// turn queueing (the dock)
// ---------------------------------------------------------------------------

test('a second message during a running turn is docked and runs after it', async () => {
  const upstream = new ManualFake({ frames: [] })
  const { base, db } = await boot(upstream)
  const chatId = await newChat(base)
  const stream = await fetch(`${base}/api/chats/${chatId}/events`)
  const queued = collectFrames(stream, (f) => f.kind === 'turn_queued')

  const first = await sendMessage(base, chatId, 'first')
  assert.equal(first.status, 202)
  assert.equal(((await first.json()) as { accepted?: boolean }).accepted, true)

  await eventually(() => upstream.prompts.length === 1, 'the first turn to prompt')

  const second = await sendMessage(base, chatId, 'second')
  assert.equal(second.status, 202)
  const secondBody = (await second.json()) as { queued?: boolean; position?: number }
  assert.equal(secondBody.queued, true)
  assert.equal(secondBody.position, 1)

  const frames = await queued
  const docked = frames.find((f) => f.kind === 'turn_queued')
  assert.equal(docked?.text, 'second')
  const dockedId = docked?.id
  assert.ok(typeof dockedId === 'string' && dockedId !== '', 'the dock entry carries its id for cancel/edit')

  // The first turn ends -> the dock drains and the queued turn runs on the same session.
  upstream.pump('fake-1', turnEnd(1))
  await eventually(() => upstream.prompts.length === 2, 'the queued turn to run')
  assert.deepEqual(upstream.prompts, ['first', 'second'], 'the dock is FIFO')
  upstream.pump('fake-1', turnEnd(2))
  await eventually(
    () => runStates(db, chatId).length === 2 && runStates(db, chatId).every((state) => state === 'done'),
    'both turns to finish',
  )
})

test('a queued turn can be dropped from the dock before it runs', async () => {
  const upstream = new ManualFake({ frames: [] })
  const { base, db } = await boot(upstream)
  const chatId = await newChat(base)
  const stream = await fetch(`${base}/api/chats/${chatId}/events`)
  const queued = collectFrames(stream, (f) => f.kind === 'turn_queued')

  const first = await sendMessage(base, chatId, 'first')
  assert.equal(first.status, 202)
  await eventually(() => upstream.prompts.length === 1, 'the first turn to prompt')

  const second = await sendMessage(base, chatId, 'second')
  assert.equal(second.status, 202)
  const frames = await queued
  const dockedId = frames.find((f) => f.kind === 'turn_queued')?.id
  assert.ok(typeof dockedId === 'string' && dockedId !== '')

  const cancelled = await fetch(`${base}/api/chats/${chatId}/queued/${dockedId}/cancel`, { method: 'POST' })
  assert.equal(cancelled.status, 200)
  assert.deepEqual(await cancelled.json(), { ok: true })
  // Idempotent for the optimistic UI: an unknown (or already-run) id also answers ok.
  const bogus = await fetch(`${base}/api/chats/${chatId}/queued/not-a-turn/cancel`, { method: 'POST' })
  assert.equal(bogus.status, 200)

  upstream.pump('fake-1', turnEnd())
  await eventually(() => runStates(db, chatId).every((state) => state !== 'running'), 'the running turn to finish')
  // A beat for the drain to prove it fires nothing: the queue entry was dropped.
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.deepEqual(upstream.prompts, ['first'], 'the dropped dock entry never fired')
  assert.equal(runStates(db, chatId).length, 1, 'only the first turn was ever recorded')
})

// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------

test('cancel with no running turn goes through to the upstream; no session is a 409', async () => {
  const upstream = new FakeSessionDriver('A', { frames: [] })
  const { base, db } = await boot(upstream)
  const chatId = await newChat(base)

  const noSession = await fetch(`${base}/api/chats/${chatId}/cancel`, { method: 'POST' })
  assert.equal(noSession.status, 409)
  assert.deepEqual(await noSession.json(), { error: 'no_session' })

  bindSession(db, chatId, 'fake-1')
  const stopped = await fetch(`${base}/api/chats/${chatId}/cancel`, { method: 'POST' })
  assert.equal(stopped.status, 200)
  assert.deepEqual(await stopped.json(), { ok: true })
  assert.equal(upstream.cancels, 1, 'the cancel is handed to the upstream through the port')
})

// ---------------------------------------------------------------------------
// answering what the agent is blocked on (validation + pass-through)
// ---------------------------------------------------------------------------

/** Flippable failure: answer/decline/decide throw like a host rejecting the reply. */
class FlakyFake extends FakeSessionDriver {
  failReplies = false
  override async answerQuestion(rpcId: string, sessionId: string, answer: unknown) {
    if (this.failReplies) throw new Error('host rejected the answer')
    return super.answerQuestion(rpcId, sessionId, answer)
  }
  override async declineQuestion(rpcId: string, sessionId: string) {
    if (this.failReplies) throw new Error('host rejected the decline')
    return super.declineQuestion(rpcId, sessionId)
  }
  override async decideApproval(rpcId: string, sessionId: string, approvalId: string, outcome: 'allowed-once' | 'rejected') {
    if (this.failReplies) throw new Error('host rejected the decision')
    return super.decideApproval(rpcId, sessionId, approvalId, outcome)
  }
}

test('question replies: validation is local, everything else is a pass-through to the port', async () => {
  const upstream = new FlakyFake('A', { frames: [] })
  const { base, db } = await boot(upstream)
  const chatId = await newChat(base)
  const url = `${base}/api/chats/${chatId}/questions/q-1`

  // Without a bound session there is nothing to answer on.
  const noSession = await postJson(url, { answers: [] })
  assert.equal(noSession.status, 409)
  assert.deepEqual(await noSession.json(), { error: 'no_session' })

  bindSession(db, chatId, 'fake-1')

  const empty = await postJson(url, {})
  assert.equal(empty.status, 400)
  assert.deepEqual(await empty.json(), { error: 'answers_required' })

  const declined = await postJson(url, { decline: true })
  assert.equal(declined.status, 200)
  assert.deepEqual(await declined.json(), { ok: true, outcome: 'cancelled' })
  assert.deepEqual(upstream.declined, [{ rpcId: 'q-1', sessionId: 'fake-1' }], 'the questionId is the rpc id of the port')

  const answered = await postJson(url, { answers: [{ id: 'choice', selected: ['Continue'] }] })
  assert.equal(answered.status, 200)
  assert.deepEqual(await answered.json(), { ok: true, outcome: 'answered' })
  assert.deepEqual(upstream.answered, [{ rpcId: 'q-1', sessionId: 'fake-1', answer: { answers: [{ id: 'choice', selected: ['Continue'] }] } }])

  // A host-side failure is a 502 with the host's own detail passed through.
  upstream.failReplies = true
  const failedAnswer = await postJson(url, { answers: [] })
  assert.equal(failedAnswer.status, 502)
  assert.deepEqual(await failedAnswer.json(), { error: 'answer_failed', detail: 'host rejected the answer' })
  const failedDecline = await postJson(url, { decline: true })
  assert.equal(failedDecline.status, 502)
  assert.deepEqual(await failedDecline.json(), { error: 'answer_failed', detail: 'host rejected the decline' })
})

test('approval decisions: outcome and approvalId are validated locally, then the port decides', async () => {
  const upstream = new FlakyFake('A', { frames: [] })
  const { base, db } = await boot(upstream)
  const chatId = await newChat(base)
  const url = `${base}/api/chats/${chatId}/approvals/d-1`

  const noSession = await postJson(url, { outcome: 'allowed-once', approvalId: 'ap-1' })
  assert.equal(noSession.status, 409)
  assert.deepEqual(await noSession.json(), { error: 'no_session' })

  bindSession(db, chatId, 'fake-1')

  const badOutcome = await postJson(url, { outcome: 'maybe' })
  assert.equal(badOutcome.status, 400)
  assert.deepEqual(await badOutcome.json(), { error: 'invalid_outcome' })

  const noId = await postJson(url, { outcome: 'allowed-once' })
  assert.equal(noId.status, 400)
  assert.deepEqual(await noId.json(), { error: 'approval_id_required' })

  const blankId = await postJson(url, { outcome: 'rejected', approvalId: '' })
  assert.equal(blankId.status, 400)
  assert.deepEqual(await blankId.json(), { error: 'approval_id_required' })

  const allowed = await postJson(url, { outcome: 'allowed-once', approvalId: 'ap-1' })
  assert.equal(allowed.status, 200)
  assert.deepEqual(await allowed.json(), { ok: true, outcome: 'allowed-once' })
  const rejected = await postJson(url, { outcome: 'rejected', approvalId: 'ap-2' })
  assert.equal(rejected.status, 200)
  assert.deepEqual(upstream.decided, [
    { rpcId: 'd-1', sessionId: 'fake-1', approvalId: 'ap-1', outcome: 'allowed-once' },
    { rpcId: 'd-1', sessionId: 'fake-1', approvalId: 'ap-2', outcome: 'rejected' },
  ], 'the decisionId is the rpc id of the port')

  upstream.failReplies = true
  const failed = await postJson(url, { outcome: 'rejected', approvalId: 'ap-3' })
  assert.equal(failed.status, 502)
  assert.deepEqual(await failed.json(), { error: 'decide_failed', detail: 'host rejected the decision' })
})

// ---------------------------------------------------------------------------
// capability gaps: a plug without the optional port members
// ---------------------------------------------------------------------------

/** A driver with none of the optional capabilities: the routes must answer 501, not crash. */
const minimumDriver = (driver: SessionDriver): SessionDriver => ({
  id: driver.id,
  createSession: (cwd, preset) => driver.createSession(cwd, preset),
  prompt: (sessionId, text) => driver.prompt(sessionId, text),
  subscribe: (sessionId, listener) => driver.subscribe(sessionId, listener),
  history: (sessionId) => driver.history(sessionId),
  cancel: (sessionId) => driver.cancel(sessionId),
  answerQuestion: (rpcId, sessionId, answer) => driver.answerQuestion(rpcId, sessionId, answer),
  declineQuestion: (rpcId, sessionId) => driver.declineQuestion(rpcId, sessionId),
  decideApproval: (rpcId, sessionId, approvalId, outcome) => driver.decideApproval(rpcId, sessionId, approvalId, outcome),
  release: (sessionId) => driver.release(sessionId),
  probeVersion: () => driver.probeVersion(),
})

test('model and sandbox endpoints answer 501 when the driver lacks those capabilities', async () => {
  const { base, db } = await boot(minimumDriver(new FakeSessionDriver('A', { frames: [] })))
  const chatId = await newChat(base)

  // Before a session exists the 409 comes first.
  const tooEarly = await fetch(`${base}/api/chats/${chatId}/models`)
  assert.equal(tooEarly.status, 409)
  assert.deepEqual(await tooEarly.json(), { error: 'no_session' })

  bindSession(db, chatId, 'fake-1')

  const catalog = await fetch(`${base}/api/chats/${chatId}/models`)
  assert.equal(catalog.status, 501)
  assert.deepEqual(await catalog.json(), { error: 'model_selection_unsupported' })

  const select = await postJson(`${base}/api/chats/${chatId}/model`, { provider: 'deepseek', model: 'chat' })
  assert.equal(select.status, 501)
  assert.deepEqual(await select.json(), { error: 'model_selection_unsupported' })

  const sandbox = await postJson(`${base}/api/chats/${chatId}/sandbox-mode`, { mode: 'read-only' })
  assert.equal(sandbox.status, 501)
  assert.deepEqual(await sandbox.json(), { error: 'access_mode_unsupported' })

  // The composer capabilities report the same truth.
  const state = (await (await fetch(`${base}/api/chats/${chatId}`)).json()) as {
    composer?: { capabilities?: { modelSelection: boolean; accessMode: boolean; fullAccess: boolean; fullAccessForm: string } }
  }
  assert.deepEqual(state.composer?.capabilities, { modelSelection: false, accessMode: false, fullAccess: false, fullAccessForm: 'bare-metal' })
})

// ---------------------------------------------------------------------------
// archive and restore
// ---------------------------------------------------------------------------

test('archiving hides a chat, listing it as archived, and restore brings it back', async () => {
  // Archiving is a soft delete, so the round trip has to actually close: a chat
  // that disappears from both lists is indistinguishable from a deleted one.
  const { base } = await boot()
  const chatId = await newChat(base)

  const archived = await fetch(`${base}/api/chats/${chatId}/remove`, { method: 'POST' })
  assert.equal(archived.status, 200)
  // The response shape is kept for API parity, but since the gateway retirement
  // there is never a slot to release -- both fields have exactly one honest value.
  const removed = (await archived.json()) as {
    ok: boolean
    removedFromManager: boolean
    dshSessionId: string | null
    slotReleased: boolean
    releaseFailure: string | null
    detail: string
  }
  assert.equal(removed.ok, true)
  assert.equal(removed.removedFromManager, true)
  assert.equal(removed.dshSessionId, null)
  assert.equal(removed.slotReleased, false, 'no slot is released any more; the field survives for API parity')
  assert.equal(removed.releaseFailure, null)
  assert.match(removed.detail, /archived/)

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
  const { base } = await boot()
  const response = await fetch(`${base}/api/chats/archived`)
  assert.equal(response.status, 200)
  assert.ok(Array.isArray(((await response.json()) as { chats: unknown[] }).chats))
})

test('restoring a chat that was never archived is not an error', async () => {
  // Two tabs, one archive: the second restore must not report a failure for a
  // state that already matches what was asked for.
  const { base } = await boot()
  const chatId = await newChat(base)
  const response = await fetch(`${base}/api/chats/${chatId}/restore`, { method: 'POST' })
  assert.equal(response.status, 200)
})

test('the echo arrives before the upstream is even involved', async () => {
  // The point of publishing our own copy: a second tab should show the message
  // immediately, not sit blank until a session has been created on the host.
  // The ManualFake produces nothing by itself, so whatever arrives came from
  // the route's own echo.
  const upstream = new ManualFake({ frames: [] })
  const { base, db } = await boot(upstream)
  const chatId = await newChat(base)

  const stream = await fetch(`${base}/api/chats/${chatId}/events`)
  const collected = collectFrames(stream, (f) => f.kind === 'user')

  void sendMessage(base, chatId, 'are you there?')

  const frames = await collected
  const first = frames.find((f) => f.kind === 'user')
  assert.equal(first?.text, 'are you there?')
  assert.ok(typeof first?.at === 'number', "manager's own echo carries a timestamp")

  await finishTurn(db, upstream, chatId)
})

test('delegations: a chat lists the brain runs it dispatched (Hive P2)', async () => {
  const { base, db } = await boot()
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
      resultSummary: 'The weekly report was updated',
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
  assert.equal(body.delegations[0]?.summary, 'The weekly report was updated')

  const missing = await fetch(`${base}/api/chats/no-such-chat/delegations`)
  assert.equal(missing.status, 404)
})

test('vacate: an empty chat is hard-deleted; a chat with turns or a title refuses (Hive Q5)', async () => {
  const { base, db } = await boot()
  const now = Date.now()

  const insertChat = (id: string, title: string | null) => {
    db.insert(schema.chat)
      .values({ id, agentId: 'personal', title, createdAt: now, lastActiveAt: now, removedAt: null, dshSessionId: null })
      .run()
  }

  // An empty chat: delete it and the row disappears
  insertChat('empty-1', null)
  const vacated = await fetch(`${base}/api/chats/empty-1/vacate`, { method: 'POST' })
  assert.equal(vacated.status, 200)
  assert.deepEqual(await vacated.json(), { ok: true, vacated: true })
  assert.equal(db.select().from(schema.chat).where(eq(schema.chat.id, 'empty-1')).all().length, 0)

  // With turns: 409, the row stays
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

  // With a title: 409
  insertChat('titled-1', 'already titled by the host')
  const titled = await fetch(`${base}/api/chats/titled-1/vacate`, { method: 'POST' })
  assert.equal(titled.status, 409)

  // Unknown or archived: 404
  const missing = await fetch(`${base}/api/chats/no-such/vacate`, { method: 'POST' })
  assert.equal(missing.status, 404)
  insertChat('gone-1', null)
  db.update(schema.chat).set({ removedAt: now }).where(eq(schema.chat.id, 'gone-1')).run()
  const archived = await fetch(`${base}/api/chats/gone-1/vacate`, { method: 'POST' })
  assert.equal(archived.status, 404)
})
