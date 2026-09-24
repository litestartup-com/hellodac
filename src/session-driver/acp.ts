/**
 * AcpSessionDriver —— SessionDriver 插头二（ACP 窄桥，TRANSLATOR-OPTIONS §5/§6
 * 拍板「窄桥提前建」）。北向 = manager 上层（端口），南向 = 官方 ACP
 * （JSON-RPC over stdio，`dsh --profile acp` 子进程）。
 *
 * 桥的形态 = 中继：SDK 自带完整客户端（ClientApp/ActiveSession），本件只做
 * 「ACP 面 ↔ 端口九操作」的窄面映射。**窄面声明**（不承担全能力，入档）：
 * - 无 transcript replay：history 恒返回空事件（cold）——ACP 没有回放面；
 * - 无问题（ask_user_question）：ACP 只有工具权限（request_permission），
 *   一律映射为老 approval_pending 帧；answerQuestion/declineQuestion 恒
 *   not-pending；
 * - 无沙箱钉模式：setSandboxMode 不实现（端口可选能力）；
 * - 无 fork/rename/steer 等全能力（facade 主通道的功能面不动摇）。
 *
 * 帧翻译（SessionUpdate → GatewayFrame）：
 * - agent_message_chunk → 'chunk'（text-delta）；累计文本在 stop 时合成一条
 *   'message' 帧（usage 取 usage_update 的最近值，缺省不报）；
 * - tool_call → 'tool_call'（title/name → name；ACP 初始帧无参数正文）；
 * - stop → 'turn_end'（StopReason：end_turn→completed、cancelled→aborted、
 *   其余→completed）。
 *
 * 权限流：ACP agent 发 `session/request_permission` → 驱动铸 rpcId →
 * 广播老 approval_pending 帧 + 挂起 → manager decideApproval 到达 →
 * 按 outcome 选 option（allowed-once→allow_once、rejected→reject_once，
 * 缺对应 option 退化 cancelled）回应。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import {
  client, PROTOCOL_VERSION, ndJsonStream,
  type ActiveSession, type ClientApp, type ClientConnection,
  type RequestPermissionOutcome, type SessionUpdate,
} from '@agentclientprotocol/sdk'
import type { SessionDriver } from './port.js'
import type { MuxListener } from '../upstream/mux.js'
import type { UpstreamCreatedSession, UpstreamSessionHistory } from '../upstream/client.js'
import type { RpcReceipt } from '../upstream/respond.js'
import type { GatewayFrame } from '../gateway/stream.js'

/** 把驱动持有的 ClientApp 接到一条 ACP 连接上（生产 = 子进程 stdio；测试 = 进程内 agent app）。 */
export type AcpOpen = (app: ClientApp) => Promise<ClientConnection>

/** 生产传输：spawn `dsh --profile acp`，stdio 换行 JSON 帧成 Stream。 */
export const acpSubprocessOpen = (
  command: string,
  args: string[],
  env: Record<string, string>,
): AcpOpen => {
  let child: ChildProcess | null = null
  return async (app) => {
    if (child !== null) throw new Error('acp: transport already opened')
    child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin as unknown as Writable),
      Readable.toWeb(child.stdout as unknown as Readable),
    )
    const connection = app.connect(stream)
    void connection.closed.then(() => { child = null })
    return connection
  }
}

interface PendingPermission {
  rpcId: string
  approvalId: string
  sessionId: string
  options: Array<{ optionId: string; kind: string }>
  resolve: (outcome: RequestPermissionOutcome) => void
}

interface SessionEntry {
  active: ActiveSession
  listeners: Set<MuxListener>
  text: string
  stopped: boolean
}

let seqCounter = 0
const nextSeq = (): number => ++seqCounter

const textOf = (content: unknown): string => {
  if (content !== null && typeof content === 'object') {
    const block = content as { type?: unknown; text?: unknown }
    if (block.type === 'text' && typeof block.text === 'string') return block.text
  }
  return ''
}

const stopReasonToTurnReason = (stop: string): string => {
  if (stop === 'end_turn') return 'completed'
  if (stop === 'cancelled') return 'aborted'
  return 'completed' // max_tokens / max_turn_requests / refusal：窄面映射为 completed
}

export class AcpSessionDriver implements SessionDriver {
  readonly id: string
  private connection: ClientConnection | null = null
  private opening: Promise<ClientConnection> | null = null
  private readonly sessions = new Map<string, SessionEntry>()
  private readonly pendingPermissions = new Map<string, PendingPermission>()

  constructor(id: string, private readonly open: AcpOpen) {
    this.id = id
  }

  private async ensure(): Promise<ClientConnection> {
    if (this.connection !== null) return this.connection
    if (this.opening === null) {
      this.opening = (async () => {
        // 驱动持有 ClientApp：权限 handler 必须注册在连接用的同一实例上。
        const app: ClientApp = client()
        app.onRequest('session/request_permission', async (context) => {
          const params = context.params
          const rpcId = `acp-${Date.now()}-${nextSeq()}`
          const sessionId = params.sessionId
          const options = (params.options ?? []).map((o) => ({ optionId: o.optionId, kind: o.kind }))
          const outcome = await new Promise<RequestPermissionOutcome>((resolve) => {
            this.pendingPermissions.set(rpcId, { rpcId, approvalId: rpcId, sessionId, options, resolve })
            const frame: GatewayFrame = {
              kind: 'approval_pending',
              seq: nextSeq(),
              decisionId: rpcId,
              approvalId: rpcId,
              toolName: typeof params.toolCall.title === 'string' ? params.toolCall.title : '',
              reason: null,
            }
            for (const listener of this.sessions.get(sessionId)?.listeners ?? []) listener(sessionId, frame)
          })
          this.pendingPermissions.delete(rpcId)
          return { outcome }
        })
        const connection = await this.open(app)
        this.connection = connection
        return connection
      })()
    }
    return this.opening
  }

