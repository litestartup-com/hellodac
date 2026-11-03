/**
 * What `runAgent` owes, independent of which plug sits behind the SessionDriver port.
 *
 * The port's own wire acceptance -- create -> sandbox pin -> prompt -> frames -> turn_end, a rejected or
 * throwing prompt, createSession failures, turn_end reason=error, question/approval relay, reconnects, an
 * external stop, the silence cancel, unsubscribe hygiene and model pinning -- lives in
 * `src/session-driver/runner-apiproxy.test.ts` and is deliberately NOT repeated here.
 *
 * This file drives the same port through the in-memory fake and asserts the runner's own bookkeeping: the
 * run row and the usage ledger, pricing per response across a peak boundary, the honest gap of an unpriced
 * model, the two timeouts (total and silence) and what stands the silence backstop down, the active-run
 * registration, the git snapshot trio (before / after / conflict) under the commit lock, the idempotence of
 * `finish`, and summary truncation.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { eq } from 'drizzle-orm'
import { mintApiKey } from './auth/api-key.js'
import { openDb, schema, type Db } from './db/index.js'
import type { GatewayFrame } from './frames.js'
import { activeRunCount, runAgent, runningRunId } from './runner.js'
import { FakeSessionDriver, type FakeScript } from './session-driver/fake.js'
// Debt C3: tempDir/makeDb/personalAgent come from the shared harness (local aliases kept, behavior unchanged).
import { makeDb as makeHarnessDb, personalAgent, tempDir } from './test-harness.js'
import type { MuxListener } from './upstream/mux.js'
import type { RpcReceipt } from './upstream/respond.js'

const makeDb = (): Db => makeHarnessDb().db

const agentFor = personalAgent

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** The run row this run wrote (its terminal state is what a crashed manager is judged by). */
const runRowOf = (db: Db, runId: string) =>
  db.select().from(schema.run).where(eq(schema.run.id, runId)).all()[0]

/** The ledger lines this run wrote -- one per run, never one per response. */
const usageRowsOf = (db: Db, runId: string) =>
  db.select().from(schema.usageRecord).where(eq(schema.usageRecord.runId, runId)).all()

// ---------------------------------------------------------------------------
// git helpers
// ---------------------------------------------------------------------------

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

/** A workspace that is a real git repo, so snapshots can actually commit. */
const makeRepo = (): string => {
  const root = tempDir('ws-git')
  writeFileSync(join(root, 'RULE.md'), '# rules\n', 'utf8')
  git(root, 'init', '-q')
  git(root, 'config', 'user.email', 'test@local')
  git(root, 'config', 'user.name', 'test')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'initial')
  return root
}

const commitCount = (root: string): number => Number(git(root, 'rev-list', '--count', 'HEAD').trim())

const head = (root: string): string => git(root, 'rev-parse', 'HEAD').trim()

/** The files a commit touched, one per line, with git's own formatting noise stripped. */
const filesOf = (root: string, rev: string): string[] =>
  git(root, 'show', '--name-only', '--pretty=format:', rev)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')

/**
 * Simulates the agent writing a file partway through the turn.
 *
 * `onFrame` fires inside the frame handler, so a write from here lands while the turn is still open -- which
 * is exactly when the agent's own tools would write, and the manager never sees those calls.
 */
const writesFileOnFrame = (root: string, relPath: string, contents: string): ((frame: GatewayFrame) => void) => {
  let done = false
  return () => {
    if (done) return
    done = true
    writeFileSync(join(root, relPath), contents, 'utf8')
  }
}

// ---------------------------------------------------------------------------
// drivers: a scheduled fake, and one whose auto-decline fails
// ---------------------------------------------------------------------------

/** One scripted frame plus how long the host takes to produce it. */
interface ScheduledFrame {
  /** Delay before this frame is delivered, measured from the previous one. */
  afterMs: number
  frame: GatewayFrame
}

/**
 * A FakeSessionDriver whose frames arrive over time instead of in one microtask burst.
 *
 * The base fake pumps everything as fast as the event loop allows, which cannot express the two things the
 * silence backstop is actually about: a turn that keeps talking (every frame pushes the timer forward) and a
 * turn that goes quiet while a human is being asked (the timer stands down). The listener set is private to
 * the base class, so the live listeners are captured by overriding `subscribe` -- the same trick
 * runner-apiproxy.test.ts uses -- and keyed by session, so two runs sharing one driver never cross-talk.
 */
class ScheduledFake extends FakeSessionDriver {
  private readonly live = new Map<string, MuxListener[]>()
  constructor(id: string, private readonly schedule: ScheduledFrame[]) {
    super(id, { frames: [] })
  }
  override subscribe(sessionId: string, listener: MuxListener): () => void {
    const listeners = this.live.get(sessionId) ?? []
    listeners.push(listener)
    this.live.set(sessionId, listeners)
    return super.subscribe(sessionId, listener)
  }
  override async prompt(sessionId: string, text: string): Promise<{ accepted: boolean }> {
    this.prompts.push(text)
    let elapsed = 0
    for (const step of this.schedule) {
      elapsed += step.afterMs
      setTimeout(() => {
        for (const listener of this.live.get(sessionId) ?? []) listener(sessionId, step.frame)
      }, elapsed)
    }
    return { accepted: true }
  }
}

/** A driver whose auto-decline fails, so the runner's warning path is what bounds the turn. */
class DeclineFailsFake extends FakeSessionDriver {
  declineCalls = 0
  override async declineQuestion(_rpcId: string, _sessionId: string): Promise<RpcReceipt> {
    this.declineCalls += 1
    throw new Error('respond 502: the facade is not listening')
  }
}

