/**
 * FakeSessionDriver -- the "third plug stand-in" for the plug-swap acceptance (a pure in-memory fake translator).
 *
 * It implements the SessionDriver port only and imports no wire module (it touches neither rpc, mux nor respond).
 * Driving the whole runner/chat path with it proves the upper layer depends on the port alone at runtime too:
 * swapping the plug = swapping this implementation, with zero changes above (TRANSLATOR-OPTIONS section 5 acceptance criterion).
 *
 * Scripted: the frames are pumped to subscribers in order (triggered by prompt), while every other operation is only recorded.
 */
import type { SessionDriver } from './port.js'
import type { MuxListener } from '../upstream/mux.js'
import type { UpstreamCreatedSession, UpstreamSessionHistory } from '../upstream/client.js'
import type { UpstreamGoal } from '../upstream/translate.js'
import type { RpcReceipt } from '../upstream/respond.js'
import type { GatewayFrame } from '../gateway/stream.js'

export interface FakeScript {
  /** The frames pumped to subscribers in order after prompt. */
  frames: GatewayFrame[]
  /** Whether prompt is accepted (true by default). */
  promptAccepted?: boolean
  /** Non-empty = prompt throws that error (simulating an upstream 5xx). */
  promptError?: string
  /** What createSession returns (null by default = use the arguments). */
  preset?: string | null
  provider?: string | null
  model?: string | null
  /**
   * What the host *confirms* after selectModel: the test stand-in for "the host resolved the
   * request to something else" (a dated snapshot, a fallback provider). Absent = echo the request,
   * which is what a host that took the selection verbatim answers.
   */
  selectModelResult?: { provider: string; model: string; reasoningEffort?: string } | null
  /** Non-empty = selectModel throws that error (simulating a model the host cannot route). */
  selectModelError?: string
  composer?: {
    model?: { provider: string; model: string; reasoningEffort?: string } | null
    context?: { usedTokens: number; contextWindow: number; breakdown?: { systemTokens: number; toolsTokens: number; messageTokens: number } } | null
    accessMode?: 'read-only' | 'workspace-write' | 'danger-full-access' | null
  }
  /** Script-controlled: the full sandbox unlock state (capabilities.fullAccess). */
  fullAccess?: boolean
  /** The card chain: the pendingAsks return value; the function form can return different results per call order (empty on the first lookup, present on a reconnect). */
  pendingAsks?: GatewayFrame[] | (() => GatewayFrame[])
  /** Script-controlled: setSandboxMode throws session_not_live (simulating a 409 from a chat that went cold). */
  sandboxNotLive?: boolean
  /** Script-controlled: the host goal projection (the goal field of history). */
  goal?: UpstreamGoal | null
  models?: {
    current: { provider: string; model: string; reasoningEffort?: string } | null
    routable: boolean
    groups: Array<{
      id: string
      name: string
      models: Array<{
        id: string
        name: string
        reasoning?: { efforts: Array<{ id: string; name: string }>; defaultEffort?: string }
      }>
    }>
    failures: Array<{ id: string; name: string; message: string }>
  }
  /** Non-empty = createSession throws that error (simulating an upstream 5xx). */
  createError?: string
  /** The probeVersion return value; null = throw (unreachable). */
  probeVersion?: string | null
}

export class FakeSessionDriver implements SessionDriver {
  readonly id: string
  private seq = 0
  readonly created: Array<{ cwd: string; preset: string | null }> = []
  readonly prompts: string[] = []
  cancels = 0
  readonly sandboxPins: Array<{ sessionId: string; mode: string }> = []
  readonly selectedModels: Array<{ sessionId: string; provider: string; model: string; reasoningEffort?: string }> = []
  readonly answered: Array<{ rpcId: string; sessionId: string; answer: unknown }> = []
  readonly declined: Array<{ rpcId: string; sessionId: string }> = []
  readonly decided: Array<{ rpcId: string; sessionId: string; approvalId: string; outcome: string }> = []
  readonly released: string[] = []
  private readonly listeners = new Map<string, Set<MuxListener>>()

  constructor(id: string, private readonly script: FakeScript) {
    this.id = id
  }