  async createSession(cwd: string, _preset?: string | null): Promise<UpstreamCreatedSession> {
    const connection = await this.ensure()
    const active = await connection.agent.buildSession(cwd).start()
    const entry: SessionEntry = { active, listeners: new Set(), text: '', stopped: false }
    this.sessions.set(active.sessionId, entry)
    void this.pump(entry)
    return { sessionId: active.sessionId, preset: null, provider: null, model: null }
  }

  async prompt(sessionId: string, text: string): Promise<{ accepted: boolean }> {
    const entry = this.sessions.get(sessionId)
    if (entry === undefined) throw new Error(`acp: unknown session ${sessionId}`)
    await entry.active.prompt([{ type: 'text', text }])
    return { accepted: true }
  }

  subscribe(sessionId: string, listener: MuxListener): () => void {
    const entry = this.sessions.get(sessionId)
    if (entry === undefined) return () => {}
    entry.listeners.add(listener)
    return () => { entry.listeners.delete(listener) }
  }

  async history(sessionId: string): Promise<UpstreamSessionHistory> {
    // 窄面：ACP 无 transcript replay，也无 goal 投影。
    return { sessionId, sessionState: 'cold', title: null, events: [], composer: { model: null, context: null, accessMode: null }, goal: null }
  }

  async cancel(sessionId: string): Promise<void> {
    const connection = this.connection
    if (connection !== null) await connection.agent.notify('session/cancel', { sessionId })
  }

  async answerQuestion(_rpcId: string, _sessionId: string, _answer: unknown): Promise<RpcReceipt> {
    // 窄面：ACP 无问题面（只有工具权限）。
    return { accepted: false, reason: 'not-pending' }
  }

  async declineQuestion(_rpcId: string, _sessionId: string): Promise<RpcReceipt> {
    return { accepted: false, reason: 'not-pending' }
  }

  async decideApproval(
    rpcId: string,
    sessionId: string,
    approvalId: string,
    outcome: 'allowed-once' | 'rejected',
  ): Promise<RpcReceipt> {
    const pending = this.pendingPermissions.get(rpcId)
    if (pending === undefined || pending.sessionId !== sessionId || pending.approvalId !== approvalId) {
      return { accepted: false, reason: 'not-pending' }
    }
    const wanted = outcome === 'allowed-once' ? 'allow_once' : 'reject_once'
    const option = pending.options.find((o) => o.kind === wanted)
    if (option === undefined) {
      pending.resolve({ outcome: 'cancelled' })
      return { accepted: true }
    }
    pending.resolve({ outcome: 'selected', optionId: option.optionId })
    return { accepted: true }
  }

  async release(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId)
    if (entry === undefined) return
    this.sessions.delete(sessionId)
    entry.active.dispose()
  }

  async probeVersion(): Promise<string> {
    await this.ensure()
    return String(PROTOCOL_VERSION)
  }

  private async pump(entry: SessionEntry): Promise<void> {
    try {
      for (;;) {
        const message = await entry.active.nextUpdate()
        if (message.kind === 'stop') {
          entry.stopped = true
          if (entry.text !== '') {
            const frame: GatewayFrame = {
              kind: 'message', seq: nextSeq(), text: entry.text, reasoning: null, usage: undefined,
            }
            this.emit(entry, frame)
          }
          const end: GatewayFrame = {
            kind: 'turn_end', seq: nextSeq(), turn: 1,
            reason: stopReasonToTurnReason(message.stopReason), detail: null,
          }
          this.emit(entry, end)
          return
        }
        for (const frame of this.framesOf(message.update, entry)) this.emit(entry, frame)
      }
    } catch {
      // 连接关闭时 nextUpdate 抛错：pump 终止，停止帧不再投递（上层超时兜底）。
    }
  }

  private emit(entry: SessionEntry, frame: GatewayFrame): void {
    for (const listener of entry.listeners) listener(entry.active.sessionId, frame)
  }

  private framesOf(update: SessionUpdate, entry: SessionEntry): GatewayFrame[] {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = textOf(update.content)
        if (text === '') return []
        entry.text += text
        return [{ kind: 'chunk', seq: nextSeq(), chunk: { type: 'text-delta', text } }]
      }
      case 'tool_call':
        return [{
          kind: 'tool_call', seq: nextSeq(),
          name: typeof update.name === 'string' ? update.name : update.title,
          arguments: '',
        }]
      case 'usage_update':
        // 窄面：ACP 的 usage_update 是上下文窗/成本（used/size/cost），不是
        // 逐回合 token 用量——message 帧 usage 恒缺省，runner 不计费（入档）。
        return []
      default:
        return []
    }
  }
}
