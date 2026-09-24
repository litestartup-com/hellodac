import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { eq } from 'drizzle-orm'
import { schema, type Db } from '../db/index.js'
import { GatewayClient } from '../gateway/client.js'
import { startFakeGateway, type FakeGateway, type FakeScript } from '../gateway/fake.js'
import type { GatewayFrame } from '../gateway/stream.js'
import { runAgent } from '../runner.js'
import { bindSession, chatRuns, createChat, deriveTitle, getChat, listChats, removeChat, setTitleIfEmpty } from './store.js'
// 债务 C3:makeDb/agentFor 收敛进 test-harness(本地保留别名,行为不变)。
import { makeDb as makeHarnessDb, personalAgent } from '../test-harness.js'

/**
 * Multi-turn conversations.
 *
 * The behaviour under test is mostly about *not* doing things: not creating a
 * second session, not re-billing replayed history, and not releasing the slot a
 * conversation is still using.
 *
 * Chat turns pass `keepSession: true` here because that is what routes/chat.ts
 * passes. Without it these tests would exercise a one-shot turn instead, and a
 * conversation would silently pay for a cold resume on every message.
 */

const API_KEY = 'test-key'

const makeDb = (): { db: Db; workspace: string } => {
  const { db, workspace } = makeHarnessDb()
  return { db, workspace }
}

const agentFor = personalAgent

const clientFor = (gw: FakeGateway): GatewayClient =>
  new GatewayClient({ id: 'A', url: gw.url, driver: 'gateway', prefix: gw.prefix, key: API_KEY, sandboxBase: null, sandboxKey: '', spawn: null, access: null })

const gateways: FakeGateway[] = []
const boot = async (script: FakeScript): Promise<FakeGateway> => {
  const gw = await startFakeGateway(script, API_KEY)
  gateways.push(gw)
  return gw
}
after(async () => {
  await Promise.all(gateways.map((g) => g.close()))
})

const turn = (text: string, inputTokens: number): FakeScript['frames'] => [
  { kind: 'message', text, reasoning: null, usage: { inputTokens, outputTokens: 10 } },
  { kind: 'turn_end', turn: 1, reason: 'completed', detail: null },
]

// ---------------------------------------------------------------------------
// titles
// ---------------------------------------------------------------------------

test('a title is a prefix of what the user actually said', () => {
  assert.equal(deriveTitle('把这周的开销汇总一下'), '把这周的开销汇总一下')
  // Whitespace collapses so a pasted multi-line prompt still yields one line.
  assert.equal(deriveTitle('第一行\n\n  第二行  '), '第一行 第二行')
  assert.equal(deriveTitle('   '), '新会话')
})

test('a long title is cut by grapheme, not by UTF-16 unit', () => {
  const long = '记'.repeat(200)
  const title = deriveTitle(long)
  // 60 graphemes plus the ellipsis, not 60 code units (which would be 30 CJK
  // characters) and never half of a surrogate pair.
  assert.equal([...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(title)].length, 61)
  assert.ok(title.endsWith('…'))

  const emoji = '👨‍👩‍👧‍👦'.repeat(80)
  assert.ok(!deriveTitle(emoji).includes('\uFFFD'), 'no broken surrogate')
})

test('the title is set once and later turns do not rewrite it', () => {
  const { db } = makeDb()
  const chat = createChat(db, 'personal')

  setTitleIfEmpty(db, chat.id, '第一句')
  setTitleIfEmpty(db, chat.id, '第二句')

  assert.equal(getChat(db, chat.id)?.title, '第一句')
})

// ---------------------------------------------------------------------------
// session reuse
// ---------------------------------------------------------------------------

test('a second turn continues the same session instead of creating one', async () => {
  const { db, workspace } = makeDb()
  const gw = await boot({ frames: turn('第一轮', 100) })
  const agent = agentFor(workspace)
  const chat = createChat(db, 'personal')

  const first = await runAgent(
    { db },
    { agent, client: clientFor(gw), prompt: '你好', trigger: 'manual', chatId: chat.id, sessionId: null, keepSession: true },
  )
  assert.equal(first.state, 'done')
  bindSession(db, chat.id, first.sessionId as string)

  const second = await runAgent(
    { db },
    {
      agent,
      client: clientFor(gw),
      prompt: '接着说',
      trigger: 'manual',
      chatId: chat.id,
      sessionId: getChat(db, chat.id)?.dshSessionId ?? null,
      keepSession: true,
    },
  )

  assert.equal(second.state, 'done')
  assert.equal(second.sessionId, first.sessionId, 'the conversation stayed in one session')

  // The decisive assertion: exactly one session was ever created. A second
  // POST /sessions would mean the model saw none of the first turn.
  const creates = gw.calls.filter((c) => c.path === '/sessions' && c.method === 'POST')
  assert.equal(creates.length, 1)

  // And it was never handed back mid-conversation, so neither turn had to be
  // resumed from cold.
  assert.deepEqual(gw.releases, [])
  assert.deepEqual(gw.adopts, [first.sessionId])

  // Both turns are recorded against the chat, so the ledger keeps its shape.
  const runs = chatRuns(db, chat.id)
  assert.equal(runs.length, 2)
  assert.deepEqual(
    runs.map((r) => r.dshSessionId),
    [first.sessionId, first.sessionId],
  )
})

