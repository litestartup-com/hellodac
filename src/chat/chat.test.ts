import assert from 'node:assert/strict'
import { test } from 'node:test'
import { eq } from 'drizzle-orm'
import { schema, type Db } from '../db/index.js'
import { FakeSessionDriver, type FakeScript } from '../session-driver/fake.js'
import type { GatewayFrame } from '../frames.js'
import { runAgent } from '../runner.js'
import { bindSession, chatRuns, createChat, deriveTitle, getChat, listChats, removeChat, setTitleIfEmpty } from './store.js'
// Debt C3: makeDb/agentFor moved into the test harness (local aliases kept, behavior unchanged).
import { makeDb as makeHarnessDb, personalAgent } from '../test-harness.js'

/**
 * Multi-turn conversations.
 *
 * The behaviour under test is mostly about *not* doing things: not creating a
 * second session for a conversation that already has one, and not re-creating
 * a cold one -- since the gateway retirement there is exactly one upstream
 * path (the SessionDriver port), and the host's prompt is the universal entry
 * that also wakes a cold session. There is no adopt/resume wire step left to
 * observe, so the assertions run against the port's own recordings
 * (created/prompts/released) via the scripted in-memory fake.
 */

const makeDb = (): { db: Db; workspace: string } => {
  const { db, workspace } = makeHarnessDb()
  return { db, workspace }
}

const agentFor = personalAgent

/** One successful turn's frames: a single priced message, then the turn_end the runner finishes on. */
const turn = (text: string, inputTokens: number): FakeScript['frames'] => [
  { kind: 'message', seq: 0, text, reasoning: null, usage: { inputTokens, outputTokens: 10 } },
  { kind: 'turn_end', seq: 0, turn: 1, reason: 'completed', detail: null },
]

// ---------------------------------------------------------------------------
// titles
// ---------------------------------------------------------------------------

test('a title is a prefix of what the user actually said', () => {
  assert.equal(deriveTitle('sum up the spending for this week'), 'sum up the spending for this week')
  // Whitespace collapses so a pasted multi-line prompt still yields one line.
  assert.equal(deriveTitle('first line\n\n  second line  '), 'first line second line')
  // An empty prompt falls back to the store's placeholder title.
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

  setTitleIfEmpty(db, chat.id, 'first line')
  setTitleIfEmpty(db, chat.id, 'second line')

  assert.equal(getChat(db, chat.id)?.title, 'first line')
})

// ---------------------------------------------------------------------------
// session reuse
// ---------------------------------------------------------------------------

test('a second turn continues the same session instead of creating one', async () => {
  const { db, workspace } = makeDb()
  const fake = new FakeSessionDriver('A', { frames: turn('first turn', 100) })
  const agent = agentFor(workspace)
  const chat = createChat(db, 'personal')

  const first = await runAgent(
    { db },
    { agent, upstream: fake, prompt: 'hello', trigger: 'manual', chatId: chat.id, sessionId: null },
  )
  assert.equal(first.state, 'done', first.error ?? '')
  const firstSession = first.sessionId
  assert.ok(firstSession !== null, 'the turn reports the session it created')
  bindSession(db, chat.id, firstSession)

  const second = await runAgent(
    { db },
    {
      agent,
      upstream: fake,
      prompt: 'go on',
      trigger: 'manual',
      chatId: chat.id,
      sessionId: getChat(db, chat.id)?.dshSessionId ?? null,
    },
  )

  assert.equal(second.state, 'done', second.error ?? '')
  assert.equal(second.sessionId, firstSession, 'the conversation stayed in one session')

  // The decisive assertion: exactly one session was ever created. A second
  // createSession would mean the model saw none of the first turn.
  assert.equal(fake.created.length, 1)
  assert.deepEqual(fake.prompts, ['hello', 'go on'])

  // And the conversation never handed its session back, so neither turn had to
  // be resumed from cold.
  assert.deepEqual(fake.released, [])

  // Both turns are recorded against the chat, so the ledger keeps its shape.
  const runs = chatRuns(db, chat.id)
  assert.equal(runs.length, 2)
  assert.deepEqual(
    runs.map((r) => r.dshSessionId),
    [firstSession, firstSession],
  )
})

// ---------------------------------------------------------------------------
// cold sessions
// ---------------------------------------------------------------------------

test('a cold session is revived by the prompt alone and the turn still runs', async () => {
  // apiproxy has no adopt/resume step: prompt is the universal entry, and a
  // session that went cold on the host is woken as a side effect of it. The
  // old gateway assertions about adopt order died with the gateway driver;
  // what survives is the guarantee that continuing never re-creates.
  const { db, workspace } = makeDb()
  const fake = new FakeSessionDriver('A', { frames: turn('back again', 70) })

  const outcome = await runAgent(
    { db },
    { agent: agentFor(workspace), upstream: fake, prompt: 'continue', trigger: 'manual', sessionId: 'sess-9' },
  )

  assert.equal(outcome.state, 'done', outcome.error ?? '')
  assert.equal(outcome.sessionId, 'sess-9')
  // Decisive: the continued session was never re-created -- a createSession
  // here would mean the model lost the whole earlier conversation.
  assert.deepEqual(fake.created, [])
  assert.deepEqual(fake.prompts, ['continue'])
})

// ---------------------------------------------------------------------------
// billing
// ---------------------------------------------------------------------------

test('the tokens of a turn land on its own run and nowhere else', async () => {
  const { db, workspace } = makeDb()
  const fake = new FakeSessionDriver('A', { frames: turn('second turn', 200) })

  const outcome = await runAgent(
    { db },
    { agent: agentFor(workspace), upstream: fake, prompt: 'go on', trigger: 'manual', sessionId: 'sess-x' },
  )

  assert.equal(outcome.state, 'done', outcome.error ?? '')
  assert.deepEqual(outcome.usage, { inputTokens: 200, outputTokens: 10 })

  const usage = db.select().from(schema.usageRecord).where(eq(schema.usageRecord.runId, outcome.runId)).all()
  assert.equal(usage.length, 1)
  assert.equal(usage[0]?.inputTokens, 200)
  assert.equal(usage[0]?.outputTokens, 10)
})

test('the frames of a turn are relayed in emission order', async () => {
  const { db, workspace } = makeDb()
  const fake = new FakeSessionDriver('A', { frames: turn('live', 30) })

  const relayed: GatewayFrame[] = []
  await runAgent(
    { db },
    {
      agent: agentFor(workspace),
      upstream: fake,
      prompt: 'go',
      trigger: 'manual',
      sessionId: 'sess-y',
      onFrame: (frame) => relayed.push(frame),
    },
  )

  assert.deepEqual(
    relayed.map((f) => f.kind),
    ['message', 'turn_end'],
  )
  assert.equal(relayed[0]?.text, 'live')
})

// ---------------------------------------------------------------------------
// thread bookkeeping
// ---------------------------------------------------------------------------

test('a new chat has no host session until something is sent', () => {
  // Creating one eagerly would start a session on the host for a chat the user
  // may never type into.
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
  // The id is kept because archiving destroys nothing: the transcript is still
  // on the host and still readable through this id.
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
  const fake = new FakeSessionDriver('A', { frames: turn('ok', 10) })
  const chat = createChat(db, 'personal')

  assert.equal(listChats(db, 'personal')[0]?.turns, 0)

  await runAgent(
    { db },
    {
      agent: agentFor(workspace),
      upstream: fake,
      prompt: 'a',
      trigger: 'manual',
      chatId: chat.id,
      sessionId: null,
    },
  )

  assert.equal(listChats(db, 'personal')[0]?.turns, 1)
})