/** A normal successful turn: one tool call, one assistant message with usage, then turn_end. */
const SUCCESS: FakeScript = {
  provider: 'deepseek-official',
  model: 'deepseek-v4-pro',
  frames: [
    { kind: 'turn_start', seq: 0, turn: 1 },
    { kind: 'tool_call', seq: 0, name: 'write_file', arguments: '{"path":"log.md"}' },
    { kind: 'tool_result', seq: 0, isError: false, text: 'written' },
    { kind: 'message', seq: 0, text: 'Added a line to the work log.', reasoning: null, usage: { inputTokens: 1200, outputTokens: 80, cacheReadTokens: 400 } },
    { kind: 'turn_end', seq: 0, turn: 1, reason: 'completed', detail: null },
  ],
}

// ---------------------------------------------------------------------------
// accounting: the run row and the usage ledger
// ---------------------------------------------------------------------------

test('a successful run lands the turn on the run row and the tokens on the ledger', async () => {
  const db = makeDb()
  const fake = new FakeSessionDriver('A', SUCCESS)

  const outcome = await runAgent({ db }, {
    agent: agentFor(tempDir('ws')),
    upstream: fake,
    prompt: 'add a line with the current date to the work log',
    trigger: 'manual',
  })

  assert.equal(outcome.state, 'done')
  assert.equal(outcome.reason, 'completed')
  assert.equal(outcome.toolCalls, 1, 'tool_call frames are counted, not just relayed')
  assert.match(outcome.summary, /work log/)
  assert.ok(outcome.costMicroUsd !== null && outcome.costMicroUsd > 0, 'the turn was priced')
  assert.equal(outcome.conflict, null)

  const row = runRowOf(db, outcome.runId)
  assert.equal(row?.state, 'done')
  assert.equal(row?.dshSessionId, outcome.sessionId, 'the session is persisted: it is how a chat continues')
  assert.equal(row?.error, null)
  assert.equal(row?.resultSummary, outcome.summary, 'a cron run returns its outcome to nobody, so it is stored')
  assert.ok(typeof row?.endedAt === 'number' && row.endedAt >= (row?.startedAt ?? 0), 'the row carries its own duration')

  const usage = usageRowsOf(db, outcome.runId)
  assert.equal(usage.length, 1)
  assert.equal(usage[0]?.provider, 'deepseek-official')
  assert.equal(usage[0]?.model, 'deepseek-v4-pro')
  assert.equal(usage[0]?.inputTokens, 1200)
  assert.equal(usage[0]?.outputTokens, 80)
  assert.equal(usage[0]?.cacheRead, 400)
  assert.ok((usage[0]?.cost ?? 0) > 0)
})

test('usage from several assistant steps is summed into one ledger line', async () => {
  const db = makeDb()
  const fake = new FakeSessionDriver('A', {
    ...SUCCESS,
    frames: [
      { kind: 'message', seq: 0, text: 'step one. ', usage: { inputTokens: 100, outputTokens: 10 } },
      { kind: 'message', seq: 0, text: 'step two.', usage: { inputTokens: 200, outputTokens: 20, reasoningTokens: 5 } },
      { kind: 'turn_end', seq: 0, turn: 1, reason: 'completed', detail: null },
    ],
  })

  const outcome = await runAgent({ db }, {
    agent: agentFor(tempDir('ws')),
    upstream: fake,
    prompt: 'hi',
    trigger: 'manual',
  })

  assert.deepEqual(outcome.usage, { inputTokens: 300, outputTokens: 30, reasoningTokens: 5 })
  assert.equal(outcome.summary, 'step one. \nstep two.', 'every assistant step is part of the summary')
  assert.equal(usageRowsOf(db, outcome.runId).length, 1, 'one run is one ledger line, however many steps it took')
})

test('a failed turn still bills the tokens it spent', async () => {
  // The tokens were spent whether or not the turn succeeded, and usage cannot be reconstructed afterwards.
  // (The turn_end reason -> message mapping itself is covered in runner-apiproxy.test.ts.)
  const db = makeDb()
  const fake = new FakeSessionDriver('A', {
    ...SUCCESS,
    frames: [
      { kind: 'message', seq: 0, text: 'partial', usage: { inputTokens: 500, outputTokens: 5 } },
      { kind: 'turn_end', seq: 0, turn: 1, reason: 'error', detail: { message: 'provider refused', code: 'bad_request' } },
    ],
  })

  const outcome = await runAgent({ db }, {
    agent: agentFor(tempDir('ws')),
    upstream: fake,
    prompt: 'hi',
    trigger: 'manual',
  })

  assert.equal(outcome.state, 'failed')
  assert.deepEqual(outcome.usage, { inputTokens: 500, outputTokens: 5 })
  const usage = usageRowsOf(db, outcome.runId)
  assert.equal(usage.length, 1, 'a failed turn is still accounted for')
  assert.equal(usage[0]?.inputTokens, 500)
  assert.ok((usage[0]?.cost ?? 0) > 0)
  assert.equal(runRowOf(db, outcome.runId)?.state, 'failed', 'the row lands in a terminal state')
})

