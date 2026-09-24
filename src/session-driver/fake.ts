/**
 * FakeSessionDriver —— 拔插头验收的「插头三替身」（纯内存假翻译员）。
 *
 * 它只实现 SessionDriver 端口，不 import 任何 wire 模块（rpc/mux/respond 都不碰）。
 * 用它驱动 runner/chat 全链路，证明上层在运行时也只依赖端口：
 * 换插头 = 换这个实现，上层零改动（TRANSLATOR-OPTIONS §5 验收标准）。
 *
 * 脚本化：frames 按序泵给订阅者（prompt 时触发），其余操作只记录。
 */
import type { SessionDriver } from './port.js'
import type { MuxListener } from '../upstream/mux.js'
import type { UpstreamCreatedSession, UpstreamSessionHistory } from '../upstream/client.js'
import type { UpstreamGoal } from '../upstream/translate.js'
import type { RpcReceipt } from '../upstream/respond.js'
import type { GatewayFrame } from '../gateway/stream.js'

export interface FakeScript {
  /** prompt 后按序泵给订阅者的帧。 */
  frames: GatewayFrame[]
  /** prompt 是否被接受（默认 true）。 */
  promptAccepted?: boolean
  /** 非空 = prompt 抛出该错误（模拟上游 5xx）。 */
  promptError?: string
  /** createSession 的返回事实（默认 null = 用入参）。 */
  preset?: string | null
  provider?: string | null
  model?: string | null
  composer?: {
    model?: { provider: string; model: string; reasoningEffort?: string } | null
    context?: { usedTokens: number; contextWindow: number; breakdown?: { systemTokens: number; toolsTokens: number; messageTokens: number } } | null
    accessMode?: 'read-only' | 'workspace-write' | 'danger-full-access' | null
  }
  /** 脚本可控：全量沙箱开锁状态（capabilities.fullAccess）。 */
  fullAccess?: boolean
  /** 卡片链：pendingAsks 的返回值；函数形态可按调用次序返回不同结果（如首查空、重连查有）。 */
  pendingAsks?: GatewayFrame[] | (() => GatewayFrame[])
  /** 脚本可控：setSandboxMode 抛 session_not_live（模拟会话转冷的 409）。 */
  sandboxNotLive?: boolean
  /** 脚本可控：host goal 投影（history 里的 goal 字段）。 */
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
  /** 非空 = createSession 抛出该错误（模拟上游 5xx）。 */
  createError?: string
  /** probeVersion 返回值；null = 抛出（不可达）。 */
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
    // 异步泵帧：与真实插头的流式投递同序（订阅先于 prompt 已成立）。
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

  /** 测试观察面：某会话当前挂着的订阅数（债务 R8 用，生产不调用）。 */
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
    this.selectedModels.push({ sessionId, ...selection })
    return selection
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

  /** 脚本可控的全量沙箱开锁状态（测试 capabilities.fullAccess 用）。 */
  async allowsFullAccess(): Promise<boolean> {
    return this.script.fullAccess === true
  }

  /** 卡片链：脚本可控的挂起问答恢复结果（缺省空 = 无恢复能力）。 */
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
