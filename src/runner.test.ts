import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { eq } from 'drizzle-orm'
import { openDb, schema, type Db } from './db/index.js'
import { GatewayClient } from './gateway/client.js'
import { startFakeGateway, type FakeGateway, type FakeScript } from './gateway/fake.js'
import { activeRunCount, runAgent, runningRunId } from './runner.js'
// 债务 C3:makeDb/agentFor 收敛进 test-harness(本地保留别名,行为不变)。
import { makeDb as makeHarnessDb, personalAgent } from './test-harness.js'

const API_KEY = 'test-key'

const makeDb = (): Db => makeHarnessDb().db

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

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

/** A workspace that is a real git repo, so snapshots can actually commit. */
const makeRepo = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'ws-git-'))
  writeFileSync(join(root, 'RULE.md'), '# rules\n', 'utf8')
  git(root, 'init', '-q')
  git(root, 'config', 'user.email', 'test@local')
  git(root, 'config', 'user.name', 'test')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'initial')
  return root
}

const commitCount = (root: string): number => Number(git(root, 'rev-list', '--count', 'HEAD').trim())

/**
 * Simulates the agent writing a file partway through the turn.
 *
 * `onFrame` fires inside the streaming loop, so a write from here lands while
 * the turn is still open -- which is exactly when DSH's own tools would write,
 * and manager never sees those calls.
 */
const writesFileOnFrame = (root: string, relPath: string, contents: string): ((f: unknown) => void) => {
  let done = false
  return () => {
    if (done) return
    done = true
    writeFileSync(join(root, relPath), contents, 'utf8')
  }
}

/** A normal successful turn: one tool call, one message with usage, then turn_end. */
const SUCCESS: FakeScript = {
  frames: [
    { kind: 'turn_start', turn: 1 },
    { kind: 'tool_call', name: 'write_file', arguments: '{"path":"log.md"}' },
    { kind: 'tool_result', isError: false, text: 'written' },
    { kind: 'message', text: '已在工作日志里加了一行。', reasoning: null, usage: { inputTokens: 1200, outputTokens: 80, cacheReadTokens: 400 } },
    { kind: 'turn_end', turn: 1, reason: 'completed', detail: null },
  ],
}

test('a successful run records state, summary, usage and cost', async () => {
  const db = makeDb()
  const gw = await boot(SUCCESS)
  const workspace = mkdtempSync(join(tmpdir(), 'ws-'))

  const outcome = await runAgent({ db }, {
    agent: agentFor(workspace),
    client: clientFor(gw),
    prompt: '在工作日志里加一行今天的日期',
    trigger: 'manual',
  })

  assert.equal(outcome.state, 'done')
  assert.equal(outcome.reason, 'completed')
  assert.equal(outcome.toolCalls, 1)
  assert.match(outcome.summary, /工作日志/)
  assert.deepEqual(outcome.usage, { inputTokens: 1200, outputTokens: 80, cacheReadTokens: 400 })
  assert.ok(outcome.costMicroUsd !== null && outcome.costMicroUsd > 0, 'cost was computed')

  const rows = db.select().from(schema.run).where(eq(schema.run.id, outcome.runId)).all()
  assert.equal(rows[0]?.state, 'done')
  assert.equal(rows[0]?.dshSessionId, 'sess-1')
  assert.ok((rows[0]?.endedAt ?? 0) >= (rows[0]?.startedAt ?? 0))

  const usage = db.select().from(schema.usageRecord).where(eq(schema.usageRecord.runId, outcome.runId)).all()
  assert.equal(usage.length, 1)
  assert.equal(usage[0]?.inputTokens, 1200)
  assert.equal(usage[0]?.cacheRead, 400)
  assert.ok((usage[0]?.cost ?? 0) > 0)
})

test('the session is bound to the agent workspace', async () => {
  const db = makeDb()
  const gw = await boot(SUCCESS)
  const workspace = mkdtempSync(join(tmpdir(), 'ws-'))

  await runAgent({ db }, { agent: agentFor(workspace), client: clientFor(gw), prompt: 'hi', trigger: 'manual' })

  const create = gw.calls.find((c) => c.path === '/sessions' && c.method === 'POST')
  assert.equal((create?.body as { cwd?: string } | undefined)?.cwd, workspace, 'cwd is the write boundary')
})