test('a turn the host aborted is failed with the cause it reported', async () => {
  // Distinct from a caller stop and from reason=error (both covered in runner-apiproxy.test.ts): here the host
  // itself gave up, and the cause it names is the only hint the operator gets.
  const db = makeDb()
  const fake = new FakeSessionDriver('A', {
    ...SUCCESS,
    frames: [{ kind: 'turn_end', seq: 0, turn: 1, reason: 'aborted', detail: { cause: 'user_cancelled' } }],
  })

  const outcome = await runAgent({ db }, {
    agent: agentFor(tempDir('ws')),
    upstream: fake,
    prompt: 'hi',
    trigger: 'manual',
  })

  assert.equal(outcome.state, 'failed')
  assert.equal(outcome.reason, 'aborted', 'the reason the host reported is kept verbatim')
  assert.match(outcome.error ?? '', /aborted/)
  assert.match(outcome.error ?? '', /user_cancelled/)
  assert.equal(runRowOf(db, outcome.runId)?.state, 'failed')
})

test('a turn that reports no usage leaves no ledger line and no fabricated cost', async () => {
  const db = makeDb()
  const fake = new FakeSessionDriver('A', {
    ...SUCCESS,
    frames: [
      { kind: 'message', seq: 0, text: 'done', usage: null },
      { kind: 'turn_end', seq: 0, turn: 1, reason: 'completed', detail: null },
    ],
  })

  const outcome = await runAgent({ db }, {
    agent: agentFor(tempDir('ws')),
    upstream: fake,
    prompt: 'hi',
    trigger: 'manual',
  })

  assert.equal(outcome.state, 'done')
  assert.equal(outcome.usage, null)
  assert.equal(outcome.costMicroUsd, null, 'better an honest gap than a fake zero')
  assert.equal(outcome.peakCostMicroUsd, null)
  assert.equal(usageRowsOf(db, outcome.runId).length, 0, 'no tokens were reported, so nothing is written')
  assert.equal(runRowOf(db, outcome.runId)?.state, 'done')
})

test('an unpriced model records the tokens and reports the cost gap', async () => {
  const db = makeDb()
  const fake = new FakeSessionDriver('A', { ...SUCCESS, model: 'some-unreleased-model' })

  const outcome = await runAgent({ db }, {
    agent: agentFor(tempDir('ws')),
    upstream: fake,
    prompt: 'hi',
    trigger: 'manual',
  })

  assert.equal(outcome.model, 'some-unreleased-model', 'the model the host confirms is what gets recorded')
  assert.ok(outcome.usage !== null, 'the tokens are still counted; only the price is unknown')
  assert.equal(outcome.costMicroUsd, null, 'a rate that does not exist yields a gap, never a confident zero')
  assert.equal(outcome.peakCostMicroUsd, null)

  const usage = usageRowsOf(db, outcome.runId)
  assert.equal(usage[0]?.model, 'some-unreleased-model')
  assert.equal(usage[0]?.inputTokens, 1200)
  assert.equal(usage[0]?.cost, null)
  assert.equal(usage[0]?.peakCost, null)
})

// ---------------------------------------------------------------------------
// pricing across the peak boundary
// ---------------------------------------------------------------------------

/** A turn with two billable responses, so each can be priced at its own instant. */
const TWO_RESPONSES: FakeScript = {
  provider: 'deepseek-official',
  model: 'deepseek-v4-pro',
  frames: [
    { kind: 'message', seq: 0, text: 'first', usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 } },
    { kind: 'message', seq: 0, text: 'second', usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 } },
    { kind: 'turn_end', seq: 0, turn: 1, reason: 'completed', detail: null },
  ],
}

// 2026-08-28 is a Friday (a workday) -- the all-day off-peak rule for weekends lives in pricing.test.
const OFF_PEAK = Date.parse('2026-08-28T12:00:00Z')
const PEAK = Date.parse('2026-08-28T02:00:00Z')
/** One million in plus one million out on deepseek-v4-pro. */
const OFF_PEAK_MICRO = 2_640_000
const PEAK_MICRO = 5_280_000

/**
 * Returns each value in turn, then sticks on the last.
 *
 * The runner reads the clock once at the start, once per billable response and once at the end, which is what
 * lets a test put two responses on opposite sides of a peak boundary.
 */
const scriptedClock = (values: number[]): (() => number) => {
  let i = 0
  return () => values[Math.min(i++, values.length - 1)] ?? 0
}

test('a turn that crosses a peak boundary is billed at both rates', async () => {
  const db = makeDb()
  const fake = new FakeSessionDriver('A', TWO_RESPONSES)

  // Start off-peak, first response off-peak, second response after the clock has rolled into a peak window,
  // then end.
  const clock = scriptedClock([OFF_PEAK, OFF_PEAK, PEAK, PEAK])

  const outcome = await runAgent({ db, clock }, {
    agent: agentFor(tempDir('ws')),
    upstream: fake,
    prompt: 'hi',
    trigger: 'manual',
  })

  assert.equal(outcome.state, 'done')
  // Pricing the whole turn at one timestamp would give 2x off-peak or 2x peak; neither is what happened.
  assert.equal(outcome.costMicroUsd, OFF_PEAK_MICRO + PEAK_MICRO)
  assert.equal(outcome.peakCostMicroUsd, PEAK_MICRO, 'the split is stored, because it cannot be recovered later')

  const usage = usageRowsOf(db, outcome.runId)
  assert.equal(usage[0]?.cost, OFF_PEAK_MICRO + PEAK_MICRO)
  assert.equal(usage[0]?.peakCost, PEAK_MICRO)
})

test('a turn entirely outside peak hours records no peak cost', async () => {
  const db = makeDb()
  const fake = new FakeSessionDriver('A', TWO_RESPONSES)

  const outcome = await runAgent({ db, clock: scriptedClock([OFF_PEAK]) }, {
    agent: agentFor(tempDir('ws')),
    upstream: fake,
    prompt: 'hi',
    trigger: 'manual',
  })

  assert.equal(outcome.costMicroUsd, OFF_PEAK_MICRO * 2)
  assert.equal(outcome.peakCostMicroUsd, 0)
  assert.equal(usageRowsOf(db, outcome.runId)[0]?.peakCost, 0)
})

