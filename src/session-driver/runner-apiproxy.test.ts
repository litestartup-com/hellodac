/**
 * Plug-swap acceptance (Road work S2): FakeSessionDriver (pure in-memory, zero wire dependencies) drives the
 * runner's whole apiproxy chain -- proving the layer above depends only on the SessionDriver port:
 * with the third stand-in plugged in it just runs, and not one line of the layer above changes (TRANSLATOR-OPTIONS §5 acceptance criterion).
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { eq } from 'drizzle-orm'
import type { ResolvedAgent } from '../config.js'
import { schema, type Db } from '../db/index.js'
import { GatewayClient } from '../gateway/client.js'
import { runAgent } from '../runner.js'
import { FakeSessionDriver, type FakeScript } from './fake.js'
import type { MuxListener } from '../upstream/mux.js'
import type { GatewayFrame } from '../gateway/stream.js'
import { mintApiKey } from '../auth/api-key.js'
// Debt C3: makeDb/agentFor moved into the test harness (local aliases kept, behavior unchanged).
import { makeDb as makeHarnessDb, personalAgent } from '../test-harness.js'

const SUCCESS: FakeScript = {
  frames: [
    { kind: 'turn_start', seq: 0, turn: 1 },
    { kind: 'message', seq: 0, text: 'understood.', reasoning: null, usage: { inputTokens: 120, outputTokens: 8 } },
    { kind: 'turn_end', seq: 0, turn: 1, reason: 'completed', detail: null },
  ],
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
}

const makeDb = (): Db => makeHarnessDb().db

const agentFor = (workspacePath: string, sandboxMode: 'read-only' | 'workspace-write' | null = null): ResolvedAgent => ({
  ...personalAgent(workspacePath),
  sandboxMode,
})

/** The port does not involve a GatewayClient, but RunInput requires one (only the gateway branch uses it). */
const dummyClient = (): GatewayClient =>
  new GatewayClient({ id: 'A', url: 'http://127.0.0.1:1', driver: 'apiproxy', prefix: '/api', key: '', sandboxBase: null, sandboxKey: '', spawn: null, access: null })

/**
 * A pricing table holding only the model the host *confirmed*: the config pin (what the manager
 * asked for) is deliberately absent, so a turn priced from the requested name instead of the
 * confirmed one lands on null cost -- which is exactly the accounting hole under test.
 */
const CONFIRMED_MODEL_PRICING = {
  rates: { 'deepseek-v4-flash-exp': { offPeak: { input: 0.22, output: 0.66 } } },
  peakWindows: [],
}

/** The usage row this run wrote (the ledger line the whole model-resolution chain exists for). */
const usageRowOf = (db: Db, runId: string): { provider: string | null; model: string | null; cost: number | null } | undefined =>
  db.select().from(schema.usageRecord).where(eq(schema.usageRecord.runId, runId)).all()[0]

test('apiproxy turn: create -> sandbox -> prompt -> frames -> turn_end, all through the port', async () => {
  const db = makeDb()
  const fake = new FakeSessionDriver('A', SUCCESS)
  const workspace = mkdtempSync(join(tmpdir(), 'apiproxy-ws-'))
  const seen: string[] = []
  const timeline: string[] = []

  const outcome = await runAgent({ db }, {
    agent: agentFor(workspace, 'workspace-write'),
    client: dummyClient(),
    upstream: fake,
    driver: 'apiproxy',
    prompt: 'reply with just: understood',
    trigger: 'manual',
    onSession: (sessionId) => timeline.push(`session:${sessionId}`),
    onFrame: (frame) => {
      seen.push(frame.kind)
      timeline.push(`frame:${frame.kind}`)
    },
  })

  assert.equal(outcome.state, 'done')
  assert.equal(outcome.reason, 'completed')
  assert.match(outcome.sessionId ?? '', /^fake-\d+$/)
  assert.deepEqual(outcome.usage, { inputTokens: 120, outputTokens: 8 })
  assert.equal(outcome.model, 'deepseek-v4-flash')
  assert.equal(fake.created.length, 1)
  assert.equal(fake.created[0]?.cwd, workspace, 'cwd = the workspace (the write boundary)')
  assert.deepEqual(fake.sandboxPins, [{ sessionId: outcome.sessionId, mode: 'workspace-write' }], 'an optional port capability: pin the sandbox before the first prompt')
  assert.deepEqual(fake.prompts, ['reply with just: understood'])
  assert.deepEqual(seen, ['turn_start', 'message', 'turn_end'], 'live frames reach onFrame through the port')
  assert.deepEqual(timeline, ['session:fake-1', 'frame:turn_start', 'frame:message', 'frame:turn_end'])

  const run = db.select().from(schema.run).where(eq(schema.run.id, outcome.runId)).all()[0]
  assert.equal(run?.state, 'done')
  assert.equal(run?.dshSessionId, outcome.sessionId)
})