test('subscribes before sending, so no event can be missed', async () => {
  const db = makeDb()
  const gw = await boot(SUCCESS)

  await runAgent({ db }, {
    agent: agentFor(mkdtempSync(join(tmpdir(), 'ws-'))),
    client: clientFor(gw),
    prompt: 'hi',
    trigger: 'manual',
  })

  // The whole round trip, in order. The stream must be open before the message
  // is sent, and the slot goes back last -- after the turn, not during it.
  const order = gw.calls.map((c) => `${c.method} ${c.path.replace(/sess-\d+/, ':id')}`)
  assert.deepEqual(order, [
    'POST /sessions',
    'GET /sessions/:id/stream',
    'POST /sessions/:id/messages',
    'DELETE /sessions/:id',
  ])
})

test('the instruction is sent as content, which is what the gateway accepts', async () => {
  const db = makeDb()
  const gw = await boot(SUCCESS)

  const outcome = await runAgent({ db }, {
    agent: agentFor(mkdtempSync(join(tmpdir(), 'ws-'))),
    client: clientFor(gw),
    prompt: '记一笔：午饭 38 元',
    trigger: 'manual',
  })

  assert.equal(outcome.state, 'done', 'a wrong field name would have produced a 400 here')
  assert.deepEqual(gw.messages, ['记一笔：午饭 38 元'])
})

test('history replayed in the hello frame is not billed again', async () => {
  // The gateway replays the whole session log on connect. Counting its usage
  // would re-bill every previous turn on every run.
  const db = makeDb()
  const gw = await boot({
    ...SUCCESS,
    history: [
      { kind: 'message', seq: 1, text: 'earlier turn', usage: { inputTokens: 999_999, outputTokens: 999_999 } },
      { kind: 'turn_end', seq: 2, reason: 'completed', detail: null },
    ],
  })

  const outcome = await runAgent({ db }, {
    agent: agentFor(mkdtempSync(join(tmpdir(), 'ws-'))),
    client: clientFor(gw),
    prompt: 'hi',
    trigger: 'manual',
  })

  assert.equal(outcome.usage?.inputTokens, 1200, 'only the live turn was counted')
  assert.ok(!outcome.summary.includes('earlier turn'), 'replayed text is not part of this run’s summary')
})

test('usage from several assistant steps is summed', async () => {
  const db = makeDb()
  const gw = await boot({
    frames: [
      { kind: 'message', text: 'step one. ', usage: { inputTokens: 100, outputTokens: 10 } },
      { kind: 'message', text: 'step two.', usage: { inputTokens: 200, outputTokens: 20, reasoningTokens: 5 } },
      { kind: 'turn_end', reason: 'completed', detail: null },
    ],
  })

  const outcome = await runAgent({ db }, {
    agent: agentFor(mkdtempSync(join(tmpdir(), 'ws-'))),
    client: clientFor(gw),
    prompt: 'hi',
    trigger: 'manual',
  })

  assert.deepEqual(outcome.usage, { inputTokens: 300, outputTokens: 30, reasoningTokens: 5 })
  assert.equal(outcome.summary, 'step one. \nstep two.')
})

test('an errored turn is failed, and the tokens are still recorded', async () => {
  const db = makeDb()
  const gw = await boot({
    frames: [
      { kind: 'message', text: 'partial', usage: { inputTokens: 500, outputTokens: 5 } },
      { kind: 'turn_end', reason: 'error', detail: { message: 'provider refused', code: 'bad_request' } },
    ],
  })

  const outcome = await runAgent({ db }, {
    agent: agentFor(mkdtempSync(join(tmpdir(), 'ws-'))),
    client: clientFor(gw),
    prompt: 'hi',
    trigger: 'manual',
  })

  assert.equal(outcome.state, 'failed')
  assert.equal(outcome.error, 'provider refused')
  // The tokens were spent whether or not the turn succeeded.
  const usage = db.select().from(schema.usageRecord).where(eq(schema.usageRecord.runId, outcome.runId)).all()
  assert.equal(usage[0]?.inputTokens, 500)
})