  async createSession(cwd: string, preset?: string | null): Promise<UpstreamCreatedSession> {
    if (this.script.createError !== undefined) throw new Error(this.script.createError)
    this.created.push({ cwd, preset: preset ?? null })
    this.seq += 1
    return {
      sessionId: `fake-${this.seq}`,
      preset: this.script.preset === undefined ? (preset ?? null) : this.script.preset,
      provider: this.script.provider ?? null,
      model: this.script.model ?? null,
    }
  }

  async prompt(sessionId: string, text: string): Promise<{ accepted: boolean }> {
    this.prompts.push(text)
    if (this.script.promptError !== undefined) throw new Error(this.script.promptError)
    if (this.script.promptAccepted === false) return { accepted: false }
    // The frames are pumped asynchronously: same order as a real plug's streaming delivery (subscribing before prompt already holds).
    queueMicrotask(() => {
      for (const frame of this.script.frames) {
        for (const listener of this.listeners.get(sessionId) ?? []) listener(sessionId, frame)
      }
    })
    return { accepted: true }
  }

  subscribe(sessionId: string, listener: MuxListener): () => void {
    const set = this.listeners.get(sessionId) ?? new Set()
    set.add(listener)
    this.listeners.set(sessionId, set)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.listeners.delete(sessionId)
    }
  }

  /** The test observation surface: how many subscribers a chat currently holds (used by Debt R8, never called in production). */
  activeSubscriberCount(sessionId: string): number {
    return this.listeners.get(sessionId)?.size ?? 0
  }

  async history(sessionId: string): Promise<UpstreamSessionHistory> {
    return {
      sessionId,
      sessionState: 'cold',
      title: null,
      events: [],
      composer: {
        model: this.script.composer?.model ?? null,
        context: this.script.composer?.context === null || this.script.composer?.context === undefined
          ? null
          : { ...this.script.composer.context, breakdown: this.script.composer.context.breakdown ?? null, percent: Math.round(this.script.composer.context.usedTokens / this.script.composer.context.contextWindow * 100) },
        accessMode: this.script.composer?.accessMode ?? null,
      },
      goal: this.script.goal ?? null,
    }
  }

  async modelCatalog() {
    return this.script.models ?? { current: null, routable: false, groups: [], failures: [] }
  }

  async selectModel(sessionId: string, selection: { provider: string; model: string; reasoningEffort?: string }) {
    if (this.script.selectModelError !== undefined) throw new Error(this.script.selectModelError)
    this.selectedModels.push({ sessionId, ...selection })
    const confirmed = this.script.selectModelResult
    return confirmed === undefined || confirmed === null ? selection : confirmed
  }

  async cancel(_sessionId: string): Promise<void> {
    this.cancels += 1
  }

  async answerQuestion(rpcId: string, sessionId: string, answer: unknown): Promise<RpcReceipt> {
    this.answered.push({ rpcId, sessionId, answer })
    return { accepted: true }
  }

  async declineQuestion(rpcId: string, sessionId: string): Promise<RpcReceipt> {
    this.declined.push({ rpcId, sessionId })
    return { accepted: true }
  }

  async decideApproval(
    rpcId: string,
    sessionId: string,
    approvalId: string,
    outcome: 'allowed-once' | 'rejected',
  ): Promise<RpcReceipt> {
    this.decided.push({ rpcId, sessionId, approvalId, outcome })
    return { accepted: true }
  }

  async release(sessionId: string): Promise<void> {
    this.released.push(sessionId)
  }

  /** The script-controlled full sandbox unlock state (used by tests for capabilities.fullAccess). */
  async allowsFullAccess(): Promise<boolean> {
    return this.script.fullAccess === true
  }

  /** The card chain: the script-controlled result of resuming a pending question (empty by default = no resume capability). */
  async pendingAsks(_sessionId: string): Promise<GatewayFrame[]> {
    const pending = this.script.pendingAsks
    if (pending === undefined) return []
    return typeof pending === 'function' ? pending() : pending
  }

  async probeVersion(): Promise<string> {
    const version = this.script.probeVersion
    if (version === undefined || version === null) throw new Error('fake: upstream unreachable')
    return version
  }

  canSetSandboxMode(): boolean {
    return true
  }

  async setSandboxMode(sessionId: string, mode: 'read-only' | 'workspace-write' | 'danger-full-access'): Promise<void> {
    if (this.script.sandboxNotLive) {
      throw new Error('sandbox-mode 409: {"error":"session_not_live","message":"session is not live"}')
    }
    this.sandboxPins.push({ sessionId, mode })
  }
}
