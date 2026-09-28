/**
 * ACP narrow bridge (plug two) acceptance: a fake ACP agent (SDK agent() inlined, connected in process)
 * drives AcpSessionDriver's nine operations plus a runner re-run on the swapped plug (nothing changed upstairs).
 * The narrow-surface claims are checked against reality: empty history, not-pending question surface, usage absent so no billing.
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { eq } from 'drizzle-orm'
import { agent, type AgentApp, type RequestPermissionRequest, type RequestPermissionResponse, type SessionUpdate, type StopReason, type PermissionOptionKind } from '@agentclientprotocol/sdk'
import { schema, type Db } from '../db/index.js'
import { GatewayClient } from '../gateway/client.js'
import { runAgent } from '../runner.js'
import { AcpSessionDriver } from './acp.js'
// Debt C3: makeDb/agentFor moved into the test harness (local aliases kept, behavior unchanged).
import { makeDb as makeHarnessDb, personalAgent } from '../test-harness.js'

interface FakeAcpOptions {
  chunks?: string[]
  stopReason?: StopReason
  permission?: { options: Array<{ optionId: string; kind: PermissionOptionKind }> }
}

/**
 * A fake ACP agent: on prompt it pushes agent_message_chunk xN through the client surface and then returns a
 * PromptResponse; with permission on it first sends request_permission to the client, records the outcome it
 * gets back, and then finishes normally.
 */
const fakeAcpAgent = (opts: FakeAcpOptions = {}): { app: AgentApp; decisions: Array<{ optionId?: string; cancelled: boolean }> } => {
  const decisions: Array<{ optionId?: string; cancelled: boolean }> = []
  const app = agent()
  app.onRequest('initialize', async () => ({ protocolVersion: 1 }))
  app.onRequest('session/new', async ({ params }) => ({ sessionId: 'acp-session-1', cwd: params.cwd }))
  app.onRequest('session/prompt', async (context) => {
    const sessionId = context.params.sessionId
    const notify = async (update: SessionUpdate): Promise<void> => {
      await context.client.notify('session/update', { sessionId, update })
    }
    if (opts.permission !== undefined) {
      const response = await context.client.request<
        RequestPermissionResponse, RequestPermissionRequest
      >('session/request_permission', {
        sessionId,
        toolCall: { toolCallId: 't1', title: 'shell write' },
        options: opts.permission.options.map((o) => ({ optionId: o.optionId, label: o.optionId, name: o.optionId, kind: o.kind })),
      })
      if (response.outcome.outcome === 'selected') decisions.push({ optionId: response.outcome.optionId, cancelled: false })
      else decisions.push({ cancelled: true })
    }
    for (const chunk of opts.chunks ?? ['understood.']) {
      await notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } })
    }
    return { stopReason: opts.stopReason ?? 'end_turn' }
  })
  return { app, decisions }
}

const driverFor = (opts: FakeAcpOptions): { driver: AcpSessionDriver; decisions: Array<{ optionId?: string; cancelled: boolean }> } => {
  const { app, decisions } = fakeAcpAgent(opts)
  const driver = new AcpSessionDriver('acp', async (clientApp) => clientApp.connect(app))
  return { driver, decisions }
}

const makeDb = (): Db => makeHarnessDb().db

const agentFor = personalAgent

const dummyClient = (): GatewayClient =>
  new GatewayClient({ id: 'A', url: 'http://127.0.0.1:1', driver: 'apiproxy', prefix: '/api', key: '', sandboxBase: null, sandboxKey: '', spawn: null, access: null })