test('an aborted turn is failed with the cause', async () => {
  const db = makeDb()
  const gw = await boot({
    frames: [{ kind: 'turn_end', reason: 'aborted', detail: { cause: 'user_cancelled' } }],
  })

  const outcome = await runAgent({ db }, {
    agent: agentFor(mkdtempSync(join(tmpdir(), 'ws-'))),
    client: clientFor(gw),
    prompt: 'hi',
    trigger: 'manual',
  })

  assert.equal(outcome.state, 'failed')
  assert.match(outcome.error ?? '', /aborted/)
  assert.match(outcome.error ?? '', /user_cancelled/)
})

test('a timeout cancels the turn rather than hanging', async () => {
  const db = makeDb()
  const gw = await boot({ frames: [], silent: true })

  const outcome = await runAgent({ db }, {
    agent: agentFor(mkdtempSync(join(tmpdir(), 'ws-'))),
    client: clientFor(gw),
    prompt: 'hi',
    trigger: 'manual',
    timeoutMs: 300,
  })

  assert.equal(outcome.state, 'failed')
  assert.match(outcome.error ?? '', /within 0s|no response/)
  assert.equal(gw.cancels, 1, 'the turn was cancelled')
  assert.equal(runningRunId('personal'), null, 'the lock was released')
  // And the slot went back. A stuck cron is exactly the case that used to leak:
  // it holds a session for the full timeout and then walked away from it.
  assert.deepEqual(gw.releases, ['sess-1'], 'a timed-out turn still hands the session back')
})

test('a turn that goes silent is cancelled long before the total timeout', async () => {
  const db = makeDb()
  // Starts working, then stops for good without ever sending turn_end -- what a
  // turn blocked on an unanswerable prompt looks like from here.
  const gw = await boot({ frames: [{ kind: 'tool_call', name: 'read_file', arguments: '{}' }] })

  const started = Date.now()
  const outcome = await runAgent({ db }, {
    agent: agentFor(mkdtempSync(join(tmpdir(), 'ws-'))),
    client: clientFor(gw),
    prompt: 'hi',
    trigger: 'manual',
    timeoutMs: 10_000,
    silenceMs: 250,
  })

  assert.equal(outcome.state, 'failed')
  // The whole point is that the generous total timeout is not what ended this.
  assert.ok(Date.now() - started < 5_000, 'the silence backstop fired, not the total timeout')
  assert.match(outcome.error ?? '', /nothing happened/)
  assert.match(outcome.error ?? '', /interactive question or a permission prompt/)
  assert.equal(gw.cancels, 1, 'the stalled turn was cancelled upstream')
  assert.equal(runningRunId('personal'), null, 'the lock was released')
  assert.deepEqual(gw.releases, ['sess-1'], 'the session slot went back')
})

test('a long turn that keeps producing frames is not cut off by the backstop', async () => {
  const db = makeDb()
  // Each gap is under the silence window, but the turn as a whole runs longer
  // than it: only a timer that is pushed forward by every frame survives this.
  const gw = await boot({
    gapMs: 60,
    frames: [
      { kind: 'tool_call', name: 'a', arguments: '{}' },
      { kind: 'tool_call', name: 'b', arguments: '{}' },
      { kind: 'tool_call', name: 'c', arguments: '{}' },
      { kind: 'message', text: 'done thinking', usage: { inputTokens: 5, outputTokens: 2 } },
      { kind: 'turn_end', reason: 'completed' },
    ],
  })

  const outcome = await runAgent({ db }, {
    agent: agentFor(mkdtempSync(join(tmpdir(), 'ws-'))),
    client: clientFor(gw),
    prompt: 'hi',
    trigger: 'manual',
    timeoutMs: 10_000,
    silenceMs: 150,
  })

  assert.equal(outcome.state, 'done')
  assert.equal(gw.cancels, 0, 'a productive turn is never cancelled')
  assert.match(outcome.summary, /done thinking/)
})