// ---------------------------------------------------------------------------
// the two timeouts, and what stands the silence backstop down
// ---------------------------------------------------------------------------

test('the total timeout cancels a turn that never ends', async () => {
  const db = makeDb()
  const fake = new FakeSessionDriver('A', { frames: [] })

  // silenceMs: 0 disables the backstop, so there is no doubt which timer ended this.
  const outcome = await runAgent({ db }, {
    agent: agentFor(tempDir('ws')),
    upstream: fake,
    prompt: 'hi',
    trigger: 'cron',
    timeoutMs: 250,
    silenceMs: 0,
  })

  assert.equal(outcome.state, 'failed')
  assert.match(outcome.error ?? '', /no response within/, 'the total timeout says so, not the silence backstop')
  assert.equal(fake.cancels, 1, 'the turn was cancelled through the port')
  assert.equal(runningRunId('personal'), null, 'the registration was dropped')
  assert.equal(activeRunCount('personal'), 0)
  const row = runRowOf(db, outcome.runId)
  assert.equal(row?.state, 'failed')
  assert.equal(row?.error, outcome.error, 'the reason a cron died is on the row, not just in the return value')
  assert.ok(typeof row?.endedAt === 'number', 'a timed-out run still gets its endedAt')
})

test('a long turn that keeps producing frames is not cut off by the silence backstop', async () => {
  const db = makeDb()
  // Each gap is under the silence window, but the turn as a whole runs longer than it: only a timer that is
  // pushed forward by every frame survives this.
  const fake = new ScheduledFake('A', [
    { afterMs: 40, frame: { kind: 'tool_call', seq: 0, name: 'a', arguments: '{}' } },
    { afterMs: 40, frame: { kind: 'tool_call', seq: 0, name: 'b', arguments: '{}' } },
    { afterMs: 40, frame: { kind: 'tool_call', seq: 0, name: 'c', arguments: '{}' } },
    { afterMs: 40, frame: { kind: 'message', seq: 0, text: 'done thinking', usage: { inputTokens: 5, outputTokens: 2 } } },
    { afterMs: 40, frame: { kind: 'turn_end', seq: 0, turn: 1, reason: 'completed', detail: null } },
  ])

  const outcome = await runAgent({ db }, {
    agent: agentFor(tempDir('ws')),
    upstream: fake,
    prompt: 'hi',
    trigger: 'manual',
    timeoutMs: 10_000,
    silenceMs: 100,
  })

  assert.equal(outcome.state, 'done', outcome.error ?? '')
  assert.equal(outcome.toolCalls, 3)
  assert.equal(fake.cancels, 0, 'a productive turn is never cancelled')
  assert.match(outcome.summary, /done thinking/)
})

test('a turn waiting on a question is left alone by the silence backstop', async () => {
  const db = makeDb()
  // Silent for several times the window, but for a reason that is on screen: the question card is open and
  // someone is presumably reading it. Cancelling here would throw the turn away while its answer was typed.
  const fake = new ScheduledFake('A', [
    { afterMs: 20, frame: { kind: 'question_asked', seq: 0, questionId: 'q-1', questions: [{ id: 'a', question: 'which one?' }] } },
    { afterMs: 400, frame: { kind: 'question_resolved', seq: 0, questionId: 'q-1', outcome: 'answered' } },
    { afterMs: 20, frame: { kind: 'message', seq: 0, text: 'thanks', usage: { inputTokens: 1, outputTokens: 1 } } },
    { afterMs: 20, frame: { kind: 'turn_end', seq: 0, turn: 1, reason: 'completed', detail: null } },
  ])

  const outcome = await runAgent({ db }, {
    agent: agentFor(tempDir('ws')),
    upstream: fake,
    prompt: 'hi',
    trigger: 'manual',
    timeoutMs: 10_000,
    silenceMs: 120,
  })

  assert.equal(outcome.state, 'done', outcome.error ?? '')
  assert.equal(fake.cancels, 0, 'a turn waiting on a human is not a stalled turn')
  assert.match(outcome.summary, /thanks/)
})

test('a turn with a tool in flight is left alone by the silence backstop', async () => {
  const db = makeDb()
  // A tool call is progress: the host is executing it and no frames stream while it runs (the measured
  // P0 kill: a single sleep 400 command was cancelled at 304s, pre-announcement notwithstanding).
  const fake = new ScheduledFake('A', [
    { afterMs: 20, frame: { kind: 'tool_call', seq: 0, name: 'bash', arguments: '{}' } },
    { afterMs: 400, frame: { kind: 'tool_result', seq: 0, name: 'bash' } },
    { afterMs: 20, frame: { kind: 'message', seq: 0, text: 'command done', usage: { inputTokens: 1, outputTokens: 1 } } },
    { afterMs: 20, frame: { kind: 'turn_end', seq: 0, turn: 1, reason: 'completed', detail: null } },
  ])

  const outcome = await runAgent({ db }, {
    agent: agentFor(tempDir('ws')),
    upstream: fake,
    prompt: 'hi',
    trigger: 'manual',
    timeoutMs: 10_000,
    silenceMs: 120,
  })

  assert.equal(outcome.state, 'done', outcome.error ?? '')
  assert.equal(fake.cancels, 0, 'a tool running silently is progress, not silence')
  assert.match(outcome.summary, /command done/)
})

