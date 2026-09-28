/**
 * AcpSessionDriver -- SessionDriver plug two (the ACP narrow bridge; TRANSLATOR-OPTIONS sections 5 and 6
 * settled on "build the narrow bridge early"). Northbound = the manager's upper layer (the port), southbound = the official ACP
 * (JSON-RPC over stdio, a `dsh --profile acp` child process).
 *
 * The shape of the bridge = a relay: the SDK already ships a complete client (ClientApp/ActiveSession), so this file only does
 * the narrow mapping "the ACP surface <-> the port's nine operations". **The narrow-surface declaration** (it does not carry full capability; on record):
 * - no transcript replay: history always returns empty events (cold) -- ACP has no replay surface;
 * - no questions (ask_user_question): ACP has tool permissions only (request_permission), so they
 *   all map to the old approval_pending frame; answerQuestion/declineQuestion always report
 *   not-pending;
 * - no pinned sandbox mode: setSandboxMode is not implemented (an optional port capability);
 * - no full capabilities such as fork/rename/steer (the facade's main channel keeps its feature surface unchanged).
 *
 * Frame translation (SessionUpdate -> GatewayFrame):
 * - agent_message_chunk -> 'chunk' (text-delta); the accumulated text is synthesized into one
 *   'message' frame at stop (usage takes the latest usage_update value, and stays unreported when absent);
 * - tool_call -> 'tool_call' (title/name -> name; an ACP initial frame has no argument body);
 * - stop -> 'turn_end' (StopReason: end_turn->completed, cancelled->aborted,
 *   anything else -> completed).
 *
 * The permission flow: the ACP agent sends `session/request_permission` -> the driver mints an rpcId ->
 * it broadcasts the old approval_pending frame and suspends -> the manager's decideApproval arrives ->
 * it picks the option by outcome (allowed-once->allow_once, rejected->reject_once, and
 * falls back to cancelled when the matching option is missing) and answers.
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

/** Attach the ClientApp the driver holds to one ACP connection (in production = the child process stdio; in tests = an in-process agent app). */
export type AcpOpen = (app: ClientApp) => Promise<ClientConnection>

/** The production transport: spawn `dsh --profile acp` and turn the stdio newline-delimited JSON frames into a Stream. */
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
  return 'completed' // max_tokens / max_turn_requests / refusal: the narrow surface maps them to completed
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
        // The driver holds the ClientApp: the permission handler must be registered on the same instance the connection uses.
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
    // Narrow surface: ACP has no transcript replay, and no goal projection either.
    return { sessionId, sessionState: 'cold', title: null, events: [], composer: { model: null, context: null, accessMode: null }, goal: null }
  }

  async cancel(sessionId: string): Promise<void> {
    const connection = this.connection
    if (connection !== null) await connection.agent.notify('session/cancel', { sessionId })
  }

  async answerQuestion(_rpcId: string, _sessionId: string, _answer: unknown): Promise<RpcReceipt> {
    // Narrow surface: ACP has no question surface (tool permissions only).
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
      // nextUpdate throws once the connection closes: the pump ends and no further frames are delivered (the upper layer's timeout is the backstop).
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
        // Narrow surface: ACP's usage_update is the context window and cost (used/size/cost), not
        // per-turn token usage -- the message frame's usage stays absent and the runner does not bill it (on record).
        return []
      default:
        return []
    }
  }
}