test('a turn waiting on a question is left alone by the backstop', async () => {
  const db = makeDb()
  // Silent for many times the window, but for a reason that is on screen: the
  // question card is open and someone is presumably reading it. Cancelling here
  // would throw the turn away while its answer was being typed.
  const gw = await boot({
    gapMs: 40,
    frames: [
      { kind: 'question_asked', questionId: 'q-1', questions: [{ id: 'a', question: 'which?' }] },
      // A gap far longer than silenceMs, then the answer arrives and the turn ends.
      { kind: 'sleep', ms: 400 },
      { kind: 'question_resolved', questionId: 'q-1', outcome: 'answered' },
      { kind: 'message', text: 'thanks', usage: { inputTokens: 1, outputTokens: 1 } },
      { kind: 'turn_end', reason: 'completed' },
    ],
  })

  const outcome = await runAgent({ db }, {
    agent: agentFor(mkdtempSync(join(tmpdir(), 'ws-'))),
    client: clientFor(gw),
    prompt: 'hi',
    trigger: 'manual',
    timeoutMs: 10_000,
    silenceMs: 120,
  })

  assert.equal(outcome.state, 'done')
  assert.equal(gw.cancels, 0, 'a turn waiting on a human is not a stalled turn')
  assert.match(outcome.summary, /thanks/)
})

test('a failure to create the session fails the run cleanly', async () => {
  const db = makeDb()
  const gw = await boot({ frames: [], failCreateStatus: 503 })

  const outcome = await runAgent({ db }, {
    agent: agentFor(mkdtempSync(join(tmpdir(), 'ws-'))),
    client: clientFor(gw),
    prompt: 'hi',
    trigger: 'manual',
  })

  assert.equal(outcome.state, 'failed')
  assert.equal(outcome.sessionId, null)
  assert.match(outcome.error ?? '', /503/)
  assert.equal(runningRunId('personal'), null)
})

test('two concurrent runs on the same agent both complete (蜂群 P5.4)', async () => {
  const db = makeDb()
  const gw = await boot({ ...SUCCESS, gapMs: 60 })
  const agent = agentFor(mkdtempSync(join(tmpdir(), 'ws-')))
  const client = clientFor(gw)

  const [a, b] = await Promise.all([
    runAgent({ db }, { agent, client, prompt: 'first', trigger: 'manual' }),
    runAgent({ db }, { agent, client, prompt: 'second', trigger: 'manual' }),
  ])

  assert.equal(a.state, 'done')
  assert.equal(b.state, 'done')
  assert.equal(activeRunCount('personal'), 0, 'both runs left the active set')
  assert.equal(runningRunId('personal'), null)

  // 两个并发 run 都留下了自己的行——不再有「一活 run」约束。
  const rows = db.select().from(schema.run).all()
  assert.equal(rows.length, 2)
})

test('the lock is released so a later run can start', async () => {
  const db = makeDb()
  const gw = await boot(SUCCESS)
  const agent = agentFor(mkdtempSync(join(tmpdir(), 'ws-')))
  const client = clientFor(gw)

  const one = await runAgent({ db }, { agent, client, prompt: 'first', trigger: 'manual' })
  const two = await runAgent({ db }, { agent, client, prompt: 'second', trigger: 'manual' })

  assert.equal(one.state, 'done')
  assert.equal(two.state, 'done')
  assert.notEqual(one.runId, two.runId)
  assert.equal(db.select().from(schema.run).all().length, 2)
})

test('a turn with no usage reported leaves no usage row and no fabricated cost', async () => {
  const db = makeDb()
  const gw = await boot({
    frames: [
      { kind: 'message', text: 'done', usage: null },
      { kind: 'turn_end', reason: 'completed', detail: null },
    ],
  })

  const outcome = await runAgent({ db }, {
    agent: agentFor(mkdtempSync(join(tmpdir(), 'ws-'))),
    client: clientFor(gw),
    prompt: 'hi',
    trigger: 'manual',
  })

  assert.equal(outcome.state, 'done')
  assert.equal(outcome.usage, null)
  assert.equal(outcome.costMicroUsd, null, 'better an honest gap than a fake zero')
  assert.equal(db.select().from(schema.usageRecord).all().length, 0)
})