test('after the last tool finishes, real silence still cancels the turn', async () => {
  const db = makeDb()
  // The backstop stands down only WHILE a tool runs; once the tool result lands and nothing follows,
  // genuine silence must still kill the turn -- the total timeout is not the only net.
  const fake = new ScheduledFake('A', [
    { afterMs: 20, frame: { kind: 'tool_call', seq: 0, name: 'bash', arguments: '{}' } },
    { afterMs: 20, frame: { kind: 'tool_result', seq: 0, name: 'bash' } },
  ])

  const outcome = await runAgent({ db }, {
    agent: agentFor(tempDir('ws')),
    upstream: fake,
    prompt: 'hi',
    trigger: 'manual',
    timeoutMs: 10_000,
    silenceMs: 100,
  })

  assert.equal(outcome.state, 'failed')
  assert.equal(fake.cancels, 1, 'silence after the tool finished must still cancel')
  assert.match(outcome.error ?? '', /nothing happened/)
})

test('a pending permission prompt lands in the approval queue and the decision resolves it', async () => {
  const db = makeDb()
  // A headless run has no chat to hang the approval card on, so the prompt must be recorded durably
  // (the registry the headless decide endpoint acts on). decisionId is the host's rpc id.
  const fake = new ScheduledFake('A', [
    { afterMs: 20, frame: { kind: 'approval_pending', seq: 0, decisionId: 'd-1', approvalId: 'a-1', toolName: 'bash', reason: null } },
    { afterMs: 20, frame: { kind: 'approval_resolved', seq: 0, decisionId: 'd-1', outcome: 'allowed-once' } },
    { afterMs: 20, frame: { kind: 'turn_end', seq: 0, turn: 1, reason: 'completed', detail: null } },
  ])

  const outcome = await runAgent({ db }, {
    agent: agentFor(tempDir('ws')),
    upstream: fake,
    prompt: 'hi',
    trigger: 'manual',
    timeoutMs: 10_000,
    silenceMs: 1_000,
  })

  assert.equal(outcome.state, 'done', outcome.error ?? '')
  const rows = db.select().from(schema.approvalQueue).where(eq(schema.approvalQueue.runId, outcome.runId ?? '')).all()
  assert.equal(rows.length, 1, 'the pending prompt is recorded exactly once')
  assert.equal(rows[0]?.id, 'd-1')
  assert.equal(rows[0]?.approvalId, 'a-1')
  assert.equal(rows[0]?.toolName, 'bash')
  assert.equal(rows[0]?.state, 'resolved')
  assert.equal(rows[0]?.outcome, 'allowed-once')
  assert.ok(typeof rows[0]?.resolvedAt === 'number')
})

test('a pending permission prompt that the turn never answers stays pending', async () => {
  const db = makeDb()
  const fake = new ScheduledFake('A', [
    { afterMs: 20, frame: { kind: 'approval_pending', seq: 0, decisionId: 'd-2', approvalId: 'a-2', toolName: 'bash', reason: null } },
    { afterMs: 20, frame: { kind: 'turn_end', seq: 0, turn: 1, reason: 'completed', detail: null } },
  ])

  const outcome = await runAgent({ db }, {
    agent: agentFor(tempDir('ws')),
    upstream: fake,
    prompt: 'hi',
    trigger: 'manual',
    timeoutMs: 10_000,
    silenceMs: 1_000,
  })

  assert.equal(outcome.state, 'done', outcome.error ?? '')
  const rows = db.select().from(schema.approvalQueue).where(eq(schema.approvalQueue.runId, outcome.runId ?? '')).all()
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.state, 'pending', 'an unanswered prompt stays pending, so the queue shows it')
})

// ---------------------------------------------------------------------------
// concurrency and the active-run registration (Hive P5.4)
// ---------------------------------------------------------------------------

test('two concurrent runs on the same agent both complete, and their commits queue instead of trampling each other', async () => {
  const db = makeDb()
  const workspace = makeRepo()
  const before = commitCount(workspace)
  const agent = agentFor(workspace)
  // One driver serves both runs: the sessions are separate, and the frame schedule keeps the two turns in
  // flight at the same time -- which is when two `git add`/`commit` would meet on index.lock without the lock.
  const fake = new ScheduledFake('A', [
    { afterMs: 25, frame: { kind: 'tool_call', seq: 0, name: 'write_file', arguments: '{}' } },
    { afterMs: 25, frame: { kind: 'message', seq: 0, text: 'written', usage: { inputTokens: 10, outputTokens: 2 } } },
    { afterMs: 25, frame: { kind: 'turn_end', seq: 0, turn: 1, reason: 'completed', detail: null } },
  ])

  const [a, b] = await Promise.all([
    runAgent({ db }, { agent, upstream: fake, prompt: 'first', trigger: 'manual', onFrame: writesFileOnFrame(workspace, 'a.md', 'from the first run\n') }),
    runAgent({ db }, { agent, upstream: fake, prompt: 'second', trigger: 'cron', onFrame: writesFileOnFrame(workspace, 'b.md', 'from the second run\n') }),
  ])

  assert.equal(a.state, 'done', a.error ?? '')
  assert.equal(b.state, 'done', b.error ?? '')
  assert.notEqual(a.runId, b.runId)
  assert.equal(activeRunCount('personal'), 0, 'both runs left the active set')
  assert.equal(runningRunId('personal'), null)

  // Both concurrent runs left their own row -- there is no longer a "one live run" constraint.
  const rows = db.select().from(schema.run).all()
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map((row) => row.state).sort(), ['done', 'done'])

  // Whoever got the lock first committed whatever was dirty; the invariant is that no work was lost and that
  // neither run failed on the other's index.lock.
  assert.deepEqual([...new Set([...a.changedFiles, ...b.changedFiles])].sort(), ['a.md', 'b.md'])
  assert.equal(git(workspace, 'status', '--short').trim(), '', 'the workspace is clean afterwards')
  const tracked = filesOf(workspace, 'HEAD')
  const all = git(workspace, 'ls-files').split('\n').map((line) => line.trim())
  assert.ok(all.includes('a.md') && all.includes('b.md'), `both runs' work is in the repository; HEAD held ${tracked.join(', ')}`)
  const added = commitCount(workspace) - before
  assert.ok(added === 1 || added === 2, `the two runs produced one or two commits, got ${added}`)
})

