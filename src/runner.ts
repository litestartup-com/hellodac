import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { Db } from './db/index.js'
import { schema } from './db/index.js'
import type { ResolvedAgent } from './config.js'
import { DEFAULT_PRICING, type PricingTable } from './pricing.js'
import { withCommitLock } from './workspace/commit-lock.js'
import { currentHead, snapshotAfter, snapshotBefore } from './workspace/snapshot.js'
import type { SessionDriver } from './session-driver/port.js'
import type { GatewayFrame, TokenUsage } from './frames.js'
// Debt E1: turn state / finish / the shared frame handler moved down into runner/turn.ts.
import { handleTurnFrame, makeFinish, newTurnState } from './runner/turn.js'

/**
 * Drives one agent turn end to end: acquire a session bounded to the workspace,
 * subscribe, send the instruction, follow the stream to `turn_end`, and record
 * what it cost.
 *
 * Debt E16: the full argument for the turn-driving semantics (subscribe before sending / count live frames only /
 * price each response / hand the session back / a silence timeout is not the total timeout) is now frozen in
 * docs/adr/0001-runner-turn-semantics.md, and the source keeps only this reference.
 */

export const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000

/**
 * How long a turn may produce NOTHING before it is cancelled.
 *
 * Distinct from the total timeout, and neither replaces the other. The total
 * timeout has to be generous, because a turn that works for twenty minutes is
 * legitimate; that generosity is exactly what a blocked turn exploits. A
 * working turn emits frames continuously (deltas, tool calls), so silence this
 * long means the turn is not slow but stopped -- typically waiting on an
 * interactive prompt that, for an API-driven session, nobody can answer.
 *
 * The facade contract is supposed to make that unanswerable-prompt case
 * impossible (questions and approvals arrive as mux frames and are answerable
 * through respond). This is the backstop for when it is not: a permission
 * dialog that never surfaces as a frame at all, or a host that went quiet for
 * reasons nobody can see. It costs one timer and guarantees that no turn hangs
 * indefinitely regardless of what the other side does.
 */
export const DEFAULT_SILENCE_MS = 5 * 60 * 1000
/**
 * How long an OUTWARD turn lets a question/approval frame wait for a human before declining it
 * (see trackAwaiting). Long enough for an operator who happens to be watching the conversation
 * in the admin chat to answer first; short enough that a customer's HTTP call is not staring at
 * a dead socket. The DSH tool itself has no timeout (DSH-FACTS §17), so this is the only floor.
 */
export const DEFAULT_OUTWARD_GRACE_MS = 30 * 1000

export type RunTrigger = 'manual' | 'cron' | 'api' | 'capture' | 'brain'
export type RunState = 'pending' | 'running' | 'done' | 'failed' | 'missed'

export interface RunInput {
  agent: ResolvedAgent
  /**
   * The SessionDriver plug of the agent's endpoint (port vocabulary, src/session-driver/port.ts).
   * Required: the retired gateway driver was the last reason a turn could run without one
   * (facade 0.2.x dropped its session REST surface -- facts/dsh-facts.md §15).
   */
  upstream: SessionDriver
  prompt: string
  trigger: RunTrigger
  cronId?: string | null
  idempotencyKey?: string | null
  /**
   * Whose account this turn goes on (a public-API key). **It must be written when the run row is created**, not filled
   * in afterwards: the concurrency cap (how many turns run at once under one key) is visible from this column while they
   * run, and recording it after the fact would amount to letting one key run unlimited concurrent turns.
   */
  apiKeyId?: string | null
  timeoutMs?: number
  /** Cancel after this long with no frames at all; 0 disables. */
  silenceMs?: number
  /**
   * Outward turns only: the grace window before a pending question/approval is auto-declined
   * (DEFAULT_OUTWARD_GRACE_MS in production; tests pass something small). Ignored on inward turns.
   */
  outwardGraceMs?: number
  /**
   * Continue this session instead of creating a fresh one.
   *
   * This is what makes a conversation a conversation: the model only sees the
   * earlier turns because the session is the same one.
   */
  sessionId?: string | null
  /** The chat this turn belongs to, recorded on the run row. */
  chatId?: string | null
  onSession?: (sessionId: string) => void
  signal?: AbortSignal
  /**
   * Hive P2: the chat the brain dispatched from (the delegation frame's origin). Different from `chatId` -- the
   * latter is "which working chat the run is written to", the former is "who started it".
   */
  sourceChatId?: string | null
  /**
   * Receives every *live* frame, for relaying to browsers.
   *
   * Live frames only, for the same reason usage is counted from live frames
   * only: anything replayed from the durable history would re-emit -- and
   * re-bill -- what an earlier turn already emitted.
   */
  onFrame?: (frame: GatewayFrame) => void
}

