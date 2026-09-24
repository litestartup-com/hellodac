import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import type { Db } from './db/index.js'
import { schema } from './db/index.js'
import type { ResolvedAgent } from './config.js'
import { GatewayError, isAdoptDisabled, type GatewayClient } from './gateway/client.js'
import { errorText } from './errors.js'
import { streamFrames, type GatewayFrame, type TokenUsage } from './gateway/stream.js'
import { DEFAULT_PRICING, type PricingTable } from './pricing.js'
import { withCommitLock } from './workspace/commit-lock.js'
import { currentHead, snapshotAfter, snapshotBefore } from './workspace/snapshot.js'
import type { SessionDriver } from './session-driver/port.js'
import { UpstreamError } from './upstream/rpc.js'
// 债务 E1:回合状态/finish/共享帧处理器已下沉 runner/turn.ts。
import { handleTurnFrame, makeFinish, newTurnState } from './runner/turn.js'

/**
 * Drives one agent turn end to end: acquire a session bounded to the workspace,
 * subscribe, send the instruction, follow the stream to `turn_end`, and record
 * what it cost.
 *
 * 债务 E16:回合驱动语义的完整论证(订阅先于发送/只计 live 帧/逐响应计价/
 * 会话归还/静默超时≠总超时)已固化进 docs/adr/0001-runner-turn-semantics.md,
 * 源码只留此引用。
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
 * The gateway is supposed to make that unanswerable-prompt case impossible
 * (its questionMode: conversation). This is the backstop for when it is not:
 * an older gateway, questionMode: host, or a permission dialog, which cannot be
 * turned into conversation at all. It costs one timer and guarantees that no
 * turn hangs indefinitely regardless of what the other side does.
 */
export const DEFAULT_SILENCE_MS = 5 * 60 * 1000

/**
 * True when two paths denote the same directory.
 *
 * Compared through realpath where possible: on Windows the same directory can
 * be spelled with different case or as an 8.3 short name, and a false mismatch
 * here would block every run.
 */
export const sameDirectory = (a: string, b: string): boolean => {
  const canonical = (p: string): string => {
    try {
      return realpathSync(p)
    } catch {
      return resolve(p)
    }
  }
  const left = canonical(a)
  const right = canonical(b)
  if (left === right) return true
  return process.platform === 'win32' && left.toLowerCase() === right.toLowerCase()
}

export type RunTrigger = 'manual' | 'cron' | 'api' | 'capture' | 'brain'
export type RunState = 'pending' | 'running' | 'done' | 'failed' | 'missed'