test('the run row exists while the run is in flight, and the registration is visible', async () => {
  const db = makeDb()
  const fake = new ScheduledFake('A', [
    { afterMs: 80, frame: { kind: 'message', seq: 0, text: 'still working', usage: null } },
    { afterMs: 80, frame: { kind: 'turn_end', seq: 0, turn: 1, reason: 'completed', detail: null } },
  ])

  const pending = runAgent({ db }, { agent: agentFor(tempDir('ws')), upstream: fake, prompt: 'hi', trigger: 'manual' })
  await sleep(40)

  const live = db.select().from(schema.run).where(eq(schema.run.state, 'running')).all()
  assert.equal(live.length, 1, 'a crash mid-run would still leave a trace')
  assert.equal(runningRunId('personal'), live[0]?.id, 'the busy dot points at the run that is really running')
  assert.equal(activeRunCount('personal'), 1)

  const outcome = await pending
  assert.equal(outcome.state, 'done', outcome.error ?? '')
  assert.equal(runningRunId('personal'), null)
  assert.equal(activeRunCount('personal'), 0)
  assert.equal(db.select().from(schema.run).where(eq(schema.run.state, 'running')).all().length, 0)
})

// ---------------------------------------------------------------------------
// workspace snapshots
// ---------------------------------------------------------------------------

test('a run commits what the agent changed, with the instruction as the subject', async () => {
  const db = makeDb()
  const fake = new FakeSessionDriver('A', SUCCESS)
  const workspace = makeRepo()
  const before = commitCount(workspace)

  const outcome = await runAgent({ db }, {
    agent: agentFor(workspace),
    upstream: fake,
    prompt: 'append the current date to the work log',
    trigger: 'manual',
    onFrame: writesFileOnFrame(workspace, 'log.md', '- 2026-10-12\n'),
  })

  assert.equal(outcome.state, 'done')
  assert.ok(outcome.commit !== null, 'the run produced a commit')
  assert.deepEqual(outcome.changedFiles, ['log.md'])
  assert.equal(outcome.snapshotSkipped, null)
  assert.equal(outcome.conflict, null, 'nothing else touched the workspace')
  assert.equal(commitCount(workspace), before + 1, 'exactly one commit')

  // The subject is what makes `git log --oneline` an audit trail worth reading.
  const subject = git(workspace, 'log', '-1', '--pretty=%s').trim()
  assert.ok(subject.includes('append the current date to the work log'), `subject was: ${subject}`)
  const body = git(workspace, 'log', '-1', '--pretty=%b')
  assert.ok(body.includes(outcome.runId), 'the run id is traceable from the commit')
  assert.equal(git(workspace, 'status', '--short').trim(), '', 'the workspace is clean afterwards')

  // Persisted, because a cron run returns its outcome to nobody.
  assert.equal(runRowOf(db, outcome.runId)?.commitHash, outcome.commit)
})

test('pre-existing uncommitted work gets its own commit, so the agent commit can be reverted alone', async () => {
  const db = makeDb()
  const fake = new FakeSessionDriver('A', SUCCESS)
  const workspace = makeRepo()
  // The operator was editing a note by hand and never committed it.
  writeFileSync(join(workspace, 'my-draft.md'), 'half a thought\n', 'utf8')
  const before = commitCount(workspace)

  const outcome = await runAgent({ db }, {
    agent: agentFor(workspace),
    upstream: fake,
    prompt: 'tidy the trading snapshot',
    trigger: 'manual',
    onFrame: writesFileOnFrame(workspace, 'agent-output.md', 'written by the agent\n'),
  })

  assert.equal(outcome.state, 'done')
  assert.equal(commitCount(workspace), before + 2, 'one commit for the draft, one for the agent')
  // The whole point: reverting the agent must not take the draft with it.
  assert.deepEqual(outcome.changedFiles, ['agent-output.md'])
  assert.deepEqual(filesOf(workspace, 'HEAD'), ['agent-output.md'], 'the closing commit holds only what the agent wrote')
  assert.deepEqual(filesOf(workspace, 'HEAD^'), ['my-draft.md'], 'and the draft keeps its own')
  assert.match(git(workspace, 'log', '-1', '--pretty=%s', 'HEAD^'), /uncommitted changes before the run/)
})

test('a run that changes nothing produces no commit', async () => {
  const db = makeDb()
  const fake = new FakeSessionDriver('A', SUCCESS)
  const workspace = makeRepo()
  const before = commitCount(workspace)

  const outcome = await runAgent({ db }, {
    agent: agentFor(workspace),
    upstream: fake,
    prompt: 'read the last line of the work log',
    trigger: 'manual',
  })

  assert.equal(outcome.state, 'done')
  assert.equal(outcome.commit, null, 'a read-only turn must not leave an empty commit')
  assert.deepEqual(outcome.changedFiles, [])
  assert.equal(outcome.snapshotSkipped, null, 'skipped is for failures, not for a clean workspace')
  assert.equal(commitCount(workspace), before)
  assert.equal(runRowOf(db, outcome.runId)?.commitHash, null)
})

