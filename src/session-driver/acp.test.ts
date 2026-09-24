/**
 * ACP 窄桥（插头二）验收：假 ACP agent（SDK agent() 内嵌，进程内 connect）
 * 驱动 AcpSessionDriver 九操作 + runner 拔插头复跑（上层零改动）。
 * 窄面声明同步实测：history 空、问题面 not-pending、usage 缺省不计费。
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
// 债务 C3:makeDb/agentFor 收敛进 test-harness(本地保留别名,行为不变)。
import { makeDb as makeHarnessDb, personalAgent } from '../test-harness.js'

interface FakeAcpOptions {
  chunks?: string[]
  stopReason?: StopReason
  permission?: { options: Array<{ optionId: string; kind: PermissionOptionKind }> }
}

/**
 * 假 ACP agent：prompt 时经 client 面推 agent_message_chunk ×N，再回
 * PromptResponse；开 permission 时先向 client 发 request_permission 并
 * 把收到的 outcome 记下，再正常收尾。
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
    for (const chunk of opts.chunks ?? ['收到。']) {
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

test('插头二九操作：probe/create/subscribe/prompt 帧泵/history/release', async () => {
  const { driver } = driverFor({ chunks: ['你', '好'] })
  assert.equal(await driver.probeVersion(), '1', 'ACP 协议版本（仅展示语义，同 DSH-FACTS §6 纪律）')
  const created = await driver.createSession('C:/ws')
  assert.equal(created.sessionId, 'acp-session-1')
  assert.equal(created.preset, null, '窄面：无 preset')

  const seen: string[] = []
  const unsub = driver.subscribe(created.sessionId, (_sid, frame) => seen.push(frame.kind))
  const accepted = await driver.prompt(created.sessionId, '打个招呼')
  assert.deepEqual(accepted, { accepted: true })
  assert.deepEqual(seen, ['chunk', 'chunk', 'message', 'turn_end'], 'chunk×2 → message(累计) → turn_end')
  unsub()

  const history = await driver.history(created.sessionId)
  assert.deepEqual(history.events, [], '窄面：ACP 无 transcript replay')
  assert.equal(history.sessionState, 'cold')
  await driver.release(created.sessionId)
})

test('插头二：cancelled stop → turn_end aborted', async () => {
  const { driver } = driverFor({ stopReason: 'cancelled' })
  const created = await driver.createSession('C:/ws')
  const seen: string[] = []
  driver.subscribe(created.sessionId, (_sid, frame) => {
    if (frame.kind === 'turn_end') seen.push(String(frame.reason))
  })
  await driver.prompt(created.sessionId, 'x')
  assert.deepEqual(seen, ['aborted'])
})

test('插头二权限流：approval_pending 帧 → decideApproval → agent 收到 optionId', async () => {
  const { driver, decisions } = driverFor({
    chunks: [],
    permission: { options: [{ optionId: 'allow-1', kind: 'allow_once' }, { optionId: 'reject-1', kind: 'reject_once' }] },
  })
  const created = await driver.createSession('C:/ws')
  let pending: { decisionId: string } | null = null
  driver.subscribe(created.sessionId, (_sid, frame) => {
    if (frame.kind === 'approval_pending') pending = { decisionId: frame.decisionId as string }
  })
  const promptDone = driver.prompt(created.sessionId, '写文件')
  // 等 approval_pending 帧到达（prompt 被权限请求挂起）。
  for (let i = 0; i < 50 && pending === null; i += 1) await new Promise((r) => setTimeout(r, 10))
  if (pending === null) throw new Error('approval_pending frame never arrived')
  const decisionId = (pending as { decisionId: string }).decisionId
  const receipt = await driver.decideApproval(decisionId, created.sessionId, decisionId, 'allowed-once')
  assert.deepEqual(receipt, { accepted: true })
  await promptDone
  assert.deepEqual(decisions, [{ optionId: 'allow-1', cancelled: false }], 'allowed-once → allow_once 选项')
  // 错配 rpcId = not-pending
  assert.deepEqual(await driver.decideApproval('nope', created.sessionId, 'nope', 'rejected'), { accepted: false, reason: 'not-pending' })
  // 窄面：问题面不存在
  assert.deepEqual(await driver.answerQuestion('q', created.sessionId, {}), { accepted: false, reason: 'not-pending' })
  assert.deepEqual(await driver.declineQuestion('q', created.sessionId), { accepted: false, reason: 'not-pending' })
})

test('拔插头复跑：runner 经 ACP 驱动跑完整回合，上层零改动', async () => {
  const db = makeDb()
  const { driver } = driverFor({ chunks: ['收到。'] })
  const workspace = mkdtempSync(join(tmpdir(), 'acp-ws-'))

  const outcome = await runAgent({ db }, {
    agent: agentFor(workspace),
    client: dummyClient(),
    upstream: driver,
    driver: 'apiproxy',
    prompt: '只回复：收到',
    trigger: 'manual',
  })

  assert.equal(outcome.state, 'done')
  assert.equal(outcome.sessionId, 'acp-session-1')
  assert.equal(outcome.reason, 'completed')
  assert.equal(outcome.summary, '收到。', '累计文本经 message 帧成为回合摘要')
  assert.equal(outcome.usage, null, '窄面：无逐回合 token 用量，不计费')
  const run = db.select().from(schema.run).where(eq(schema.run.id, outcome.runId)).all()[0]
  assert.equal(run?.state, 'done')
})