export interface RunInput {
  agent: ResolvedAgent
  client: GatewayClient
  /** The apiproxy client, set when driver is 'apiproxy'. */
  upstream?: SessionDriver
  /** Which driver the endpoint uses. Defaults to 'gateway'. */
  driver?: 'gateway' | 'apiproxy'
  prompt: string
  trigger: RunTrigger
  cronId?: string | null
  idempotencyKey?: string | null
  timeoutMs?: number
  /** Cancel after this long with no frames at all; 0 disables. */
  silenceMs?: number
  /**
   * Continue this gateway session instead of creating a fresh one.
   *
   * This is what makes a conversation a conversation: the model only sees the
   * earlier turns because the session is the same one.
   */
  sessionId?: string | null
  /**
   * Keep the gateway session alive after this turn instead of releasing it.
   *
   * Set by a conversation, which continues on the same session and would
   * otherwise pay for a cold resume on every turn. Left unset by one-shot work
   * (cron, a manual run, a capture): those sessions are never continued, and a
   * turn that does not hand its slot back holds one against the gateway's
   * `maxSessions` until DSH restarts. Enough of those and the gateway can
   * neither create nor adopt, which takes the conversations down too.
   *
   * Default is therefore to release: leaking has to be asked for.
   */
  keepSession?: boolean
  /** The chat this turn belongs to, recorded on the run row. */
  chatId?: string | null
  onSession?: (sessionId: string) => void
  signal?: AbortSignal
  /**
   * 蜂群 P2：主脑派工时所在的会话（delegation 帧归属）。与 `chatId` 不同——
   * 后者是「run 写入哪个工作会话」，前者是「谁发起的」。
   */
  sourceChatId?: string | null
  /**
   * Receives every *live* frame, for relaying to browsers.
   *
   * Live only, and for the same reason usage is counted from live frames only:
   * the gateway's `hello` frame replays the entire durable history, so treating
   * it as live would re-emit -- and re-bill -- the whole conversation on every
   * reconnect.
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
  /** turn_end reason as reported by the gateway. */
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
   * 蜂群 P5.4：并发写冲突说明。运行期间工作区被另一个回合提交过时为非空
   * ——本回合基于旧状态工作，文件可能被并发修改。NULL = 无冲突。
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
 * 蜂群 P5.4：每个 agent 的活跃 run 集合（并发）。上限是 gateway 的
 * maxSessions——DSH 自身的会话名额，manager 不再人为串行。这个 map 只
 * 服务于 UI 与路由的「正在进行」展示，不再是拒绝的理由。
 */
const activeRuns = new Map<string, Set<string>>()

/** 任一活跃 run 的 id（UI 的忙点只需要「有没有」）。 */
export const runningRunId = (agentId: string): string | null => {
  const set = activeRuns.get(agentId)
  if (set === undefined || set.size === 0) return null
  return [...set][0] ?? null
}

/** 活跃 run 数（并发度展示）。 */
export const activeRunCount = (agentId: string): number => activeRuns.get(agentId)?.size ?? 0

/**
 * 蜂群 P5.4:每 agent 一把提交锁。回合并行,但 git 快照/提交排队执行——
 * 两个回合同时 git add/commit 会在 index.lock 上互相踩踏。落盘是排队点,
 * 其余全程并行。锁本体在 workspace/commit-lock.ts(fleet.md 同步共用同一把)。
 */

/**
 * Turns an adopt failure into something a person can act on.
 *
 * The gateway funnels every adopt problem through one shape -- 400
 * `adopt_failed` with the real cause only in `detail` (its index.ts:721-723) --
 * so without this the user would see "gateway responded 400" for four situations
 * that need four different responses.
 */
export const adoptFailure = (error: unknown, sessionId: string): string => {
  if (isAdoptDisabled(error)) {
    return (
      `this conversation's DSH session (${sessionId}) is no longer live, and the gateway has session ` +
      'adoption turned off, so it cannot be resumed. The history is still readable. ' +
      'Set allowAdopt on the gateway to continue conversations across restarts.'
    )
  }
  const detail = errorText(error)
  if (detail.includes('session cap reached')) {
    return (
      'the gateway is holding its maximum number of live sessions, so this one could not be resumed. ' +
      'Raise maxSessions on the gateway, or wait for a session to be released.'
    )
  }
  if (detail.includes('session_not_found')) {
    return (
      `the DSH session ${sessionId} no longer exists on the gateway, so this conversation cannot be ` +
      'continued. Start a new one; the history above is kept.'
    )
  }
  if (detail.includes('resume_failed')) {
    return `DSH could not rebuild the session ${sessionId}: ${detail}`
  }
  return error instanceof GatewayError ? error.message : String(error)
}

export const runAgent = async (deps: RunnerDeps, input: RunInput): Promise<RunOutcome> => {
  const now = deps.clock ?? Date.now
  const log = deps.log
  const { agent, client, prompt } = input
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
   */
  let awaitingHuman = 0
  const trackAwaiting = (frame: GatewayFrame) => {
    switch (frame.kind) {
      case 'question_asked':
      case 'approval_pending':
        awaitingHuman += 1
        return
      case 'question_resolved':
      case 'approval_resolved':
        awaitingHuman = Math.max(0, awaitingHuman - 1)
        return
      case 'hello': {
        // A stream can open onto a session that is already waiting on something.
        const questions = Array.isArray(frame.questions) ? frame.questions.length : 0
        const approvals = Array.isArray(frame.approvals) ? frame.approvals.length : 0
        awaitingHuman = questions + approvals
        return
      }
      case 'turn_end':
        awaitingHuman = 0
        return
      default:
        return
    }
  }

  const armSilence = () => {
    if (silenceMs <= 0) return
    clearSilence()
    if (awaitingHuman > 0) return
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
        "keeps happening set the gateway's questions/approvals to 'gateway' so they arrive here, and " +
        "check the deployment's approval policy."
      : `no response within ${Math.round(timeoutMs / 1000)}s; the turn was cancelled`

  // 债务 E1:回合可变状态显式化为一个对象——两个回合循环、共享帧处理器
  // (runner/turn.ts)与 finish 都读写它,替代旧实现闭包捕获的一把 let。
  const turnState = newTurnState()
  let timedOut = false

  // Accumulated per response, because the rate depends on when each one landed.
  const pricing = deps.pricing ?? DEFAULT_PRICING

  // 债务 E1:finish 下沉 runner/turn.ts(maker 入参 = 状态对象 + 落库依赖),
  // 幂等语义(债务 R8)一并下沉。
  const clearTimers = (): void => {
    clearTimeout(timer)
    clearSilence()
  }
  const finish = makeFinish(turnState, {
    runId,
    db: deps.db,
    now,
    startedAt,
    ...(log === undefined ? {} : { log }),
    clearTimers,
  })

  // ---- gateway turn (existing path) ----

  const turnGateway = async (): Promise<RunOutcome> => {
    try {
      let cwd: string | null | undefined

      if (input.sessionId === undefined || input.sessionId === null) {
        const created = await client.createSession({
          cwd: agent.workspacePath,
          ...(agent.provider === undefined || agent.provider === null ? {} : { provider: agent.provider }),
          ...(agent.model === undefined || agent.model === null ? {} : { model: agent.model }),
        })
        turnState.sessionId = created.sessionId
        turnState.provider = created.provider ?? agent.provider ?? null
        turnState.model = created.model ?? agent.model ?? null
        cwd = created.cwd
      } else {
        // Adopt rather than send-and-retry-on-404.
        //
        // The gateway holds sessions in an in-memory map, so a DSH restart or its
        // maxSessions cap turns a session cold, and both `messages` and `stream`
        // answer 404 for a cold session. `adopt` is idempotent -- it returns the
        // live entry untouched when one exists (gateway index.ts:570-573) -- so
        // one unconditional call covers both the warm and the cold case.
        turnState.sessionId = input.sessionId
        let adopted
        try {
          adopted = await client.adopt(input.sessionId)
        } catch (error) {
          return finish('failed', adoptFailure(error, input.sessionId))
        }
        turnState.provider = adopted.provider ?? agent.provider ?? null
        turnState.model = adopted.model ?? agent.model ?? null
        cwd = adopted.cwd
      }

      // The gateway does not take a sandbox mode, and `cwd` is only the session's
      // working directory -- the real write boundary is the DSH process's own
      // sandboxPolicy.workspaceRoot, which manager cannot set. Worse, with
      // workspaceMode 'auto' the gateway may remap cwd to a workspace's canonical
      // path (dsh-api-gateway/src/index.ts:504-509).
      //
      // So verify where the session actually landed. Checked on the adopt path too,
      // not just on creation: a resumed session reports the cwd DSH rebuilt it
      // with, which is not guaranteed to be the one it was created with.
      if (cwd !== null && cwd !== undefined && !sameDirectory(cwd, agent.workspacePath)) {
        return finish(
          'failed',
          `the gateway placed the session in ${cwd} instead of ${agent.workspacePath}. ` +
            'Check the DSH profile\'s workspaceMode and sandboxPolicy.workspaceRoot; ' +
            'a session outside the agent workspace would write to the wrong place.',
        )
      }
      if (cwd === null || cwd === undefined) {
        log?.warn(
          `run ${runId}: the gateway reported no cwd, so the session's write location is whatever the DSH profile defaults to`,
        )
      }

      deps.db.update(schema.run).set({ dshSessionId: turnState.sessionId }).where(eq(schema.run.id, runId)).run()
      if (turnState.sessionId !== null) input.onSession?.(turnState.sessionId)
      log?.info(`run ${runId}: session ${turnState.sessionId} on ${client.id}, cwd=${agent.workspacePath}`)

      const frames = streamFrames(client.streamUrl(turnState.sessionId), {
        headers: client.headers(),
        signal: controller.signal,
      })

      armSilence()
      let sent = false
      // 债务 E1:直播帧的共享处理在 runner/turn.ts 的 handleTurnFrame;
      // gateway 循环只留自己的差异——hello 回放与发消息时机。
      const frameHooks = {
        relay: (frame: GatewayFrame) => input.onFrame?.(frame),
        trackAwaiting,
        armSilence,
      }
      for await (const frame of frames) {
        if (frame.kind === 'hello') {
          // Deliberately ignoring frame.log: it is history, and counting its usage
          // would bill previous turns again. awaiting 计数与静默重挂和直播帧同序。
          trackAwaiting(frame)
          armSilence()
          if (!sent) {
            await client.sendMessage(turnState.sessionId, prompt)
            sent = true
          }
          continue
        }

        const result = handleTurnFrame(turnState, { pricing, now }, frame, frameHooks)
        if (result.kind === 'end') return finish(result.state, result.error)
      }

      // The stream ended without turn_end: the gateway keeps subscriptions open,
      // so this means the connection dropped or the abort fired.
      if (timedOut || controller.signal.aborted) {
        return finish('failed', cancelledText())
      }
      if (!sent) return finish('failed', 'the stream closed before the instruction could be sent')
      return finish('failed', 'the stream ended before the turn finished')
    } catch (error) {
      const aborted = controller.signal.aborted
      if (aborted) {
        timedOut = true
        // Cancelled rather than released here: the session may still be wanted
        // (a chat turn that timed out is still a chat), and the release decision
        // belongs to the cleanup below, which knows whether it is.
        if (turnState.sessionId !== null) {
          await client.cancel(turnState.sessionId).catch((cancelError: unknown) => {
            log?.warn(`run ${runId}: cancel failed: ${(cancelError as Error).message}`)
          })
        }
        return finish('failed', cancelledText())
      }
      const message = error instanceof GatewayError ? error.message : (error as Error).message
      log?.error(`run ${runId} failed: ${message}`)
      return finish('failed', message)
    }
  }

  // ---- apiproxy turn (new path) ----

  const turnApiproxy = async (): Promise<RunOutcome> => {
    // 债务 E10:显式判空——driver=apiproxy 而没有上游 client 是接线错误,必须
    // 显性失败而不是让 undefined 在 subscribe 处炸成难懂的 TypeError。
    const upstream = input.upstream
    if (upstream === undefined) {
      return finish('failed', 'apiproxy driver selected but no upstream client is wired for this endpoint')
    }

    /**
     * 钉入延迟生效的沙箱覆盖（chat.accessModeOverride）并清空。
     * 宿主只允许钉 live 会话：create 分支在刚建时调、resume 分支在 prompt
     * （附带挂载冷会话）之后调。失败保留覆盖下次再试，绝不影响回合本身。
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

    try {
      // apiproxy has no adopt/resume concept; prompt is the universal entry.
      // For a new session, create first; for an existing one, just prompt.
      if (input.sessionId === undefined || input.sessionId === null) {
        const created = await upstream.createSession(agent.workspacePath, agent.preset)
        turnState.sessionId = created.sessionId
        turnState.provider = created.provider ?? agent.provider ?? null
        turnState.model = created.model ?? agent.model ?? null
        // 蜂群 P0：在首次 prompt 之前把沙箱模式钉在会话上（sandbox/mode 日志
        // 事件，冷醒 replay 恢复，一次即持久）。续接路径的模式在创建时已设过。
        if (agent.sandboxMode !== null) {
          // 端口可选能力：无此能力的插头跳过（facade 插头必实现）。
          await upstream.setSandboxMode?.(turnState.sessionId, agent.sandboxMode)
        }
        // 会话刚建 = live：延迟生效的沙箱覆盖在此刻钉入（chat.accessModeOverride，
        // 2026-09-11：宿主只允许钉 live 会话，回合间隙的切换请求由 runner 代劳）。
        await applyAccessOverride(turnState.sessionId)
      } else {
        turnState.sessionId = input.sessionId
        turnState.provider = agent.provider ?? null
        turnState.model = agent.model ?? null
      }

      deps.db.update(schema.run).set({ dshSessionId: turnState.sessionId }).where(eq(schema.run.id, runId)).run()
      if (turnState.sessionId !== null) input.onSession?.(turnState.sessionId)
      log?.info(`run ${runId}: session ${turnState.sessionId} on ${upstream.id} (apiproxy), cwd=${agent.workspacePath}`)

      // 债务 E10:显式收窄——create 分支保证 sessionId 非空,闭包前取局部避免 `!`
      const sid = turnState.sessionId
      if (sid === null) return finish('failed', 'no session id after create/continue')

      // Subscribe to mux BEFORE sending the prompt, so we catch all frames.
      // 债务 R8:unsub 存进引用盒(闭包内赋值,外部 finally 读取)——prompt 拒绝/
      // 抛错等提前返回路径不再遗留订阅(旧代码只在 turn_end/重连/abort 里退订)。
      const unsubRef: { cleanup: (() => void) | null } = { cleanup: null }
      // 债务卡片链(2026-09-17):本回合见过的 ask 帧 id——恢复通道(pendingAsks)
      // 与重连重放会带来重复帧,按 id 去重(重复 question_asked 会重复计
      // awaitingHuman、重复画卡)。
      const seenAskIds = new Set<string>()
      const askIdOf = (frame: GatewayFrame): string | undefined => {
        if (frame.kind === 'question_asked') return typeof frame.questionId === 'string' ? frame.questionId : undefined
        if (frame.kind === 'approval_pending') return typeof frame.decisionId === 'string' ? frame.decisionId : undefined
        return undefined
      }
      // 恢复帧与直播帧同款处理(计 awaitingHuman + 转发前端);question/approval
      // 帧不会触发回合结束,返回值只用 end 判别(理论上到不了)。
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
          // 审计留痕：主脑/agent 问人、要授权的帧到达即记一行，方便事后追溯
          // 「卡没出现」类问题的断点定位（第一次踩坑 2026-09-05）。
          if (frame.kind === 'question_asked' || frame.kind === 'approval_pending') {
            const qs = (frame as { questions?: unknown[] }).questions
            const ap = (frame as { approvalId?: string }).approvalId
            log?.info(
              `run ${runId}: ${frame.kind} (${frame.kind === 'question_asked' ? String(qs?.length ?? '?') + ' questions' : String(ap ?? '')})`,
            )
          }

          // 债务卡片链:重复 ask 帧(恢复通道/重连重放)不再处理。
          const askId = askIdOf(frame)
          if (askId !== undefined && askId !== '') {
            if (seenAskIds.has(askId)) return
            seenAskIds.add(askId)
          }

          // 债务 E1:直播帧的共享处理在 handleTurnFrame;apiproxy 循环只留自己
          // 的差异——重连显性失败(结果未知)与审计日志。All mux frames are
          // live (no hello replay), safe to relay.
          const result = handleTurnFrame(turnState, { pricing, now }, frame, {
            relay: (liveFrame) => input.onFrame?.(liveFrame),
            trackAwaiting,
            armSilence,
            onReconnect: () => {
              // 债务卡片链:重连先向宿主要回断线窗口丢掉的问答/授权帧
              // (question/approval 只广播一次)——要回了 = 有人在等作答,
              // 不杀回合;要不到且无人等作答才走 A4 显性失败。
              void (async () => {
                try {
                  for (const ask of await (upstream.pendingAsks?.(sid) ?? Promise.resolve([]))) {
                    processRecoveredAsk(ask)
                  }
                } catch {
                  // 恢复通道失败不阻断主流程——退回原 A4 判定。
                }
                if (awaitingHuman > 0) {
                  log?.info(`run ${runId}: stream reconnected with ${awaitingHuman} pending human wait(s) — keeping the turn alive`)
                  return
                }
                // 债务 A4:流在回合中重连——turn_end 可能已丢在断线期间,结果未知。
                // 显性失败而非静默等超时(钱花了,结果必须可见,请查会话历史)。
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
        // 债务 R8:subscribe 返回后立即记下退订函数(finally 兜底用)。
        unsubRef.cleanup = unsub

        // Abort handler: clean up the subscription
        const abortTurn = () => {
          unsub()
          timedOut = true
          upstream.cancel(sid).catch((cancelError: unknown) => {
            log?.warn(`run ${runId}: cancel failed: ${(cancelError as Error).message}`)
          })
          resolveTurn(finish('failed', cancelledText()))
        }
        if (controller.signal.aborted) abortTurn()
        else controller.signal.addEventListener('abort', abortTurn, { once: true })
      })

      // 债务 R8:prompt 与等待结果整体进 try/finally——拒绝/抛错/回合结束/
      // 超时/重连任何路径,最后都兜底退订一次(unsub 幂等,重复调用无害)。
      try {
        // 债务卡片链:回合开始先取回宿主仍挂起的问答/授权帧——上一回合/重启前
        // 广播过但本进程没收到(manager 重启),不取回则问句永久无人应答。
        // 失败静默(恢复通道是尽力而为,不回滚主流程)。
        try {
          for (const ask of await (upstream.pendingAsks?.(sid) ?? Promise.resolve([]))) {
            processRecoveredAsk(ask)
          }
        } catch {
          // 旧 facade 无恢复端点 → 空。
        }
        armSilence()
        // Send the prompt (also resumes cold sessions: P3 confirmed)
        const promptResult = await upstream.prompt(sid, prompt)
        if (!promptResult.accepted) {
          return finish('failed', 'the prompt was not accepted by the upstream')
        }
        // prompt 附带挂载（冷会话已转 live）：此刻钉延迟覆盖成功率高；失败保留下次再试。
        await applyAccessOverride(sid)

        return await turnDone
      } finally {
        if (unsubRef.cleanup !== null) unsubRef.cleanup()
      }
    } catch (error) {
      if (controller.signal.aborted) {
        return finish('failed', cancelledText())
      }
      const message = error instanceof UpstreamError ? error.message
        : error instanceof GatewayError ? error.message
          : (error as Error).message
      log?.error(`run ${runId} failed: ${message}`)
      return finish('failed', message)
    }
  }

  const turn = (input.driver ?? 'gateway') === 'apiproxy' ? turnApiproxy : turnGateway

  try {
    // 蜂群 P5.4：git 层三件套之一——提交串行化。快照（含 git add/commit）
    // 必须排队执行：两个回合同时动 index 会在 .lock 上互相踩踏。回合本身
    // 全程并行，这里只是落盘排队的入口。
    const pre = await withCommitLock(agent.id, () => snapshotBefore(agent.workspacePath, { runId, agentName: agent.name }))
    if (pre.commit !== null) {
      log?.warn(
        `run ${runId}: committed ${pre.files.length} pre-existing change(s) in ${agent.name}'s workspace as ${pre.commit.slice(0, 8)} before starting`,
      )
    }
    if (pre.skipped !== null) log?.warn(`run ${runId}: ${pre.skipped}`)

    // 冲突检测的基线 = 本回合开始落盘时的工作区 HEAD。
    const baseline = pre.commit ?? (await currentHead(agent.workspacePath))

    const outcome = await turn()

    // 蜂群 P5.4：git 层三件套之二——冲突显性化。结束提交前看 HEAD 是否已
    // 被并发回合推走：是则本回合基于旧状态工作，冲突写进 run 行，绝不静默。
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
    // Handed back before the lock is dropped, so the next run cannot be refused
    // by `maxSessions` over a session this run has finished with.
    //
    // In `finally` because a thrown snapshot must not turn into a leaked slot,
    // and the failure is swallowed for the same reason the snapshot's is: the
    // turn already ran and was already paid for, so its outcome must not be lost
    // to a cleanup error. The gateway keeps the transcript either way, so the
    // worst case is a slot that stays held until DSH restarts -- visible in the
    // log, and recoverable.
    // apiproxy has no slot management; only gateway sessions need releasing.
    if ((input.driver ?? 'gateway') === 'gateway' && input.keepSession !== true && turnState.sessionId !== null) {
      try {
        await client.release(turnState.sessionId)
      } catch (error) {
        log?.warn(
          `run ${runId}: could not hand session ${turnState.sessionId} back to the gateway, ` +
            `so it still counts against maxSessions: ${(error as Error).message}`,
        )
      }
    }

    // 蜂群 P5.4：会话名额在任何提交/释放之前归还；活跃集合只登记展示。
    const set = activeRuns.get(agent.id)
    if (set !== undefined) {
      set.delete(runId)
      if (set.size === 0) activeRuns.delete(agent.id)
    }
  }
}