test('an unknown model yields no cost rather than a wrong one', async () => {
  const db = makeDb()
  const gw = await boot({ ...SUCCESS, model: 'some-unreleased-model' })

  const outcome = await runAgent({ db }, {
    agent: agentFor(mkdtempSync(join(tmpdir(), 'ws-'))),
    client: clientFor(gw),
    prompt: 'hi',
    trigger: 'manual',
  })

  assert.equal(outcome.model, 'some-unreleased-model')
  assert.ok(outcome.usage !== null, 'tokens are still recorded')
  assert.equal(outcome.costMicroUsd, null)
})

/** A turn with two billable responses, so each can be priced at its own instant. */
const TWO_RESPONSES: FakeScript = {
  frames: [
    { kind: 'message', text: 'first', usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 } },
    { kind: 'message', text: 'second', usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 } },
    { kind: 'turn_end', reason: 'completed', detail: null },
  ],
}

// 2026-08-28 是周五（工作日）——周末全天低谷的规则见 pricing.test。
const OFF_PEAK = Date.parse('2026-08-28T12:00:00Z')
const PEAK = Date.parse('2026-08-28T02:00:00Z')
/** One million in plus one million out on deepseek-v4-pro. */
const OFF_PEAK_MICRO = 2_640_000
const PEAK_MICRO = 5_280_000

/**
 * Returns each value in turn, then sticks on the last.
 *
 * The runner reads the clock once at the start, once per billable response and
 * once at the end, which is what lets a test put two responses on opposite
 * sides of a peak boundary.
 */
const scriptedClock = (values: number[]): (() => number) => {
  let i = 0
  return () => values[Math.min(i++, values.length - 1)] ?? 0
}

test('a turn that crosses a peak boundary is billed at both rates', async () => {
  const db = makeDb()
  const gw = await boot(TWO_RESPONSES)

  // start off-peak, first response off-peak, second response after the clock
  // has rolled into a peak window, then end.
  const clock = scriptedClock([OFF_PEAK, OFF_PEAK, PEAK, PEAK])

  const outcome = await runAgent({ db, clock }, {
    agent: agentFor(mkdtempSync(join(tmpdir(), 'ws-'))),
    client: clientFor(gw),
    prompt: 'hi',
    trigger: 'manual',
  })

  assert.equal(outcome.state, 'done')
  // Pricing the whole turn at one timestamp would give 2x off-peak or 2x peak;
  // neither is what actually happened.
  assert.equal(outcome.costMicroUsd, OFF_PEAK_MICRO + PEAK_MICRO)
  assert.equal(outcome.peakCostMicroUsd, PEAK_MICRO)

  const usage = db.select().from(schema.usageRecord).all()
  assert.equal(usage[0]?.cost, OFF_PEAK_MICRO + PEAK_MICRO)
  assert.equal(usage[0]?.peakCost, PEAK_MICRO)
})

test('a turn entirely outside peak hours records no peak cost', async () => {
  const db = makeDb()
  const gw = await boot(TWO_RESPONSES)

  const outcome = await runAgent({ db, clock: scriptedClock([OFF_PEAK]) }, {
    agent: agentFor(mkdtempSync(join(tmpdir(), 'ws-'))),
    client: clientFor(gw),
    prompt: 'hi',
    trigger: 'manual',
  })

  assert.equal(outcome.costMicroUsd, OFF_PEAK_MICRO * 2)
  assert.equal(outcome.peakCostMicroUsd, 0)
})

// ---------------------------------------------------------------------------
// workspace snapshots
// ---------------------------------------------------------------------------

