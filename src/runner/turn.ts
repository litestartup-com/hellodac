/**
 * 债务 E1:runner 的回合核心下沉为独立模块。
 *
 * 旧实现:runAgent 里一个 ~460 行的巨型闭包 + 两份回合循环(turnGateway /
 * turnApiproxy),共享逻辑(usage 计价、文本累积、tool 计数、turn_end 终态)
 * 逐字复制两份。本模块:
 *
 * - `TurnState`:回合可变状态的显式化(旧实现是闭包捕获的一把 let);
 * - `makeFinish`:终态落库(债务 A2 原子记账)+ 幂等(债务 R8)——入参是状态
 *   对象与依赖,不再捕获 runAgent 的局部变量;
 * - `handleTurnFrame`:两份循环共享的帧处理器——循环只留自己的差异
 *   (gateway:hello 回放/发消息时机;apiproxy:重连帧/审计日志/订阅机制)。
 */
import { eq } from 'drizzle-orm'
import { schema, type Db } from '../db/index.js'
import { normalizeUsage, sumUsage, type GatewayFrame, type TokenUsage } from '../gateway/stream.js'
import { computeCost, type PricingTable } from '../pricing.js'
import type { RunOutcome, RunState } from '../runner.js'

export interface TurnState {
  sessionId: string | null
  provider: string | null
  model: string | null
  usage: TokenUsage | null
  reason: string | null
  toolCalls: number
  texts: string[]
  /** 逐响应累积成本(每次响应按到达时刻计价,回合可能跨峰谷)。 */
  accruedCost: number
  accruedPeakCost: number
  /** 第一个有价响应缺费率即置 false——未定价模型报诚实缺口而非部分合计。 */
  costKnown: boolean
}

export const newTurnState = (): TurnState => ({
  sessionId: null,
  provider: null,
  model: null,
  usage: null,
  reason: null,
  toolCalls: 0,
  texts: [],
  accruedCost: 0,
  accruedPeakCost: 0,
  costKnown: true,
})

const SUMMARY_LIMIT = 4_000

const truncate = (text: string, limit = SUMMARY_LIMIT): string =>
  text.length <= limit ? text : `${text.slice(0, limit)}\n[truncated ${text.length - limit} chars]`

export interface FinishDeps {
  runId: string
  db: Db
  now: () => number
  startedAt: number
  log?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void }
  /** 总超时与静默计时器的清理(旧 finish 里的 clearTimeout(timer)+clearSilence)。 */
  clearTimers: () => void
}

/**
 * 终态工厂:把回合收尾(清计时器 → 算钱 → 原子落库 → 组 RunOutcome)下沉。
 * 幂等(债务 R8):abort / 重连 / turn_end / 异常路径竞态下多路触发,只落一次账。
 */
export const makeFinish = (
  state: TurnState,
  deps: FinishDeps,
): ((finishState: RunState, errorText: string | null) => RunOutcome) => {
  let finishCalled = false
  let finishedOutcome: RunOutcome | null = null

  return (finishState, errorText) => {
    if (finishCalled && finishedOutcome !== null) return finishedOutcome
    finishCalled = true
    deps.clearTimers()
    const endedAt = deps.now()
    const summary = truncate(state.texts.join('\n').trim())
    const costMicroUsd = state.usage === null || !state.costKnown ? null : state.accruedCost
    const peakCostMicroUsd = costMicroUsd === null ? null : state.accruedPeakCost

    const buildOutcome = (
      finalState: RunState,
      finalError: string | null,
      finalUsage: TokenUsage | null,
      finalCost: number | null,
      finalPeak: number | null,
    ): RunOutcome => ({
      runId: deps.runId,
      state: finalState,
      sessionId: state.sessionId,
      summary,
      usage: finalUsage,
      costMicroUsd: finalCost,
      peakCostMicroUsd: finalPeak,
      provider: state.provider,
      model: state.model,
      reason: state.reason,
      error: finalError,
      toolCalls: state.toolCalls,
      durationMs: endedAt - deps.startedAt,
      // Filled in by the snapshot below, once the turn is over.
      commit: null,
      changedFiles: [],
      snapshotSkipped: null,
      conflict: null,
    })

    // 债务 A2:run 终态与用量落库必须原子——旧代码先写 done 后写 usage,
    // usage 失败会留下「done + 无账目」或依赖 boot 收敛的半态。
    // Written even when the run failed: the tokens were spent either way, and
    // usage cannot be reconstructed after the fact.
    try {
      deps.db.transaction((tx) => {
        if (state.usage !== null) {
          tx.insert(schema.usageRecord)
            .values({
              runId: deps.runId,
              provider: state.provider,
              model: state.model,
              inputTokens: state.usage.inputTokens,
              outputTokens: state.usage.outputTokens,
              cacheRead: state.usage.cacheReadTokens ?? null,
              cacheWrite: state.usage.cacheWriteTokens ?? null,
              reasoningTokens: state.usage.reasoningTokens ?? null,
              cost: costMicroUsd,
              peakCost: peakCostMicroUsd,
              at: endedAt,
            })
            .run()
        }
        tx.update(schema.run)
          .set({
            state: finishState,
            dshSessionId: state.sessionId,
            resultSummary: summary === '' ? null : summary,
            endedAt,
            error: errorText,
          })
          .where(eq(schema.run.id, deps.runId))
          .run()
      })
    } catch (accountingError) {
      // 记账事务失败(磁盘满/约束冲突):降级为单写 failed 终态——账目缺口
      // 在 error 里显性可见,绝不静默把「done 但没账」的回合交给账本。
      const accountingText = `记账失败,本次用量可能未入账: ${(accountingError as Error).message}`
      deps.log?.error(`run ${deps.runId}: ${accountingText}`)
      deps.db
        .update(schema.run)
        .set({
          state: 'failed',
          dshSessionId: state.sessionId,
          resultSummary: summary === '' ? null : summary,
          endedAt,
          error: errorText === null ? accountingText : `${errorText}; ${accountingText}`,
        })
        .where(eq(schema.run.id, deps.runId))
        .run()
      finishedOutcome = buildOutcome(
        'failed',
        errorText === null ? accountingText : `${errorText}; ${accountingText}`,
        null,
        null,
        null,
      )
      return finishedOutcome
    }

    finishedOutcome = buildOutcome(finishState, errorText, state.usage, costMicroUsd, peakCostMicroUsd)
    return finishedOutcome
  }
}