test('apiproxy turn: a prompt that was not accepted = failed, without waiting for frames', async () => {
  const db = makeDb()
  const fake = new FakeSessionDriver('A', { ...SUCCESS, promptAccepted: false })
  const outcome = await runAgent({ db }, {
    agent: agentFor(mkdtempSync(join(tmpdir(), 'apiproxy-ws-'))),
    client: dummyClient(), upstream: fake, driver: 'apiproxy', prompt: 'hi', trigger: 'manual',
  })
  assert.equal(outcome.state, 'failed')
  assert.match(outcome.error ?? '', /not accepted/)
})

test('apiproxy turn: createSession throwing = failed, carrying the upstream information', async () => {
  const db = makeDb()
  const fake = new FakeSessionDriver('A', { ...SUCCESS, createError: 'upstream 503' })
  const outcome = await runAgent({ db }, {
    agent: agentFor(mkdtempSync(join(tmpdir(), 'apiproxy-ws-'))),
    client: dummyClient(), upstream: fake, driver: 'apiproxy', prompt: 'hi', trigger: 'manual',
  })
  assert.equal(outcome.state, 'failed')
  assert.match(outcome.error ?? '', /upstream 503/)
})

test('apiproxy turn: turn_end with reason=error carries detail.message', async () => {
  const db = makeDb()
  const fake = new FakeSessionDriver('A', {
    frames: [{ kind: 'turn_end', seq: 0, turn: 1, reason: 'error', detail: { message: 'model exploded', cause: null } }],
  })
  const outcome = await runAgent({ db }, {
    agent: agentFor(mkdtempSync(join(tmpdir(), 'apiproxy-ws-'))),
    client: dummyClient(), upstream: fake, driver: 'apiproxy', prompt: 'hi', trigger: 'manual',
  })
  assert.equal(outcome.state, 'failed')
  assert.match(outcome.error ?? '', /model exploded/)
})

test('apiproxy turn: question/approval frames reach onFrame as usual and the turn still finishes', async () => {
  const db = makeDb()
  const fake = new FakeSessionDriver('A', {
    frames: [
      { kind: 'question_asked', seq: 0, questionId: 'q1', questions: [{ id: 'a', question: 'go?' }] },
      { kind: 'approval_pending', seq: 0, decisionId: 'd1', approvalId: 'ap1', toolName: 'shell', reason: 'writes' },
      { kind: 'turn_end', seq: 0, turn: 1, reason: 'completed', detail: null },
    ],
  })
  const seen: string[] = []
  const outcome = await runAgent({ db }, {
    agent: agentFor(mkdtempSync(join(tmpdir(), 'apiproxy-ws-'))),
    client: dummyClient(), upstream: fake, driver: 'apiproxy', prompt: 'hi', trigger: 'manual',
    onFrame: (frame) => seen.push(frame.kind),
  })
  assert.equal(outcome.state, 'done')
  assert.deepEqual(seen, ['question_asked', 'approval_pending', 'turn_end'])
})