test('a run commits what the agent changed, with the instruction as the subject', async () => {
  const db = makeDb()
  const gw = await boot(SUCCESS)
  const workspace = makeRepo()
  const before = commitCount(workspace)

  const outcome = await runAgent({ db }, {
    agent: agentFor(workspace),
    client: clientFor(gw),
    prompt: '在工作日志里加一行今天的日期',
    trigger: 'manual',
    onFrame: writesFileOnFrame(workspace, 'log.md', '- 2026-08-30\n'),
  })

  assert.equal(outcome.state, 'done')
  assert.ok(outcome.commit !== null, 'the run produced a commit')
  assert.deepEqual(outcome.changedFiles, ['log.md'])
  assert.equal(outcome.snapshotSkipped, null)
  assert.equal(commitCount(workspace), before + 1, 'exactly one commit')

  // The subject is what makes `git log --oneline` an audit trail worth reading.
  const subject = git(workspace, 'log', '-1', '--pretty=%s').trim()
  assert.ok(subject.includes('在工作日志里加一行今天的日期'), `subject was: ${subject}`)
  const body = git(workspace, 'log', '-1', '--pretty=%b')
  assert.ok(body.includes(outcome.runId), 'the run id is traceable from the commit')
  assert.equal(git(workspace, 'status', '--short').trim(), '', 'workspace is clean afterwards')

  // Persisted, because a cron run returns its outcome to nobody.
  const stored = db.select().from(schema.run).where(eq(schema.run.id, outcome.runId)).all()
  assert.equal(stored[0]?.commitHash, outcome.commit)
})

test('pre-existing uncommitted work gets its own commit, so the agent’s can be reverted alone', async () => {
  const db = makeDb()
  const gw = await boot(SUCCESS)
  const workspace = makeRepo()
  // The operator was editing a note by hand and never committed it.
  writeFileSync(join(workspace, 'my-draft.md'), 'half a thought\n', 'utf8')
  const before = commitCount(workspace)

  const outcome = await runAgent({ db }, {
    agent: agentFor(workspace),
    client: clientFor(gw),
    prompt: '整理交易快照',
    trigger: 'manual',
    onFrame: writesFileOnFrame(workspace, 'agent-output.md', 'written by the agent\n'),
  })

  assert.equal(commitCount(workspace), before + 2, 'one commit for the draft, one for the agent')
  // The whole point: reverting the agent must not take the draft with it.
  assert.deepEqual(outcome.changedFiles, ['agent-output.md'])
  const files = git(workspace, 'show', '--name-only', '--pretty=format:', 'HEAD').trim().split('\n')
  assert.deepEqual(files, ['agent-output.md'], 'the agent’s commit contains only the agent’s file')
})

test('a run that changes nothing produces no commit', async () => {
  const db = makeDb()
  const gw = await boot(SUCCESS)
  const workspace = makeRepo()
  const before = commitCount(workspace)

  const outcome = await runAgent({ db }, {
    agent: agentFor(workspace),
    client: clientFor(gw),
    prompt: '看一下工作日志最后一行写了什么',
    trigger: 'manual',
  })

  assert.equal(outcome.state, 'done')
  assert.equal(outcome.commit, null, 'a read-only turn must not leave an empty commit')
  assert.deepEqual(outcome.changedFiles, [])
  assert.equal(commitCount(workspace), before)
})

test('a workspace that is not a git repository does not fail the run', async () => {
  // The turn already happened and already cost money. A missing audit trail is
  // worth a warning, never a lost run.
  const db = makeDb()
  const gw = await boot(SUCCESS)
  const workspace = mkdtempSync(join(tmpdir(), 'ws-plain-'))

  const outcome = await runAgent({ db }, {
    agent: agentFor(workspace),
    client: clientFor(gw),
    prompt: 'hi',
    trigger: 'manual',
  })

  assert.equal(outcome.state, 'done', 'the run still succeeded')
  assert.equal(outcome.commit, null)
  assert.ok(outcome.snapshotSkipped !== null, 'and it says why there is no commit')
  assert.match(outcome.snapshotSkipped, /not a git repository/)
})

test('a failed turn still commits what the agent wrote', async () => {
  // An agent that wrote files and then errored has changed the workspace.
  // Leaving that uncommitted is how work gets silently lost.
  const db = makeDb()
  const gw = await boot({
    frames: [
      { kind: 'message', text: '写了一半', usage: { inputTokens: 10, outputTokens: 2 } },
      { kind: 'turn_end', reason: 'error', detail: { message: 'model exploded' } },
    ],
  })
  const workspace = makeRepo()
  const before = commitCount(workspace)

  const outcome = await runAgent({ db }, {
    agent: agentFor(workspace),
    client: clientFor(gw),
    prompt: '更新持仓',
    trigger: 'cron',
    onFrame: writesFileOnFrame(workspace, 'partial.md', 'half written\n'),
  })

  assert.equal(outcome.state, 'failed')
  assert.ok(outcome.commit !== null, 'the half-finished work was still committed')
  assert.deepEqual(outcome.changedFiles, ['partial.md'])
  assert.equal(commitCount(workspace), before + 1)
  // Anyone reading the log must be able to see this file may be incomplete.
  const body = git(workspace, 'log', '-1', '--pretty=%b')
  assert.ok(body.includes('failed'), `body was: ${body}`)
})