test('continuing a session adopts it exactly once per turn', async () => {
  const { db, workspace } = makeDb()
  const gw = await boot({ frames: turn('ok', 50) })
  const agent = agentFor(workspace)

  await runAgent({ db }, { agent, client: clientFor(gw), prompt: 'a', trigger: 'manual', sessionId: null })
  await runAgent({ db }, { agent, client: clientFor(gw), prompt: 'b', trigger: 'manual', sessionId: 'sess-1' })

  assert.deepEqual(gw.adopts, ['sess-1'])
})

// ---------------------------------------------------------------------------
// cold sessions
// ---------------------------------------------------------------------------

test('a cold session is revived and the turn still runs', async () => {
  // The gateway holds sessions in memory, so a DSH restart makes `messages` and
  // `stream` answer 404. Adopt is the only way back.
  const { db, workspace } = makeDb()
  const gw = await boot({ frames: turn('回来了', 70), coldSessions: ['sess-9'] })

  const outcome = await runAgent(
    { db },
    { agent: agentFor(workspace), client: clientFor(gw), prompt: '继续', trigger: 'manual', sessionId: 'sess-9' },
  )

  assert.equal(outcome.state, 'done', outcome.error ?? '')
  assert.deepEqual(gw.adopts, ['sess-9'])
  // Adopt came before the stream was opened; a cold stream would have 404'd.
  const order = gw.calls.filter((c) => c.path.startsWith('/sessions/sess-9')).map((c) => c.path)
  assert.equal(order[0], '/sessions/sess-9/adopt')
})

test('when the gateway forbids adoption the chat is readable but says why', async () => {
  const { db, workspace } = makeDb()
  const gw = await boot({
    frames: turn('never', 10),
    coldSessions: ['sess-3'],
    adoptFail: { status: 403, error: 'adopt_disabled' },
  })

  const outcome = await runAgent(
    { db },
    { agent: agentFor(workspace), client: clientFor(gw), prompt: '继续', trigger: 'manual', sessionId: 'sess-3' },
  )

  assert.equal(outcome.state, 'failed')
  // The message must name the lever, not just report a 403.
  assert.match(outcome.error ?? '', /allowAdopt/)
  assert.match(outcome.error ?? '', /history is still readable/i)
  // Nothing was sent, so nothing was charged for.
  assert.equal(gw.messages.length, 0)
  assert.equal(outcome.usage, null)
})

test('a session the gateway has lost tells the user to start a new chat', async () => {
  const { db, workspace } = makeDb()
  const gw = await boot({
    frames: turn('never', 10),
    coldSessions: ['sess-4'],
    adoptFail: { status: 400, error: 'adopt_failed', detail: 'session_not_found' },
  })

  const outcome = await runAgent(
    { db },
    { agent: agentFor(workspace), client: clientFor(gw), prompt: '继续', trigger: 'manual', sessionId: 'sess-4' },
  )

  assert.equal(outcome.state, 'failed')
  assert.match(outcome.error ?? '', /no longer exists/)
  assert.match(outcome.error ?? '', /Start a new one/)
})

test('a full gateway is reported as a capacity problem, not a lost session', async () => {
  // These need opposite reactions -- wait versus give up on the thread -- and
  // both arrive as 400 adopt_failed.
  const { db, workspace } = makeDb()
  const gw = await boot({
    frames: turn('never', 10),
    coldSessions: ['sess-5'],
    adoptFail: { status: 400, error: 'adopt_failed', detail: 'session cap reached (8)' },
  })

  const outcome = await runAgent(
    { db },
    { agent: agentFor(workspace), client: clientFor(gw), prompt: '继续', trigger: 'manual', sessionId: 'sess-5' },
  )

  assert.equal(outcome.state, 'failed')
  assert.match(outcome.error ?? '', /maxSessions/)
  assert.doesNotMatch(outcome.error ?? '', /no longer exists/)
})