export interface RunOutcome {
  runId: string
  state: RunState
  sessionId: string | null
  /** Assistant text, trimmed for storage. */
  summary: string
  usage: TokenUsage | null
  costMicroUsd: number | null
  /** The part of `costMicroUsd` billed at the peak rate. */
  peakCostMicroUsd: number | null
  provider: string | null
  model: string | null
  /** turn_end reason as reported by the host. */
  reason: string | null
  error: string | null
  toolCalls: number
  durationMs: number
  /** The commit holding this run's changes, or null when it changed nothing. */
  commit: string | null
  /** Workspace-relative paths this run changed. */
  changedFiles: string[]
  /**
   * Why no snapshot was taken, when that happened. The turn itself still ran;
   * its changes are simply not committed.
   */
  snapshotSkipped: string | null
  /**
   * Hive P5.4: the concurrent-write conflict note. Non-empty when the workspace was committed by another turn while
   * this one ran -- this turn worked from the older state and its files may have been changed concurrently. NULL = no conflict.
   */
  conflict: string | null
}

export interface RunnerDeps {
  db: Db
  clock?: () => number
  pricing?: PricingTable
  /** Injected so tests do not have to wait fifteen minutes. */
  log?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void }
}

/**
 * Hive P5.4: the set of active runs per agent (concurrency). The manager does not serialise by
 * hand; this map only serves the "in progress" display in the UI and the routes.
 */
const activeRuns = new Map<string, Set<string>>()

/** The id of any active run (the UI's busy dot only needs a yes/no). */
export const runningRunId = (agentId: string): string | null => {
  const set = activeRuns.get(agentId)
  if (set === undefined || set.size === 0) return null
  return [...set][0] ?? null
}

/** The number of active runs (the concurrency display). */
export const activeRunCount = (agentId: string): number => activeRuns.get(agentId)?.size ?? 0

/**
 * Hive P5.4: one commit lock per agent. Turns run in parallel, but git snapshots/commits queue up --
 * two turns doing git add/commit at once trample each other on index.lock. Writing to disk is the queueing point;
 * everything else runs in parallel throughout. The lock itself is in workspace/commit-lock.ts (fleet.md sync shares the same one).
 */