test('Plug two, nine operations: probe/create/subscribe/prompt frame pump/history/release', async () => {
  const { driver } = driverFor({ chunks: ['under', 'stood'] })
  assert.equal(await driver.probeVersion(), '1', 'the ACP protocol version (display semantics only, per the DSH-FACTS §6 discipline)')
  const created = await driver.createSession('C:/ws')
  assert.equal(created.sessionId, 'acp-session-1')
  assert.equal(created.preset, null, 'narrow surface: no preset')

  const seen: string[] = []
  const unsub = driver.subscribe(created.sessionId, (_sid, frame) => seen.push(frame.kind))
  const accepted = await driver.prompt(created.sessionId, 'say hello')
  assert.deepEqual(accepted, { accepted: true })
  assert.deepEqual(seen, ['chunk', 'chunk', 'message', 'turn_end'], 'chunk x2 -> message (accumulated) -> turn_end')
  unsub()

  const history = await driver.history(created.sessionId)
  assert.deepEqual(history.events, [], 'narrow surface: ACP has no transcript replay')
  assert.equal(history.sessionState, 'cold')
  await driver.release(created.sessionId)
})

test('Plug two: a cancelled stop -> turn_end aborted', async () => {
  const { driver } = driverFor({ stopReason: 'cancelled' })
  const created = await driver.createSession('C:/ws')
  const seen: string[] = []
  driver.subscribe(created.sessionId, (_sid, frame) => {
    if (frame.kind === 'turn_end') seen.push(String(frame.reason))
  })
  await driver.prompt(created.sessionId, 'x')
  assert.deepEqual(seen, ['aborted'])
})

test('Plug two permission flow: approval_pending frame -> decideApproval -> the agent receives the optionId', async () => {
  const { driver, decisions } = driverFor({
    chunks: [],
    permission: { options: [{ optionId: 'allow-1', kind: 'allow_once' }, { optionId: 'reject-1', kind: 'reject_once' }] },
  })
  const created = await driver.createSession('C:/ws')
  let pending: { decisionId: string } | null = null
  driver.subscribe(created.sessionId, (_sid, frame) => {
    if (frame.kind === 'approval_pending') pending = { decisionId: frame.decisionId as string }
  })
  const promptDone = driver.prompt(created.sessionId, 'write a file')
  // Wait for the approval_pending frame to arrive (the prompt is suspended on the permission request).
  for (let i = 0; i < 50 && pending === null; i += 1) await new Promise((r) => setTimeout(r, 10))
  if (pending === null) throw new Error('approval_pending frame never arrived')
  const decisionId = (pending as { decisionId: string }).decisionId
  const receipt = await driver.decideApproval(decisionId, created.sessionId, decisionId, 'allowed-once')
  assert.deepEqual(receipt, { accepted: true })
  await promptDone
  assert.deepEqual(decisions, [{ optionId: 'allow-1', cancelled: false }], 'allowed-once -> the allow_once option')
  // A mismatched rpcId = not-pending
  assert.deepEqual(await driver.decideApproval('nope', created.sessionId, 'nope', 'rejected'), { accepted: false, reason: 'not-pending' })
  // Narrow surface: there is no question surface
  assert.deepEqual(await driver.answerQuestion('q', created.sessionId, {}), { accepted: false, reason: 'not-pending' })
  assert.deepEqual(await driver.declineQuestion('q', created.sessionId), { accepted: false, reason: 'not-pending' })
})

test('Re-run on the swapped plug: the runner drives a whole turn through ACP with nothing changed upstairs', async () => {
  const db = makeDb()
  const { driver } = driverFor({ chunks: ['understood.'] })
  const workspace = mkdtempSync(join(tmpdir(), 'acp-ws-'))

  const outcome = await runAgent({ db }, {
    agent: agentFor(workspace),
    client: dummyClient(),
    upstream: driver,
    driver: 'apiproxy',
    prompt: 'reply with just: understood',
    trigger: 'manual',
  })

  assert.equal(outcome.state, 'done')
  assert.equal(outcome.sessionId, 'acp-session-1')
  assert.equal(outcome.reason, 'completed')
  assert.equal(outcome.summary, 'understood.', 'the accumulated text becomes the turn summary through the message frame')
  assert.equal(outcome.usage, null, 'narrow surface: no per-turn token usage, so no billing')
  const run = db.select().from(schema.run).where(eq(schema.run.id, outcome.runId)).all()[0]
  assert.equal(run?.state, 'done')
})
