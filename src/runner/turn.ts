/**
 * Debt E1: the runner's turn core moved down into its own module.
 *
 * The old implementation: one ~460-line mega-closure inside runAgent plus two turn loops
 * (turnGateway / turnApiproxy), with the shared logic (usage pricing, text accumulation, tool
 * counting, the turn_end final state) copied word for word in both. This module:
 *
 * - `TurnState`: the turn's mutable state made explicit (the old implementation was a pile of lets captured by the closure);
 * - `makeFinish`: writing the final state (Debt A2 atomic accounting) + idempotence (Debt R8) -- it takes a state
 *   object and the dependencies, no longer capturing runAgent's locals;
 * - `handleTurnFrame`: the frame handler shared by both loops -- each loop keeps only its own differences
 *   (gateway: hello replay / when to send the message; apiproxy: reconnect frames / audit log / subscription mechanics).
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
  /** Cost accumulated response by response (each response is priced at its arrival time; a turn can span peak and off-peak). */
  accruedCost: number
  accruedPeakCost: number
  /** Set to false as soon as the first priced response has no rate -- an unpriced model reports an honest gap, not a partial total. */
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
  /** Clears the overall timeout and the silence timer (clearTimeout(timer) + clearSilence in the old finish). */
  clearTimers: () => void
}

/**
 * The final-state factory: it pulls the turn's wrap-up (clear timers -> price the turn -> atomic write -> build the RunOutcome) down here.
 * Idempotent (Debt R8): abort / reconnect / turn_end / the error path race and fire from several directions, yet only one write lands.
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

    // Debt A2: the run's final state and the usage write must be atomic -- the old code wrote done
    // and then usage, so a usage failure left "done with no accounting", or a half state for boot to reconcile.
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
      // The accounting transaction failed (disk full / constraint conflict): fall back to writing only the
      // failed final state -- the accounting gap stays visible in the error instead of silently handing
      // the ledger a "done but unaccounted" turn.
      const accountingText = `accounting failed, this usage may not have been recorded: ${(accountingError as Error).message}`
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
// The shared frame handler
// ---------------------------------------------------------------------------

/** The final-state mapping for turn_end (the part both loops had word for word). */
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
  /** Forwards live frames (the browser relay). */
  relay: (frame: GatewayFrame) => void
  trackAwaiting: (frame: GatewayFrame) => void
  armSilence: () => void
  /** apiproxy special case: a mid-turn stream reconnect (result unknown, fails loudly). Not passed by gateway. */
  onReconnect?: () => void
}

/**
 * The shared processing core for one frame (the part both loops had word for word, brought together):
 * trackAwaiting -> armSilence -> relay -> live pricing/text -> tool_call -> turn_end.
 *
 * Two special cases stay out of here (each loop handles its own):
 * - hello: gateway's history replay (never forwarded and never billed), and the message is sent on the first hello;
 * - stream_reconnected: apiproxy's explicit failure (through hooks.onReconnect).
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