test('a workspace that is not a git repository does not fail the run', async () => {
  // The turn already happened and already cost money. A missing audit trail is worth a warning, never a lost run.
  const db = makeDb()
  const fake = new FakeSessionDriver('A', SUCCESS)

  const outcome = await runAgent({ db }, {
    agent: agentFor(tempDir('ws-plain')),
    upstream: fake,
    prompt: 'hi',
    trigger: 'manual',
  })

  assert.equal(outcome.state, 'done', 'the run still succeeded')
  assert.equal(outcome.commit, null)
  assert.ok(outcome.snapshotSkipped !== null, 'and it says why there is no commit')
  assert.match(outcome.snapshotSkipped, /not a git repository/)
})

test('a failed turn still commits what the agent wrote', async () => {
  // An agent that wrote files and then errored has changed the workspace. Leaving that uncommitted is how work
  // gets silently lost.
  const db = makeDb()
  const fake = new FakeSessionDriver('A', {
    ...SUCCESS,
    frames: [
      { kind: 'message', seq: 0, text: 'half written', usage: { inputTokens: 10, outputTokens: 2 } },
      { kind: 'turn_end', seq: 0, turn: 1, reason: 'error', detail: { message: 'model exploded' } },
    ],
  })
  const workspace = makeRepo()
  const before = commitCount(workspace)

  const outcome = await runAgent({ db }, {
    agent: agentFor(workspace),
    upstream: fake,
    prompt: 'update the holdings',
    trigger: 'cron',
    onFrame: writesFileOnFrame(workspace, 'partial.md', 'half written\n'),
  })

  assert.equal(outcome.state, 'failed')
  assert.ok(outcome.commit !== null, 'the half-finished work was still committed')
  assert.deepEqual(outcome.changedFiles, ['partial.md'])
  assert.equal(commitCount(workspace), before + 1)
  // Anyone reading the log must be able to see that this file may be incomplete.
  const body = git(workspace, 'log', '-1', '--pretty=%b')
  assert.match(body, /State: failed/)
  assert.match(body, /did not finish cleanly/)
  assert.equal(runRowOf(db, outcome.runId)?.commitHash, outcome.commit)
})

test('a commit that lands mid-turn is reported as a conflict instead of being swallowed', async () => {
  // Hive P5.4: the baseline for conflict detection is the workspace HEAD at the moment this turn started
  // writing to disk. If HEAD moves on underneath it, this turn worked from the older state and that must be
  // visible rather than silently overwritten by the closing commit.
  const db = makeDb()
  const fake = new FakeSessionDriver('A', SUCCESS)
  const workspace = makeRepo()
  const baseline = head(workspace)

  let committed = false
  const outcome = await runAgent({ db }, {
    agent: agentFor(workspace),
    upstream: fake,
    prompt: 'read the work log',
    trigger: 'cron',
    // Stands in for a concurrent turn (or the operator) committing while this one runs.
    onFrame: () => {
      if (committed) return
      committed = true
      writeFileSync(join(workspace, 'other-turn.md'), 'written by a concurrent turn\n', 'utf8')
      git(workspace, 'add', '-A')
      git(workspace, 'commit', '-q', '-m', 'a concurrent turn')
    },
  })

  assert.equal(outcome.state, 'done')
  assert.notEqual(head(workspace), baseline, 'HEAD moved while the turn ran')
  assert.ok(outcome.conflict !== null, 'the concurrent commit is visible on the outcome')
  assert.match(outcome.conflict, /concurrent change/)
  assert.match(outcome.conflict, /worked from the older state/)
  assert.equal(outcome.commit, null, 'this turn changed nothing of its own')
  assert.equal(runRowOf(db, outcome.runId)?.conflict, outcome.conflict, 'persisted: a cron run reports to nobody')
})

// ---------------------------------------------------------------------------
// finish: idempotence, and what gets stored
// ---------------------------------------------------------------------------

test('Debt R8: a caller abort that races turn_end books the run exactly once', async () => {
  const db = makeDb()
  const fake = new FakeSessionDriver('A', SUCCESS)
  const controller = new AbortController()

  const outcome = await runAgent({ db }, {
    agent: agentFor(tempDir('ws')),
    upstream: fake,
    prompt: 'hi',
    trigger: 'manual',
    signal: controller.signal,
    // The caller stops the run at the exact moment the host says it is done: the abort path and the turn_end
    // path both reach finish, from inside one frame delivery.
    onFrame: (frame) => {
      if (frame.kind === 'turn_end') controller.abort()
    },
  })

  assert.equal(outcome.state, 'failed', 'the first finish wins: the stop is seen before turn_end is processed')
  assert.equal(outcome.error, 'the turn was stopped by the user')
  assert.equal(fake.cancels, 1, 'the racing abort still cancelled upstream')

  const row = runRowOf(db, outcome.runId)
  assert.equal(row?.state, outcome.state, 'the row and the returned outcome agree: one write landed, not two')
  assert.equal(row?.error, outcome.error)
  assert.equal(usageRowsOf(db, outcome.runId).length, 1, 'the tokens are booked once, not once per racing finish')
  assert.equal(activeRunCount('personal'), 0)
})