test('an adopted session in the wrong directory refuses to run', async () => {
  // A resumed session reports the cwd DSH rebuilt it with, which is not
  // guaranteed to be the one it was created with. Writing to the wrong
  // workspace is the worst outcome available, so the turn stops.
  const { db, workspace } = makeDb()
  const elsewhere = mkdtempSync(join(tmpdir(), 'other-ws-'))
  const gw = await boot({ frames: turn('x', 10), coldSessions: ['sess-6'], overrideCwd: elsewhere })

  const outcome = await runAgent(
    { db },
    { agent: agentFor(workspace), client: clientFor(gw), prompt: '继续', trigger: 'manual', sessionId: 'sess-6' },
  )

  assert.equal(outcome.state, 'failed')
  assert.match(outcome.error ?? '', /instead of/)
  assert.equal(gw.messages.length, 0, 'nothing was sent to a session pointing elsewhere')
})

// ---------------------------------------------------------------------------
// billing
// ---------------------------------------------------------------------------

test('replayed history is never billed again', async () => {
  // The gateway's hello frame replays the whole durable log. Counting it would
  // re-charge every previous turn on every turn, growing with the conversation.
  const { db, workspace } = makeDb()
  const gw = await boot({
    frames: turn('第二轮', 200),
    // The first turn's message, replayed as history on the second subscribe.
    history: [{ kind: 'message', text: '第一轮', usage: { inputTokens: 99_999, outputTokens: 99_999 } }],
  })

  const outcome = await runAgent(
    { db },
    { agent: agentFor(workspace), client: clientFor(gw), prompt: '接着说', trigger: 'manual', sessionId: 'sess-x' },
  )

  assert.equal(outcome.state, 'done')
  assert.deepEqual(outcome.usage, { inputTokens: 200, outputTokens: 10 })

  const usage = db.select().from(schema.usageRecord).where(eq(schema.usageRecord.runId, outcome.runId)).all()
  assert.equal(usage.length, 1)
  assert.equal(usage[0]?.inputTokens, 200, 'the replayed 99999 was not counted')
})

test('only live frames are relayed to browsers', async () => {
  const { db, workspace } = makeDb()
  const gw = await boot({
    frames: turn('实时', 30),
    history: [{ kind: 'message', text: '旧的', usage: { inputTokens: 5, outputTokens: 5 } }],
  })

  const relayed: GatewayFrame[] = []
  await runAgent(
    { db },
    {
      agent: agentFor(workspace),
      client: clientFor(gw),
      prompt: 'go',
      trigger: 'manual',
      sessionId: 'sess-y',
      onFrame: (frame) => relayed.push(frame),
    },
  )

  assert.ok(!relayed.some((f) => f.kind === 'hello'), 'hello is history, not a live frame')
  assert.ok(!relayed.some((f) => f.text === '旧的'), 'replayed messages were not re-emitted')
  assert.deepEqual(
    relayed.map((f) => f.kind),
    ['message', 'turn_end'],
  )
})

// ---------------------------------------------------------------------------
// thread bookkeeping
// ---------------------------------------------------------------------------

test('a new chat has no gateway session until something is sent', () => {
  // Creating one eagerly would spend a slot against the gateway's maxSessions
  // for a chat the user may never type into.
  const { db } = makeDb()
  const chat = createChat(db, 'personal')
  assert.equal(chat.dshSessionId, null)
  assert.equal(chat.title, null)
})

test('removing a chat hides it but keeps the turns and the session id', () => {
  const { db } = makeDb()
  const chat = createChat(db, 'personal')
  bindSession(db, chat.id, 'sess-keep')

  removeChat(db, chat.id)

  assert.equal(listChats(db, 'personal').length, 0, 'hidden from the sidebar')
  const row = getChat(db, chat.id)
  assert.notEqual(row?.removedAt, null)
  // The id is kept even though the route hands the slot back, because releasing
  // does not delete: the transcript is still on the gateway and still readable
  // through this id.
  assert.equal(row?.dshSessionId, 'sess-keep')
})

test('chats are listed most recently active first', () => {
  const { db } = makeDb()
  const older = createChat(db, 'personal', 1_000)
  const newer = createChat(db, 'personal', 2_000)

  assert.deepEqual(
    listChats(db, 'personal').map((c) => c.id),
    [newer.id, older.id],
  )
})

test('the turn count comes from the runs actually recorded', async () => {
  const { db, workspace } = makeDb()
  const gw = await boot({ frames: turn('ok', 10) })
  const chat = createChat(db, 'personal')

  assert.equal(listChats(db, 'personal')[0]?.turns, 0)

  await runAgent(
    { db },
    {
      agent: agentFor(workspace),
      client: clientFor(gw),
      prompt: 'a',
      trigger: 'manual',
      chatId: chat.id,
      sessionId: null,
      keepSession: true,
    },
  )

  assert.equal(listChats(db, 'personal')[0]?.turns, 1)
})