test('apiproxy turn: an external stop ends a question-waiting run locally', async () => {
  const db = makeDb()
  const fake = new FakeSessionDriver('A', { frames: [] })
  const controller = new AbortController()
  const pending = runAgent({ db }, {
    agent: agentFor(mkdtempSync(join(tmpdir(), 'apiproxy-ws-'))),
    client: dummyClient(), upstream: fake, driver: 'apiproxy', prompt: 'hi', trigger: 'manual',
    signal: controller.signal, silenceMs: 0, timeoutMs: 10_000,
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  controller.abort()
  const outcome = await pending
  assert.equal(outcome.state, 'failed')
  assert.equal(outcome.error, 'the turn was stopped by the user')
  assert.equal(fake.cancels, 1)
})

test('apiproxy turn: a silence timeout = cancelled, with cancel called through the port', async () => {
  const db = makeDb()
  const fake = new FakeSessionDriver('A', { frames: [] })
  const outcome = await runAgent({ db }, {
    agent: agentFor(mkdtempSync(join(tmpdir(), 'apiproxy-ws-'))),
    client: dummyClient(), upstream: fake, driver: 'apiproxy', prompt: 'hi', trigger: 'manual',
    silenceMs: 60,
  })
  assert.equal(outcome.state, 'failed')
  assert.equal(fake.cancels, 1, 'the cancel goes out through the port')
})

test('Debt A4 regression: a stream reconnecting mid-turn -> fail loudly (outcome unknown), never wait silently for the timeout', async () => {
  const db = makeDb()
  const fake = new FakeSessionDriver('A', {
    frames: [
      { kind: 'turn_start', seq: 0, turn: 1 },
      { kind: 'stream_reconnected', seq: 0 },
      // The upstream actually finished, but turn_end was lost during the outage -- after the reconnect there is only
      // the notice frame and nothing else. The reconnect decision is asynchronous (it checks the recovery channel first), and with no pending ask and no one waiting for an answer -> fail loudly.
    ],
  })
  const outcome = await runAgent({ db }, {
    agent: agentFor(mkdtempSync(join(tmpdir(), 'apiproxy-ws-'))),
    client: dummyClient(), upstream: fake, driver: 'apiproxy', prompt: 'hi', trigger: 'manual',
    silenceMs: 0, timeoutMs: 5_000,
  })
  assert.equal(outcome.state, 'failed')
  assert.match(outcome.error ?? '', /reconnected|outcome unknown/, 'a reconnect must fail loudly, never wait silently for the timeout')
})

test('Debt card chain regression: a reconnect while someone is answering -> do not kill the turn; it finishes normally after the answer', async () => {
  const db = makeDb()
  const fake = new FakeSessionDriver('A', {
    frames: [
      { kind: 'question_asked', seq: 0, questionId: 'q1', questions: [{ id: 'a', question: 'go?' }] },
      // The card is open and the user is answering when the network hiccups -- the turn cannot have ended (the question is
      // still held by the host), and killing the turn here = the card vanishes + with the subscription gone nobody receives turn_end = "stuck".
      { kind: 'stream_reconnected', seq: 0 },
      { kind: 'question_resolved', seq: 0, questionId: 'q1', outcome: 'answered' },
      { kind: 'turn_end', seq: 0, turn: 1, reason: 'completed', detail: null },
    ],
  })
  const seen: string[] = []
  const outcome = await runAgent({ db }, {
    agent: agentFor(mkdtempSync(join(tmpdir(), 'apiproxy-ws-'))),
    client: dummyClient(), upstream: fake, driver: 'apiproxy', prompt: 'hi', trigger: 'manual',
    silenceMs: 0, timeoutMs: 5_000,
    onFrame: (frame) => seen.push(frame.kind),
  })
  assert.equal(outcome.state, 'done', 'a reconnect while someone is answering must not kill the turn')
  assert.deepEqual(seen, ['question_asked', 'stream_reconnected', 'question_resolved', 'turn_end'])
})

// ---------------------------------------------------------------------------
// Outward turns (2026-09-29, the ask_user_question hang): a public-API caller rides a
// synchronous HTTP request, and nobody sits at a screen on this side -- a pending question
// or approval must be declined after a short grace window, not waited out.
// ---------------------------------------------------------------------------

/**
 * A fake whose decline pumps follow-up frames, modelling what the real host does: the tool
 * returns "aborted before the user answered", the agent continues (usually re-asking in plain
 * text) and the turn ends. The subclass captures the runner's live listener to pump into it.
 */
/** run.api_key_id is a foreign key: an outward turn needs a real key row to hang its billing on. */
const outwardKey = (db: Db): string =>
  mintApiKey(db, {
    name: 'outward-test',
    scopes: ['conversations:write'],
    scopeServices: ['*'],
    quotaRunsDay: null,
    rateLimitRpm: 60,
    maxConcurrency: 4,
    expiresAt: null,
    createdBy: 'test',
  }).key.id

class DecliningFake extends FakeSessionDriver {
  private readonly live: MuxListener[] = []
  constructor(id: string, script: FakeScript, private readonly after: GatewayFrame[]) {
    super(id, script)
  }
  override subscribe(sessionId: string, listener: MuxListener): () => void {
    this.live.push(listener)
    return super.subscribe(sessionId, listener)
  }
  private pump(sessionId: string): void {
    for (const frame of this.after) for (const listener of this.live) listener(sessionId, frame)
  }
  override async declineQuestion(rpcId: string, sessionId: string) {
    const receipt = await super.declineQuestion(rpcId, sessionId)
    this.pump(sessionId)
    return receipt
  }
  override async decideApproval(rpcId: string, sessionId: string, approvalId: string, outcome: 'allowed-once' | 'rejected') {
    const receipt = await super.decideApproval(rpcId, sessionId, approvalId, outcome)
    this.pump(sessionId)
    return receipt
  }
}

test('outward turn: a pending question is auto-declined after the grace window and the turn completes with the agent re-asking in text', async () => {
  const db = makeDb()
  const fake = new DecliningFake(
    'A',
    { frames: [{ kind: 'question_asked', seq: 0, questionId: 'q1', questions: [{ id: 'a', question: 'what do you mean?' }] }] },
    [
      { kind: 'question_resolved', seq: 0, questionId: 'q1', outcome: 'cancelled' },
      { kind: 'message', seq: 0, text: 'Could you tell me what you need?', reasoning: null, usage: null },
      { kind: 'turn_end', seq: 0, turn: 1, reason: 'completed', detail: null },
    ],
  )
  const outcome = await runAgent({ db }, {
    agent: agentFor(mkdtempSync(join(tmpdir(), 'apiproxy-ws-'))),
    client: dummyClient(), upstream: fake, driver: 'apiproxy', prompt: 'follow-up', trigger: 'api',
    apiKeyId: outwardKey(db),
    outwardGraceMs: 20,
    silenceMs: 0, timeoutMs: 5_000,
  })
  assert.equal(outcome.state, 'done', 'the turn ends once the agent continues after the decline')
  assert.match(outcome.summary, /Could you tell me what you need/, 'the reply text carries the question the customer CAN answer')
  assert.deepEqual(fake.declined, [{ rpcId: 'q1', sessionId: outcome.sessionId }], 'the decline went out through the port')
})

test('outward turn: a pending approval is auto-rejected after the grace window', async () => {
  const db = makeDb()
  const fake = new DecliningFake(
    'A',
    { frames: [{ kind: 'approval_pending', seq: 0, decisionId: 'd1', approvalId: 'ap1', toolName: 'write', reason: 'writes a file' }] },
    [
      { kind: 'approval_resolved', seq: 0, decisionId: 'd1', approvalId: 'ap1', outcome: 'rejected' },
      { kind: 'message', seq: 0, text: 'I cannot write files in this service.', reasoning: null, usage: null },
      { kind: 'turn_end', seq: 0, turn: 1, reason: 'completed', detail: null },
    ],
  )
  const outcome = await runAgent({ db }, {
    agent: agentFor(mkdtempSync(join(tmpdir(), 'apiproxy-ws-'))),
    client: dummyClient(), upstream: fake, driver: 'apiproxy', prompt: 'write something', trigger: 'api',
    apiKeyId: outwardKey(db),
    outwardGraceMs: 20,
    silenceMs: 0, timeoutMs: 5_000,
  })
  assert.equal(outcome.state, 'done')
  assert.deepEqual(fake.decided, [{ rpcId: 'd1', sessionId: outcome.sessionId, approvalId: 'ap1', outcome: 'rejected' }], 'the approval was rejected through the port')
})

test('inward turn: questions are left to the humans at the screen even with a tiny grace window configured', async () => {
  const db = makeDb()
  const fake = new FakeSessionDriver('A', {
    frames: [
      { kind: 'question_asked', seq: 0, questionId: 'q1', questions: [{ id: 'a', question: 'go?' }] },
      { kind: 'question_resolved', seq: 0, questionId: 'q1', outcome: 'answered' },
      { kind: 'turn_end', seq: 0, turn: 1, reason: 'completed', detail: null },
    ],
  })
  const outcome = await runAgent({ db }, {
    agent: agentFor(mkdtempSync(join(tmpdir(), 'apiproxy-ws-'))),
    client: dummyClient(), upstream: fake, driver: 'apiproxy', prompt: 'hi', trigger: 'manual',
    outwardGraceMs: 5, // ignored without an apiKeyId
    silenceMs: 0, timeoutMs: 5_000,
  })
  assert.equal(outcome.state, 'done')
  assert.deepEqual(fake.declined, [], 'an inward turn never auto-declines: an operator may be mid-answer')
})

test('Debt card chain: a question frame lost in the outage window is recovered through pendingAsks -- the card is rebuilt and the turn is not killed', async () => {
  const db = makeDb()
  const question = { kind: 'question_asked', seq: 0, questionId: 'q-recovered', questions: [{ id: 'a', question: 'go?' }] } as const
  let calls = 0
  const fake = new FakeSessionDriver('A', {
    frames: [
      { kind: 'turn_start', seq: 0, turn: 1 },
      // The broadcast was lost in the outage window: the manager never received the question frame, so awaitingHuman=0.
      { kind: 'stream_reconnected', seq: 0 },
      { kind: 'turn_end', seq: 0, turn: 1, reason: 'completed', detail: null },
    ],
    pendingAsks: () => {
      calls += 1
      // One check at turn start (empty), a second after the reconnect -- the broadcast from the outage window is fetched back through the recovery channel.
      return calls === 1 ? [] : [question]
    },
  })
  const seen: string[] = []
  const outcome = await runAgent({ db }, {
    agent: agentFor(mkdtempSync(join(tmpdir(), 'apiproxy-ws-'))),
    client: dummyClient(), upstream: fake, driver: 'apiproxy', prompt: 'hi', trigger: 'manual',
    silenceMs: 0, timeoutMs: 5_000,
    onFrame: (frame) => seen.push(frame.kind),
  })
  await new Promise((resolve) => setTimeout(resolve, 20)) // let the recovery query's microtask chain run out
  assert.equal(outcome.state, 'done', 'after fetching the pending question back, the reconnect must not kill the turn')
  assert.ok(seen.includes('question_asked'), 'a recovered question frame must be forwarded to the frontend')
})

test('All nine port operations covered: history/answer/decline/decide/release/probe go through the record', async () => {
  const fake = new FakeSessionDriver('A', { frames: [], probeVersion: '0.1.1-rc.2' })
  const history = await fake.history('fake-9')
  assert.equal(history.sessionId, 'fake-9')
  assert.equal(history.sessionState, 'cold')
  assert.deepEqual(await fake.answerQuestion('r1', 's1', { answers: [] }), { accepted: true })
  assert.deepEqual(fake.answered, [{ rpcId: 'r1', sessionId: 's1', answer: { answers: [] } }])
  assert.deepEqual(await fake.declineQuestion('r2', 's1'), { accepted: true })
  assert.deepEqual(await fake.decideApproval('r3', 's1', 'ap1', 'rejected'), { accepted: true })
  assert.equal(fake.decided[0]?.outcome, 'rejected')
  await fake.release('fake-9')
  assert.deepEqual(fake.released, ['fake-9'])
  assert.equal(await fake.probeVersion(), '0.1.1-rc.2')
  const down = new FakeSessionDriver('B', { frames: [], probeVersion: null })
  await assert.rejects(() => down.probeVersion(), /unreachable/, 'a failed liveness probe must throw (the layer above catches it as unreachable)')
})

test('A port subscription can be cancelled: no more frames arrive after unsubscribe', async () => {
  const fake = new FakeSessionDriver('A', { frames: [{ kind: 'turn_end', seq: 0, turn: 1, reason: 'completed', detail: null }] })
  const seen: string[] = []
  const unsub = fake.subscribe('s1', (_sid, frame) => seen.push(frame.kind))
  unsub()
  await fake.prompt('s1', 'hi')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(seen, [], 'zero deliveries after unsubscribe')
})

test('Debt R8: a rejected prompt = the subscription must be cleaned up (no leftover mux subscription)', async () => {
  const db = makeDb()
  const fake = new FakeSessionDriver('A', { ...SUCCESS, promptAccepted: false })
  const outcome = await runAgent({ db }, {
    agent: agentFor(mkdtempSync(join(tmpdir(), 'apiproxy-ws-'))),
    client: dummyClient(), upstream: fake, driver: 'apiproxy', prompt: 'hi', trigger: 'manual',
  })
  assert.equal(outcome.state, 'failed')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(fake.activeSubscriberCount(outcome.sessionId ?? ''), 0, 'the prompt-rejected path must unsubscribe')
})

test('Debt R8: a prompt that throws = the subscription must be cleaned up', async () => {
  const db = makeDb()
  const fake = new FakeSessionDriver('A', { ...SUCCESS, promptError: 'upstream 500' })
  const outcome = await runAgent({ db }, {
    agent: agentFor(mkdtempSync(join(tmpdir(), 'apiproxy-ws-'))),
    client: dummyClient(), upstream: fake, driver: 'apiproxy', prompt: 'hi', trigger: 'manual',
  })
  assert.equal(outcome.state, 'failed')
  assert.match(outcome.error ?? '', /upstream 500/)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(fake.activeSubscriberCount(outcome.sessionId ?? ''), 0, 'the prompt-throwing path must unsubscribe')
})

test('Debt R8: a silence timeout = the subscription must be cleaned up', async () => {
  const db = makeDb()
  const fake = new FakeSessionDriver('A', { frames: [] })
  const outcome = await runAgent({ db }, {
    agent: agentFor(mkdtempSync(join(tmpdir(), 'apiproxy-ws-'))),
    client: dummyClient(), upstream: fake, driver: 'apiproxy', prompt: 'hi', trigger: 'manual',
    silenceMs: 60,
  })
  assert.equal(outcome.state, 'failed')
  assert.equal(fake.cancels, 1, 'the cancel goes out through the port')
  assert.equal(fake.activeSubscriberCount(outcome.sessionId ?? ''), 0, 'the timeout path must unsubscribe')
})

// ---------------------------------------------------------------------------
// Outward accounting: the model the host actually runs has to be on the ledger
// ---------------------------------------------------------------------------

/**
 * Regression (outward turn cost uncomputable, 2026-09-28): session.create is called with cwd+preset
 * only -- the apiproxy path passes no provider/model and the create response carries none either, so
 * `usage_record.model` was empty and pricing answered null ("cost unknown"). Pinning `model:` in the
 * config alone would be worse, not better: the manager would bill the *pinned* name while the host
 * kept running its own default (the "confidently wrong" failure). The fix is pin + read back --
 * call session.selectModel and record what the **host** confirms.
 */
test('outward accounting: the agent pin is landed through selectModel and the turn is priced at the host-confirmed model', async () => {
  const db = makeDb()
  // The host confirms a dated snapshot of the pinned model -- every assertion below has to follow
  // the confirmed name, because that is the name the provider will bill.
  const fake = new FakeSessionDriver('A', {
    ...SUCCESS,
    provider: null,
    model: null,
    selectModelResult: { provider: 'deepseek-official', model: 'deepseek-v4-flash-exp' },
  })
  const outcome = await runAgent(
    { db, pricing: CONFIRMED_MODEL_PRICING },
    {
      agent: { ...agentFor(mkdtempSync(join(tmpdir(), 'apiproxy-ws-'))), provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      client: dummyClient(), upstream: fake, driver: 'apiproxy', prompt: 'hi', trigger: 'api',
    },
  )

  assert.equal(outcome.state, 'done')
  assert.deepEqual(
    fake.selectedModels,
    [{ sessionId: outcome.sessionId, provider: 'deepseek-official', model: 'deepseek-v4-flash' }],
    'the pin must be landed on the host session, not merely written into the manager config',
  )
  assert.equal(outcome.model, 'deepseek-v4-flash-exp', 'the outcome reports the host-confirmed model, never the requested one')
  const usage = usageRowOf(db, outcome.runId)
  assert.equal(usage?.model, 'deepseek-v4-flash-exp', 'usage_record.model must carry the host-confirmed model')
  assert.equal(usage?.provider, 'deepseek-official')
  // 120 in * 0.22 + 8 out * 0.66 per million = 31.68 micro-USD, rounded.
  assert.equal(usage?.cost, 32, 'the rate for the confirmed model was found, so the turn is not a cost gap')
  assert.equal(outcome.costMicroUsd, 32)
})

test('outward accounting: a continued turn re-lands the pin, so the ledger keeps the host-confirmed model', async () => {
  const db = makeDb()
  const fake = new FakeSessionDriver('A', {
    ...SUCCESS,
    provider: null,
    model: null,
    selectModelResult: { provider: 'deepseek-official', model: 'deepseek-v4-flash-exp' },
  })
  const outcome = await runAgent(
    { db, pricing: CONFIRMED_MODEL_PRICING },
    {
      agent: { ...agentFor(mkdtempSync(join(tmpdir(), 'apiproxy-ws-'))), provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      client: dummyClient(), upstream: fake, driver: 'apiproxy', prompt: 'again', trigger: 'api',
      sessionId: 'existing-session',
    },
  )

  assert.equal(outcome.state, 'done')
  assert.equal(outcome.sessionId, 'existing-session', 'a continued turn must not create a second session')
  assert.equal(fake.created.length, 0)
  assert.deepEqual(
    fake.selectedModels,
    [{ sessionId: 'existing-session', provider: 'deepseek-official', model: 'deepseek-v4-flash' }],
    'a continued turn must re-assert the pin: the session outlives a config change, and this is the only read-back on that path',
  )
  const usage = usageRowOf(db, outcome.runId)
  assert.equal(usage?.model, 'deepseek-v4-flash-exp')
  assert.equal(usage?.cost, 32)
})

test('outward accounting: a pin the host cannot route fails the turn loudly instead of running unpriced', async () => {
  const db = makeDb()
  const fake = new FakeSessionDriver('A', {
    ...SUCCESS,
    provider: null,
    model: null,
    selectModelError: 'session/model-unavailable: no route for deepseek-official/typo-model',
  })
  const outcome = await runAgent(
    { db, pricing: CONFIRMED_MODEL_PRICING },
    {
      agent: { ...agentFor(mkdtempSync(join(tmpdir(), 'apiproxy-ws-'))), provider: 'deepseek-official', model: 'typo-model' },
      client: dummyClient(), upstream: fake, driver: 'apiproxy', prompt: 'hi', trigger: 'api',
    },
  )

  assert.equal(outcome.state, 'failed', 'a turn that cannot be accounted for must not be reported as done')
  assert.match(outcome.error ?? '', /model-unavailable/)
  assert.deepEqual(fake.prompts, [], 'nothing is sent to the model before the pin is settled')
  assert.equal(usageRowOf(db, outcome.runId), undefined, 'no usage row: the turn never reached the model')
})