// ---------------------------------------------------------------------------
// 共享帧处理器
// ---------------------------------------------------------------------------

/** turn_end 的终态换算(两份循环逐字相同的部分)。 */
const endFromTurnEnd = (frame: GatewayFrame): { state: RunState; error: string | null } => {
  const detail = frame.detail as { message?: string; cause?: string } | null
  if (frame.reason === 'error') {
    return { state: 'failed', error: detail?.message ?? 'the turn ended with an error' }
  }
  if (frame.reason === 'aborted') {
    return { state: 'failed', error: `the turn was aborted (${detail?.cause ?? 'unknown cause'})` }
  }
  return { state: 'done', error: null }
}

export type FrameResult = { kind: 'continue' } | { kind: 'end'; state: RunState; error: string | null }

export interface FrameHooks {
  /** 直播帧转发(浏览器中继)。 */
  relay: (frame: GatewayFrame) => void
  trackAwaiting: (frame: GatewayFrame) => void
  armSilence: () => void
  /** apiproxy 特例:回合中流重连(结果未知,显性失败)。gateway 不传。 */
  onReconnect?: () => void
}

/**
 * 一份帧的共享处理核心(两份循环逐字相同的部分收敛):
 * trackAwaiting → armSilence → relay → 直播计价/文本 → tool_call → turn_end。
 *
 * 不进这里的两类特例(循环自己处理):
 * - hello:gateway 的历史回放(绝不转发/计费),且发消息时机挂在第一条 hello 上;
 * - stream_reconnected:apiproxy 的显性失败(经 hooks.onReconnect)。
 */
export const handleTurnFrame = (
  state: TurnState,
  deps: { pricing: PricingTable; now: () => number },
  frame: GatewayFrame,
  hooks: FrameHooks,
): FrameResult => {
  // Counted before the timer is re-armed: the frame that says a question is
  // open is the same frame that must stop the backstop from arming.
  hooks.trackAwaiting(frame)
  hooks.armSilence()

  // Past hello, so this is live: safe to relay and safe to bill.
  hooks.relay(frame)

  if (frame.kind === 'stream_reconnected') {
    hooks.onReconnect?.()
    return { kind: 'continue' }
  }

  if (frame.kind === 'message') {
    const frameUsage = normalizeUsage(frame.usage)
    state.usage = sumUsage(state.usage, frameUsage)
    if (frameUsage !== null) {
      const cost = computeCost(frameUsage, state.provider, state.model, deps.now(), deps.pricing)
      if (cost === null) state.costKnown = false
      else {
        state.accruedCost += cost.microUsd
        if (cost.peak) state.accruedPeakCost += cost.microUsd
      }
    }
    const text = typeof frame.text === 'string' ? frame.text : ''
    if (text !== '') state.texts.push(text)
    return { kind: 'continue' }
  }

  if (frame.kind === 'tool_call') {
    state.toolCalls += 1
    return { kind: 'continue' }
  }

  if (frame.kind === 'turn_end') {
    state.reason = typeof frame.reason === 'string' ? frame.reason : 'unknown'
    const ended = endFromTurnEnd(frame)
    return { kind: 'end', state: ended.state, error: ended.error }
  }

  return { kind: 'continue' }
}