export const runAgent = async (deps: RunnerDeps, input: RunInput): Promise<RunOutcome> => {
  const now = deps.clock ?? Date.now
  const log = deps.log
  const { agent, prompt, upstream } = input
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const silenceMs = input.silenceMs ?? DEFAULT_SILENCE_MS
  const startedAt = now()

  const runId = randomUUID()
  const set = activeRuns.get(agent.id) ?? new Set<string>()
  set.add(runId)
  activeRuns.set(agent.id, set)

  // Recorded before any network call, so a crashed run still leaves a trace.
  try {
    deps.db
      .insert(schema.run)
      .values({
        id: runId,
        agentId: agent.id,
        chatId: input.chatId ?? null,
        sourceChatId: input.sourceChatId ?? null,
        cronId: input.cronId ?? null,
        dshSessionId: input.sessionId ?? null,
        trigger: input.trigger,
        idempotencyKey: input.idempotencyKey ?? null,
        apiKeyId: input.apiKeyId ?? null,
        state: 'running',
        resultSummary: null,
        startedAt,
        endedAt: null,
        error: null,
        conflict: null,
      })
      .run()
  } catch (error) {
    set.delete(runId)
    if (set.size === 0) activeRuns.delete(agent.id)
    throw new Error(`could not record run ${runId}: ${(error as Error).message}`)
  }

  let stoppedByUser = false
  const controller = new AbortController()
  const stopFromCaller = () => {
    stoppedByUser = true
    controller.abort()
  }
  if (input.signal?.aborted) stopFromCaller()
  else input.signal?.addEventListener('abort', stopFromCaller, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('run timed out')), timeoutMs)

  // Armed when the stream opens and pushed forward by every frame, so it only
  // fires on real silence. Tracked separately from the total timeout because the
  // two mean different things to the person reading the failure.
  let silenceTimer: ReturnType<typeof setTimeout> | null = null
  let silenced = false
  const clearSilence = () => {
    if (silenceTimer !== null) clearTimeout(silenceTimer)
    silenceTimer = null
  }

  /**
   * How many questions or permission prompts this turn is waiting on a human for.
   *
   * The backstop exists to catch a turn that went quiet for a reason nobody can
   * see. A turn waiting on an answer is the opposite: quiet for a reason that is
   * on screen, with someone possibly mid-way through typing it. Cancelling that
   * would throw the turn's work away at the worst possible moment, so the
   * backstop stands down while the count is above zero -- the total timeout still
   * bounds the whole thing.
   *
   * OUTWARD turns are the exception (2026-09-29, the ask_user_question hang): nobody is on
   * screen there -- the caller is an HTTP client waiting for its reply. Standing the backstop
   * down let one blocking question ride the internal 15-minute ceiling with the customer's
   * request open the whole time. So on an outward turn the backstop stays armed AND every
   * question/approval frame gets a short grace window (an operator watching this conversation
   * in the admin chat can still answer inside it); when the window expires the manager declines
   * the frame through the same ports the chat UI uses. The tool then returns "aborted before
   * the user answered", the agent continues, and -- with the outward rules seeded into its
   * workspace -- re-asks in plain reply text, which the customer's next message CAN answer.
   */
  let awaitingHuman = 0
  /**
   * How many tool calls are currently executing on the host.
   *
   * A tool call is progress, not silence: the host is running the command and no frames stream while
   * it works (measured on the fleet pilot: a single `sleep 400` command was cancelled at 304s because
   * the agent's pre-announcement message armed the backstop and nothing followed it). The backstop
   * stands down while the count is above zero -- the total timeout still bounds a genuinely stuck
   * tool, and once the tool result lands, real silence is caught again.
   */
  let toolsInFlight = 0
  const isOutward = input.apiKeyId !== undefined && input.apiKeyId !== null
  const outwardGraceMs = input.outwardGraceMs ?? DEFAULT_OUTWARD_GRACE_MS
  /** Auto-decline timers keyed by frame id (question id / decision id), so a human answering first cancels one. */
  const pendingDeclines = new Map<string, ReturnType<typeof setTimeout>>()
  const clearDeclines = (): void => {
    for (const timer of pendingDeclines.values()) clearTimeout(timer)
    pendingDeclines.clear()
  }
  const askIdOfFrame = (frame: GatewayFrame): string | null => {
    if (frame.kind === 'question_asked' || frame.kind === 'question_resolved') {
      return typeof frame.questionId === 'string' && frame.questionId !== '' ? frame.questionId : null
    }
    if (frame.kind === 'approval_pending' || frame.kind === 'approval_resolved') {
      return typeof frame.decisionId === 'string' && frame.decisionId !== '' ? frame.decisionId : null
    }
    return null
  }

  const declineFrame = async (frame: GatewayFrame): Promise<void> => {
    const sid = turnState.sessionId
    if (sid === null) return
    const graceSec = Math.round(outwardGraceMs / 1000)
    try {
      if (frame.kind === 'question_asked') {
        const qid = typeof frame.questionId === 'string' ? frame.questionId : null
        if (qid === null) return
        // The questionId IS the rpc id of the respond contract.
        await upstream.declineQuestion(qid, sid)
        log?.info(`run ${runId}: outward turn — nobody can answer prompts here, so question ${qid} was auto-declined after ${graceSec}s`)
      } else if (frame.kind === 'approval_pending') {
        const did = typeof frame.decisionId === 'string' ? frame.decisionId : null
        const ap = typeof frame.approvalId === 'string' ? frame.approvalId : null
        if (did === null || ap === null) return
        await upstream.decideApproval(did, sid, ap, 'rejected')
        const toolName = typeof (frame as { toolName?: unknown }).toolName === 'string' ? (frame as { toolName?: string }).toolName : ''
        log?.info(`run ${runId}: outward turn — approval ${did}${toolName === '' ? '' : ` (${toolName})`} was auto-rejected after ${graceSec}s`)
      } else {
        return
      }
      // Update the local count without waiting for the resolved frame to come back through the
      // mux: it normally does (and the Math.max guard absorbs the double decrement), but a lost
      // frame must not leave this turn's own state lying about a wait that is over.
      awaitingHuman = Math.max(0, awaitingHuman - 1)
      armSilence()
    } catch (error) {
      // A failed decline leaves the frame pending; the armed silence backstop and the (outward)
      // total timeout still bound the turn, so this is a warning, not a failure.
      log?.warn(`run ${runId}: auto-decline failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const scheduleAutoDecline = (frame: GatewayFrame): void => {
    const id = askIdOfFrame(frame)
    if (id === null || pendingDeclines.has(id)) return
    pendingDeclines.set(
      id,
      setTimeout(() => {
        pendingDeclines.delete(id)
        void declineFrame(frame)
      }, outwardGraceMs),
    )
  }

  const cancelAutoDecline = (frame: GatewayFrame): void => {
    const id = askIdOfFrame(frame)
    if (id === null) return
    const timer = pendingDeclines.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      pendingDeclines.delete(id)
    }
  }

  /**
   * Headless approval registry (design doc hive/topics/headless-approval-p1.md): the durable pendant
   * of the chat's in-memory pending cards. Recording must never break the turn -- a failed write is
   * a warning, not a run failure.
   */
  const recordPendingApproval = (frame: GatewayFrame): void => {
    const decisionId = typeof frame.decisionId === 'string' && frame.decisionId !== '' ? frame.decisionId : null
    if (decisionId === null) return
    try {
      deps.db
        .insert(schema.approvalQueue)
        .values({
          id: decisionId,
          runId,
          agentId: agent.id,
          approvalId: typeof frame.approvalId === 'string' && frame.approvalId !== '' ? frame.approvalId : decisionId,
          toolName: typeof frame.toolName === 'string' ? frame.toolName : '',
          reason: typeof frame.reason === 'string' ? frame.reason : null,
          state: 'pending',
          outcome: null,
          createdAt: now(),
          resolvedAt: null,
        })
        .onConflictDoNothing()
        .run()
    } catch (error) {
      log?.warn(`run ${runId}: could not record the pending approval: ${(error as Error).message}`)
    }
  }

  const resolveApproval = (frame: GatewayFrame): void => {
    const decisionId = typeof frame.decisionId === 'string' && frame.decisionId !== '' ? frame.decisionId : null
    if (decisionId === null) return
    try {
      deps.db
        .update(schema.approvalQueue)
        .set({
          state: 'resolved',
          outcome: typeof frame.outcome === 'string' ? frame.outcome : null,
          resolvedAt: now(),
        })
        .where(and(eq(schema.approvalQueue.id, decisionId), eq(schema.approvalQueue.runId, runId)))
        .run()
    } catch (error) {
      log?.warn(`run ${runId}: could not resolve the approval row: ${(error as Error).message}`)
    }
  }

  const trackAwaiting = (frame: GatewayFrame) => {
    switch (frame.kind) {
      case 'tool_call':
        toolsInFlight += 1
        return
      case 'tool_result':
        toolsInFlight = Math.max(0, toolsInFlight - 1)
        return
      case 'question_asked':
      case 'approval_pending':
        awaitingHuman += 1
        if (frame.kind === 'approval_pending') recordPendingApproval(frame)
        if (isOutward) scheduleAutoDecline(frame)
        return
      case 'question_resolved':
      case 'approval_resolved':
        awaitingHuman = Math.max(0, awaitingHuman - 1)
        if (frame.kind === 'approval_resolved') resolveApproval(frame)
        if (isOutward) cancelAutoDecline(frame)
        return
      case 'turn_end':
        awaitingHuman = 0
        toolsInFlight = 0
        clearDeclines()
        return
      default:
        return
    }
  }

  const armSilence = () => {
    if (silenceMs <= 0) return
    clearSilence()
    // An inward turn waiting on a human stands the backstop down (someone may be mid-answer);
    // an outward turn has nobody to wait for, so it stays armed (see trackAwaiting).
    // A tool running on the host is progress, so the backstop stands down for it too -- the
    // total timeout is the net for a genuinely stuck tool.
    if ((awaitingHuman > 0 || toolsInFlight > 0) && !isOutward) return
    silenceTimer = setTimeout(() => {
      silenced = true
      controller.abort(new Error('no frames'))
    }, silenceMs)
  }

  /** Why the turn was cancelled, phrased for whoever has to act on it. */
  const cancelledText = (): string =>
    stoppedByUser
      ? 'the turn was stopped by the user'
      : silenced
        ? `nothing happened for ${Math.round(silenceMs / 1000)}s, so the turn was cancelled. ` +
        'A turn that goes quiet this long is usually waiting on something this side never saw -- ' +
        'an interactive question or a permission prompt that went somewhere else. Ask again, and if it ' +
        "keeps happening check the node's facade wiring (question/approval frames must reach the manager) " +
        "and the deployment's approval policy."
      : `no response within ${Math.round(timeoutMs / 1000)}s; the turn was cancelled`

  // Debt E1: the turn's mutable state is an explicit object -- the turn loop, the shared frame handler
  // (runner/turn.ts) and finish read and write it, replacing the single closure-captured let of the old implementation.
  const turnState = newTurnState()

  // Accumulated per response, because the rate depends on when each one landed.
  const pricing = deps.pricing ?? DEFAULT_PRICING

  // Debt E1: finish moved down into runner/turn.ts (its maker takes the state object plus the persistence deps),
  // and the idempotence semantics (Debt R8) went down with it.
  const clearTimers = (): void => {
    clearTimeout(timer)
    clearSilence()
    clearDeclines()
  }
  const finish = makeFinish(turnState, {
    runId,
    db: deps.db,
    now,
    startedAt,
    ...(log === undefined ? {} : { log }),
    clearTimers,
  })

  // ---- the turn (one path: the SessionDriver port) ----

  const driveTurn = async (): Promise<RunOutcome> => {
    /**
     * Pin the deferred sandbox override (chat.accessModeOverride) and clear it.
     * The host only allows pinning a live session: the create branch calls this right after creating, the resume branch
     * after the prompt (which mounts the cold session as a side effect). A failure keeps the override for the next try and never affects the turn itself.
     */
    const applyAccessOverride = async (sid: string): Promise<void> => {
      if (input.chatId === undefined || input.chatId === null) return
      const row = deps.db.select().from(schema.chat).where(eq(schema.chat.id, input.chatId)).get()
      const override = row?.accessModeOverride
      if (override !== 'read-only' && override !== 'workspace-write' && override !== 'danger-full-access') return
      try {
        await upstream.setSandboxMode?.(sid, override)
        deps.db.update(schema.chat).set({ accessModeOverride: null }).where(eq(schema.chat.id, input.chatId)).run()
        log?.info(`run ${runId}: applied deferred sandbox override ${override} on ${sid}`)
      } catch (error) {
        log?.warn(`run ${runId}: deferred sandbox override ${override} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    /**
     * Settle which model this turn runs on, and record it on the turn state.
     *
     * Why this is not just `turnState.model = agent.model`: on the apiproxy wire, `session.create`
     * carries cwd + preset only -- **no provider/model** -- and the create response reports none
     * either, because the host picks its own default. So the manager knew nothing about the model,
     * `usage_record.model` came out empty and pricing answered null ("cost unknown", the ledger hole
     * first seen on the outward service, 2026-09-28). Writing the *configured* name in anyway would
     * be worse than the gap: the host would keep running its own default while the ledger billed the
     * pinned name -- confidently wrong. Hence pin **and read back**: land the selection with
     * `session.selectModel` and keep what the **host** confirms (it may resolve the request to a
     * dated snapshot or a fallback provider -- that is the name the provider will bill).
     *
     * Called on the continued path too, not only at creation: a session outlives a config change, and
     * re-asserting the pin per turn is both what keeps the session on the service's model and the only
     * read-back available there. It costs one small RPC.
     *
     * Failures are **not** swallowed: a pin that cannot be settled means the turn cannot be
     * accounted for, and running it anyway would hand back a reply nobody can bill.
     */
    const settleTurnModel = async (hostReported: { provider: string | null; model: string | null }): Promise<void> => {
      // What the host says it is running wins over the config; the config name is the fallback for a
      // plug that cannot be pinned.
      let provider = hostReported.provider ?? agent.provider
      let model = hostReported.model ?? agent.model
      if (agent.provider !== null || agent.model !== null) {
        if (agent.provider === null || agent.model === null) {
          // Written this way round on purpose: `loadConfig` rejects a half-written pair, so a
          // half-set agent here means the caller built a ResolvedAgent by hand.
          throw new Error(
            `agent ${agent.id}: provider and model must be set together (got provider=${agent.provider ?? 'none'}, model=${agent.model ?? 'none'})`,
          )
        }
        if (upstream.selectModel === undefined) {
          throw new Error(
            `agent ${agent.id} pins ${agent.provider}/${agent.model} but driver ${upstream.id} cannot select a model`,
          )
        }
        // Both callers set the session id before calling this, and the pin is meaningless without it:
        // fail loudly rather than sending a selection for an empty session id.
        const target = turnState.sessionId
        if (target === null) throw new Error(`run ${runId}: no session id, so the model pin cannot be landed`)
        // The pin goes on the **session**, never on the manager's own idea of the model.
        const confirmed = await upstream.selectModel(target, { provider: agent.provider, model: agent.model })
        provider = confirmed.provider
        model = confirmed.model
      }
      turnState.provider = provider
      turnState.model = model
    }

    try {
      // apiproxy has no adopt/resume concept; prompt is the universal entry.
      // For a new session, create first; for an existing one, just prompt.
      if (input.sessionId === undefined || input.sessionId === null) {
        const created = await upstream.createSession(agent.workspacePath, agent.preset)
        turnState.sessionId = created.sessionId
        // P0.5 host behaviour: the create response normally carries no model (the host has its own
        // default); whatever it does carry is the host's own statement, so it wins over the pin below.
        await settleTurnModel(created)
        // Hive P0: pin the sandbox mode on the session before the first prompt (a sandbox/mode log
        // event, restored by the cold-wake replay, persistent after one call). The continued path already set its mode at creation.
        if (agent.sandboxMode !== null) {
          // An optional port capability: a plug without it is skipped (the facade plug must implement it).
          await upstream.setSandboxMode?.(turnState.sessionId, agent.sandboxMode)
        }
        // A freshly created session = live: the deferred sandbox override is pinned right now (chat.accessModeOverride;
        // 2026-09-11: the host only allows pinning a live session, so the runner does the between-turns switches on its behalf).
        await applyAccessOverride(turnState.sessionId)
      } else {
        turnState.sessionId = input.sessionId
        await settleTurnModel({ provider: null, model: null })
      }

      deps.db.update(schema.run).set({ dshSessionId: turnState.sessionId }).where(eq(schema.run.id, runId)).run()
      if (turnState.sessionId !== null) input.onSession?.(turnState.sessionId)
      log?.info(`run ${runId}: session ${turnState.sessionId} on ${upstream.id}, cwd=${agent.workspacePath}`)

      // Debt E10: an explicit narrowing -- the create branch guarantees a non-null sessionId, so take a local before the closure instead of using `!`
      const sid = turnState.sessionId
      if (sid === null) return finish('failed', 'no session id after create/continue')

      // Subscribe to mux BEFORE sending the prompt, so we catch all frames.
      // Debt R8: unsub goes into a reference box (assigned inside the closure, read by the outer finally) -- early-return
      // paths such as a rejected prompt or a throw no longer leave a subscription behind (the old code only unsubscribed on turn_end/reconnect/abort).
      const unsubRef: { cleanup: (() => void) | null } = { cleanup: null }
      // Debt card chain (2026-09-17): the ids of the ask frames seen this turn -- the recovery channel (pendingAsks)
      // and the reconnect replay bring duplicates, so dedupe by id (a duplicated question_asked would count
      // awaitingHuman twice and draw the card twice).
      const seenAskIds = new Set<string>()
      const askIdOf = (frame: GatewayFrame): string | undefined => {
        if (frame.kind === 'question_asked') return typeof frame.questionId === 'string' ? frame.questionId : undefined
        if (frame.kind === 'approval_pending') return typeof frame.decisionId === 'string' ? frame.decisionId : undefined
        return undefined
      }
      // A recovered frame is handled exactly like a live one (count awaitingHuman + forward to the frontend); a
      // question/approval frame never ends the turn, so the return value is only checked for end (unreachable in theory).
      const processRecoveredAsk = (frame: GatewayFrame): void => {
        const id = askIdOf(frame)
        if (id !== undefined && id !== '') {
          if (seenAskIds.has(id)) return
          seenAskIds.add(id)
        }
        handleTurnFrame(turnState, { pricing, now }, frame, {
          relay: (liveFrame) => input.onFrame?.(liveFrame),
          trackAwaiting,
          armSilence,
        })
      }
      const turnDone = new Promise<RunOutcome>((resolveTurn) => {
        const unsub = upstream.subscribe(sid, (_sid, frame) => {
          // An audit trace: when a frame asking a human or requesting approval arrives, log a line, so that "the card never
          // appeared" problems can be traced back to a break point afterwards (first hit on 2026-09-05).
          if (frame.kind === 'question_asked' || frame.kind === 'approval_pending') {
            const qs = (frame as { questions?: unknown[] }).questions
            const ap = (frame as { approvalId?: string }).approvalId
            log?.info(
              `run ${runId}: ${frame.kind} (${frame.kind === 'question_asked' ? String(qs?.length ?? '?') + ' questions' : String(ap ?? '')})`,
            )
          }

          // Debt card chain: a duplicate ask frame (recovery channel / reconnect replay) is no longer processed.
          const askId = askIdOf(frame)
          if (askId !== undefined && askId !== '') {
            if (seenAskIds.has(askId)) return
            seenAskIds.add(askId)
          }

          // Debt E1: the shared handling of live frames is in handleTurnFrame; the apiproxy loop keeps only its own
          // difference -- the loud reconnect failure (outcome unknown) and the audit log. All mux frames are
          // live (no hello replay), safe to relay.
          const result = handleTurnFrame(turnState, { pricing, now }, frame, {
            relay: (liveFrame) => input.onFrame?.(liveFrame),
            trackAwaiting,
            armSilence,
            onReconnect: () => {
              // Debt card chain: on a reconnect, first fetch back the question/approval frames lost in the outage
              // window (question/approval are broadcast once) -- if they come back, someone is waiting for an answer, so
              // do not kill the turn; only when they cannot be fetched and nobody is waiting does the A4 loud failure apply.
              void (async () => {
                try {
                  for (const ask of await (upstream.pendingAsks?.(sid) ?? Promise.resolve([]))) {
                    processRecoveredAsk(ask)
                  }
                } catch {
                  // A failing recovery channel does not block the main flow -- fall back to the original A4 decision.
                }
                if (awaitingHuman > 0) {
                  log?.info(`run ${runId}: stream reconnected with ${awaitingHuman} pending human wait(s) — keeping the turn alive`)
                  return
                }
                // Debt A4: the stream reconnected mid-turn -- turn_end may have been lost during the outage and the
                // outcome is unknown. Fail loudly rather than wait silently for the timeout (the money is spent, so the outcome must be visible; check the chat history).
                unsub()
                resolveTurn(finish('failed', 'upstream stream reconnected mid-turn: outcome unknown (the turn may have completed); check the session history'))
              })()
            },
          })
          if (result.kind === 'end') {
            unsub()
            resolveTurn(finish(result.state, result.error))
          }
        })
        // Debt R8: record the unsubscribe function as soon as subscribe returns (the finally uses it as a backstop).
        unsubRef.cleanup = unsub

        // Abort handler: clean up the subscription
        const abortTurn = () => {
          unsub()
          upstream.cancel(sid).catch((cancelError: unknown) => {
            log?.warn(`run ${runId}: cancel failed: ${(cancelError as Error).message}`)
          })
          resolveTurn(finish('failed', cancelledText()))
        }
        if (controller.signal.aborted) abortTurn()
        else controller.signal.addEventListener('abort', abortTurn, { once: true })
      })

      // Debt R8: the prompt and the wait for the outcome go into one try/finally -- whatever the path (rejection, throw,
      // turn end, timeout, reconnect) there is one backstop unsubscribe at the end (unsub is idempotent, so a repeat call is harmless).
      try {
        // Debt card chain: at turn start, first fetch back the question/approval frames the host still holds pending -- they
        // were broadcast in a previous turn or before a restart but this process never received them (a manager restart), and
        // without fetching them the question is never answered. Failures stay silent (the recovery channel is best-effort and does not roll back the main flow).
        try {
          for (const ask of await (upstream.pendingAsks?.(sid) ?? Promise.resolve([]))) {
            processRecoveredAsk(ask)
          }
        } catch {
          // An old facade has no recovery endpoint -> empty.
        }
        armSilence()
        // Send the prompt (also resumes cold sessions: P3 confirmed)
        const promptResult = await upstream.prompt(sid, prompt)
        if (!promptResult.accepted) {
          return finish('failed', 'the prompt was not accepted by the upstream')
        }
        // The prompt mounted it as a side effect (a cold chat is now live): pinning the deferred override here has a high success rate; a failure keeps it for the next try.
        await applyAccessOverride(sid)

        return await turnDone
      } finally {
        if (unsubRef.cleanup !== null) unsubRef.cleanup()
      }
    } catch (error) {
      if (controller.signal.aborted) {
        return finish('failed', cancelledText())
      }
      const message = error instanceof Error ? error.message : String(error)
      log?.error(`run ${runId} failed: ${message}`)
      return finish('failed', message)
    }
  }

  try {
    // Hive P5.4: the first of the git trio -- commit serialisation. A snapshot (git add/commit included)
    // must queue: two turns touching the index at once trample each other on the .lock. The turns themselves run in
    // parallel throughout; this is only the entry point where writes to disk queue up.
    const pre = await withCommitLock(agent.id, () => snapshotBefore(agent.workspacePath, { runId, agentName: agent.name }))
    if (pre.commit !== null) {
      log?.warn(
        `run ${runId}: committed ${pre.files.length} pre-existing change(s) in ${agent.name}'s workspace as ${pre.commit.slice(0, 8)} before starting`,
      )
    }
    if (pre.skipped !== null) log?.warn(`run ${runId}: ${pre.skipped}`)

    // The baseline for conflict detection = the workspace HEAD when this turn started writing to disk.
    const baseline = pre.commit ?? (await currentHead(agent.workspacePath))

    const outcome = await driveTurn()

    // Hive P5.4: the second of the git trio -- making conflicts visible. Before the closing commit, check whether HEAD has
    // been pushed on by a concurrent turn: if so this turn worked from the older state, the conflict goes onto the run row, and nothing stays silent.
    const post = await withCommitLock(agent.id, async () => {
      const headNow = await currentHead(agent.workspacePath)
      if (baseline !== null && headNow !== null && baseline !== headNow) {
        const conflict = `concurrent change: the workspace was committed by another turn while this one ran (HEAD ${baseline.slice(0, 8)} → ${headNow.slice(0, 8)}); this turn worked from the older state`
        deps.db.update(schema.run).set({ conflict }).where(eq(schema.run.id, runId)).run()
        log?.warn(`run ${runId}: ${conflict}`)
      }
      return snapshotAfter(agent.workspacePath, {
        runId,
        agentName: agent.name,
        prompt,
        trigger: input.trigger,
        state: outcome.state,
      })
    })
    if (post.skipped !== null) log?.warn(`run ${runId}: ${post.skipped}`)
    else if (post.commit === null) log?.info(`run ${runId}: changed no files, so there is nothing to commit`)
    else log?.info(`run ${runId}: committed ${post.files.length} file(s) as ${post.commit.slice(0, 8)}`)

    // Stored, not just returned: a cron run's outcome goes to nobody, so this is
    // the only place the run list can learn what the run touched.
    if (post.commit !== null) {
      deps.db.update(schema.run).set({ commitHash: post.commit }).where(eq(schema.run.id, runId)).run()
    }

    const conflictRow = deps.db.select({ conflict: schema.run.conflict }).from(schema.run).where(eq(schema.run.id, runId)).all()
    return {
      ...outcome,
      commit: post.commit,
      changedFiles: post.files,
      snapshotSkipped: post.skipped,
      conflict: conflictRow[0]?.conflict ?? null,
    }
  } finally {
    input.signal?.removeEventListener('abort', stopFromCaller)
    // Hive P5.4: the active set is only a display registration; drop it whatever the outcome.
    const set = activeRuns.get(agent.id)
    if (set !== undefined) {
      set.delete(runId)
      if (set.size === 0) activeRuns.delete(agent.id)
    }
  }
}