test('a summary longer than the storage limit is truncated, and says what was cut', async () => {
  const db = makeDb()
  const long = 'x'.repeat(4_500)
  const fake = new FakeSessionDriver('A', {
    ...SUCCESS,
    frames: [
      { kind: 'message', seq: 0, text: long, reasoning: null, usage: null },
      { kind: 'turn_end', seq: 0, turn: 1, reason: 'completed', detail: null },
    ],
  })

  const outcome = await runAgent({ db }, {
    agent: agentFor(tempDir('ws')),
    upstream: fake,
    prompt: 'hi',
    trigger: 'manual',
  })

  // SUMMARY_LIMIT in runner/turn.ts: the assistant text is trimmed for storage, and the cut is announced
  // rather than left invisible.
  assert.equal(outcome.state, 'done')
  assert.equal(outcome.summary, `${'x'.repeat(4_000)}\n[truncated 500 chars]`)
  assert.equal(runRowOf(db, outcome.runId)?.resultSummary, outcome.summary, 'the truncated text is what lands in the DB')
})

test('Debt A2 regression: a failed usage write degrades the run to failed instead of leaving it half-done', async () => {
  // A hand-built db (a sqlite handle is needed to inject the trigger): usage_record throws on insert, which is
  // the real failure path of a full disk or a constraint conflict.
  const dir = tempDir('runner-db')
  const { db, sqlite } = openDb(join(dir, 'test.db'))
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
  sqlite.exec("CREATE TRIGGER boom_usage BEFORE INSERT ON usage_record BEGIN SELECT RAISE(ABORT, 'boom'); END")

  const fake = new FakeSessionDriver('A', SUCCESS)
  const workspace = tempDir('ws')

  // Before the fix a failing usage insert was thrown straight out and the run row stayed in an intermediate
  // state (the old code wrote done before usage). After it, the transaction rolls back and the run degrades to
  // failed, so the row has a terminal state and the accounting gap is visible in the error.
  const outcome = await runAgent({ db }, {
    agent: agentFor(workspace),
    upstream: fake,
    prompt: 'append the current date to the work log',
    trigger: 'manual',
  })

  assert.equal(outcome.state, 'failed')
  assert.match(outcome.error ?? '', /accounting failed/)
  const row = runRowOf(db, outcome.runId)
  assert.equal(row?.state, 'failed', 'the run row must land in the terminal failed state, never linger in running/done')
  assert.match(row?.error ?? '', /accounting failed/)
  assert.equal(usageRowsOf(db, outcome.runId).length, 0, 'no leftover usage rows after the transaction rolls back')
})

// ---------------------------------------------------------------------------
// outward turns: the edges of the auto-decline grace window
//
// The decline itself (question and approval) and the inward "never decline" rule are covered in
// runner-apiproxy.test.ts; what is left here is a human beating the window, and the window's own failure.
// ---------------------------------------------------------------------------

/** run.api_key_id is a foreign key: an outward turn needs a real key row to hang its billing on. */
const outwardKey = (db: Db): string =>
  mintApiKey(db, {
    name: 'runner-test',
    scopes: ['conversations:write'],
    scopeServices: ['*'],
    quotaRunsDay: null,
    rateLimitRpm: 60,
    maxConcurrency: 4,
    expiresAt: null,
    createdBy: 'test',
  }).key.id

test('an outward question answered inside the grace window is never auto-declined', async () => {
  const db = makeDb()
  // An operator watching this conversation in the admin chat got there first: the manager must keep its hands
  // off, or the customer's answer and its own decline would race for the same question.
  const fake = new ScheduledFake('A', [
    { afterMs: 10, frame: { kind: 'question_asked', seq: 0, questionId: 'q-1', questions: [{ id: 'a', question: 'which one?' }] } },
    { afterMs: 40, frame: { kind: 'question_resolved', seq: 0, questionId: 'q-1', outcome: 'answered' } },
    { afterMs: 10, frame: { kind: 'message', seq: 0, text: 'noted, thanks', reasoning: null, usage: null } },
    { afterMs: 10, frame: { kind: 'turn_end', seq: 0, turn: 1, reason: 'completed', detail: null } },
  ])

  const outcome = await runAgent({ db }, {
    agent: agentFor(tempDir('ws')),
    upstream: fake,
    prompt: 'follow-up',
    trigger: 'api',
    apiKeyId: outwardKey(db),
    outwardGraceMs: 500,
    silenceMs: 0,
    timeoutMs: 5_000,
  })

  assert.equal(outcome.state, 'done', outcome.error ?? '')
  assert.deepEqual(fake.declined, [], 'a human answered first, so no decline goes out')
  assert.match(outcome.summary, /noted, thanks/)
})

test('an auto-decline that fails is a warning: the armed backstop still ends the turn', async () => {
  const db = makeDb()
  const fake = new DeclineFailsFake('A', {
    frames: [{ kind: 'question_asked', seq: 0, questionId: 'q-1', questions: [{ id: 'a', question: 'which one?' }] }],
  })
  const warnings: string[] = []

  const outcome = await runAgent(
    { db, log: { info: () => {}, warn: (message) => warnings.push(message), error: () => {} } },
    {
      agent: agentFor(tempDir('ws')),
      upstream: fake,
      prompt: 'follow-up',
      trigger: 'api',
      apiKeyId: outwardKey(db),
      outwardGraceMs: 20,
      silenceMs: 120,
      timeoutMs: 5_000,
    },
  )

  assert.equal(fake.declineCalls, 1, 'the decline was attempted once, through the port')
  assert.equal(outcome.state, 'failed', 'with nobody able to answer, the backstop ends the turn instead of hanging')
  assert.match(outcome.error ?? '', /nothing happened/)
  assert.ok(
    warnings.some((warning) => warning.includes('auto-decline failed')),
    `the failed decline is reported; warnings were: ${warnings.join(' | ')}`,
  )
})