test('refuses to proceed when the gateway places the session elsewhere', async () => {
  // `cwd` is only the session's working directory; the real sandbox boundary is
  // the DSH process's own workspaceRoot, and `workspaceMode: 'auto'` can remap
  // cwd to a workspace's canonical path. If that happens the agent would be
  // writing somewhere nobody asked for, so the run must stop.
  const db = makeDb()
  const elsewhere = mkdtempSync(join(tmpdir(), 'somewhere-else-'))
  const gw = await boot({ ...SUCCESS, overrideCwd: elsewhere })

  const outcome = await runAgent({ db }, {
    agent: agentFor(mkdtempSync(join(tmpdir(), 'ws-'))),
    client: clientFor(gw),
    prompt: 'hi',
    trigger: 'manual',
  })

  assert.equal(outcome.state, 'failed')
  assert.match(outcome.error ?? '', /instead of/)
  assert.equal(gw.messages.length, 0, 'no instruction was ever delivered')
})

test('a cwd spelled differently but pointing at the same directory is accepted', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'ws-'))
  const db = makeDb()
  // A trailing separator and a redundant segment denote the same directory; a
  // naive string comparison would reject every run on Windows.
  const gw = await boot({ ...SUCCESS, overrideCwd: join(workspace, 'sub', '..') })

  const outcome = await runAgent({ db }, {
    agent: agentFor(workspace),
    client: clientFor(gw),
    prompt: 'hi',
    trigger: 'manual',
  })

  assert.equal(outcome.state, 'done')
})

// ---------------------------------------------------------------------------
// session lifecycle
//
// Sessions are capped on the gateway by `maxSessions`. A one-shot turn that
// keeps its slot never gives it back, and once the cap is reached the gateway
// can neither create a session nor adopt one -- so leaking here eventually
// takes the conversations down too, not just the crons.
// ---------------------------------------------------------------------------

test('a one-shot run hands its session back', async () => {
  const db = makeDb()
  const gw = await boot(SUCCESS)

  const outcome = await runAgent({ db }, {
    agent: agentFor(mkdtempSync(join(tmpdir(), 'ws-'))),
    client: clientFor(gw),
    prompt: 'hi',
    trigger: 'cron',
  })

  assert.equal(outcome.state, 'done')
  assert.deepEqual(gw.releases, ['sess-1'])
})

test('a conversation keeps its session instead of handing it back', async () => {
  // Releasing after every turn would make the next message pay for a cold
  // resume, which is slower and re-reads the whole transcript.
  const db = makeDb()
  const gw = await boot(SUCCESS)

  const outcome = await runAgent({ db }, {
    agent: agentFor(mkdtempSync(join(tmpdir(), 'ws-'))),
    client: clientFor(gw),
    prompt: 'hi',
    trigger: 'manual',
    keepSession: true,
  })

  assert.equal(outcome.state, 'done')
  assert.deepEqual(gw.releases, [], 'the slot is still held for the next turn')
})

test('a released session can still be continued', async () => {
  // Releasing is not deleting: the gateway keeps the transcript, so the session
  // goes cold rather than away and `adopt` brings it back. This is what makes it
  // safe to release aggressively.
  const db = makeDb()
  const gw = await boot(SUCCESS)
  const agent = agentFor(mkdtempSync(join(tmpdir(), 'ws-')))
  const client = clientFor(gw)

  const first = await runAgent({ db }, { agent, client, prompt: 'a', trigger: 'cron' })
  assert.deepEqual(gw.releases, ['sess-1'], 'the first run gave the slot up')

  const second = await runAgent({ db }, { agent, client, prompt: 'b', trigger: 'manual', sessionId: first.sessionId })

  assert.equal(second.state, 'done', second.error ?? '')
  assert.equal(second.sessionId, first.sessionId, 'the same conversation, not a new one')
  assert.deepEqual(gw.adopts, ['sess-1'], 'it was adopted back rather than recreated')
  const creates = gw.calls.filter((c) => c.path === '/sessions' && c.method === 'POST')
  assert.equal(creates.length, 1)
})

test('a failure to hand the session back does not fail the run', async () => {
  // The turn already ran and was already paid for. Losing that outcome over a
  // cleanup error would be strictly worse than a slot held until DSH restarts,
  // which the log records and a restart recovers.
  const db = makeDb()
  const gw = await boot({ ...SUCCESS, failReleaseStatus: 500 })
  const warnings: string[] = []

  const outcome = await runAgent(
    { db, log: { info: () => {}, warn: (m) => warnings.push(m), error: () => {} } },
    {
      agent: agentFor(mkdtempSync(join(tmpdir(), 'ws-'))),
      client: clientFor(gw),
      prompt: 'hi',
      trigger: 'cron',
    },
  )

  assert.equal(outcome.state, 'done', 'the turn stands')
  assert.ok(outcome.usage !== null, 'and it is still billed')
  assert.ok(
    warnings.some((w) => w.includes('maxSessions')),
    `the leak is reported; warnings were: ${warnings.join(' | ')}`,
  )
})

test('a run that never got a session releases nothing', async () => {
  const db = makeDb()
  const gw = await boot({ frames: [], failCreateStatus: 503 })

  const outcome = await runAgent({ db }, {
    agent: agentFor(mkdtempSync(join(tmpdir(), 'ws-'))),
    client: clientFor(gw),
    prompt: 'hi',
    trigger: 'manual',
  })

  assert.equal(outcome.state, 'failed')
  assert.deepEqual(gw.releases, [])
  assert.equal(
    gw.calls.filter((c) => c.method === 'DELETE').length,
    0,
    'no id to release, so no pointless round trip',
  )
})

test('the run row exists while the run is in flight', async () => {
  const db = makeDb()
  const gw = await boot({ ...SUCCESS, gapMs: 50 })
  const agent = agentFor(mkdtempSync(join(tmpdir(), 'ws-')))

  const pending = runAgent({ db }, { agent, client: clientFor(gw), prompt: 'hi', trigger: 'manual' })
  await new Promise((r) => setTimeout(r, 40))

  const live = db.select().from(schema.run).where(eq(schema.run.state, 'running')).all()
  assert.equal(live.length, 1, 'a crash mid-run would still leave a trace')
  assert.equal(runningRunId('personal'), live[0]?.id)

  await pending
})

test('债务 A2 回归: usage 记账落库失败 → run 不落 done 半态,降级 failed 且账目缺口显性', async () => {
  // 自建 db(需要 sqlite 句柄注入触发器):usage_record 插入即抛 = 磁盘满/约束冲突的真实失败路径
  const dir = mkdtempSync(join(tmpdir(), 'runner-db-'))
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

  const gw = await boot(SUCCESS)
  const workspace = mkdtempSync(join(tmpdir(), 'ws-'))

  // 修复前:usage 插入失败直接抛出,run 行停留在中间态(旧代码先写 done 后写 usage);
  // 修复后:事务回滚 + 降级 failed,run 行有终态且账目缺口在 error 显性可见。
  const outcome = await runAgent({ db }, {
    agent: agentFor(workspace),
    client: clientFor(gw),
    prompt: '在工作日志里加一行今天的日期',
    trigger: 'manual',
  })

  assert.equal(outcome.state, 'failed')
  assert.match(outcome.error ?? '', /记账失败/)
  const rows = db.select().from(schema.run).where(eq(schema.run.id, outcome.runId)).all()
  assert.equal(rows[0]?.state, 'failed', 'run 行必须落在 failed 终态,不能停留在 running/done 半态')
  assert.match(rows[0]?.error ?? '', /记账失败/)
  assert.equal(
    db.select().from(schema.usageRecord).where(eq(schema.usageRecord.runId, outcome.runId)).all().length,
    0,
    '事务回滚后 usage 无残留行',
  )
})
