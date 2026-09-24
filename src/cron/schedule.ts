import { randomUUID } from 'node:crypto'
import { Cron } from 'croner'
import { eq } from 'drizzle-orm'
import type { AppConfig } from '../config.js'
import type { Db } from '../db/index.js'
import { schema } from '../db/index.js'
import { dummyGatewayClient, type GatewayClient } from '../gateway/client.js'
import type { SessionDriver } from '../session-driver/port.js'
import { runAgent, type RunInput, type RunOutcome, type RunnerDeps } from '../runner.js'
import { USD_TO_MICRO, currentDay, daySpend } from '../usage/store.js'
import { notify } from '../notify.js'

/**
 * Scheduled runs, which is the first thing in this system that spends money
 * while nobody is watching.
 *
 * That single fact decides every rule below.
 *
 * **No catch-up.** A schedule expresses "do this at 08:00", not "do this once
 * per day whenever you notice". If the manager was down for three days, running
 * three weekly reviews back to back at boot produces three near-identical
 * documents and three bills. Missed occurrences are recorded and dropped.
 *
 * **A skip is not a failure.** Three kinds of not-running are counted
 * separately, because they need different responses and only one of them is the
 * job's fault:
 *
 * | situation | counts toward auto-disable | why |
 * | --- | --- | --- |
 * | the turn failed | yes | the job itself is broken |
 * | the agent was busy | no | contention, not a defect; would disable a healthy job |
 * | over the daily budget | no | working exactly as configured |
 *
 * **Nothing fails silently.** Every attempt that does not run leaves a `run` row
 * carrying the reason, because a cron outcome is returned to no caller. Without
 * the row, "it just stopped happening" would be the only symptom.
 */

export interface CronLog {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

export interface CronDeps {
  db: Db
  config: AppConfig
  clients: Map<string, GatewayClient>
  upstreamClients?: Map<string, SessionDriver>
  log: CronLog
  clock?: () => number
  /** Swapped out in tests so the scheduler can be driven without a gateway. */
  runTurn?: (deps: RunnerDeps, input: RunInput) => Promise<RunOutcome>
}

/** Why an attempt produced no run, or `null` when it did run. */
export type SkipReason = 'disabled' | 'busy' | 'budget' | 'unmeasurable' | 'misconfigured'

export interface CronAttempt {
  cronId: string
  ran: boolean
  skipped: SkipReason | null
  /** Present whether the attempt ran or was recorded as skipped. */
  runId: string | null
  state: 'done' | 'failed' | 'missed'
  message: string | null
}

/**
 * How many scheduled times fell in a window, capped.
 *
 * The cap exists because `since` can be arbitrarily old -- a schedule left
 * disabled for a year, then enabled -- and enumerating every minute of it at
 * boot would stall startup for a number nobody needs precisely.
 */
export const MISSED_CAP = 100

export const missedBetween = (
  pattern: string,
  timezone: string,
  since: number,
  now: number,
  cap = MISSED_CAP,
): number => {
  // `nextRuns` from an explicit anchor, rather than from the current time, is
  // what makes this answer "what should have happened while we were away".
  const upcoming = new Cron(pattern, { timezone }).nextRuns(cap, new Date(since))
  return upcoming.filter((d) => d.getTime() <= now).length
}

/**
 * Whether a pattern and timezone can actually be scheduled.
 *
 * Called before anything is written, so a typo is rejected at the edit rather
 * than becoming a job that throws on load. Returns the reason, or null when fine.
 */
export const scheduleProblem = (pattern: string, timezone: string): string | null => {
  try {
    const probe = new Cron(pattern, { timezone })
    // A pattern can parse and still never fire again -- `0 0 30 2 *` is the
    // classic. Silently never running is worse than being told now.
    if (probe.nextRun() === null) return 'this pattern has no future run time'
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

type CronRow = typeof schema.cron.$inferSelect

export class Scheduler {
  private readonly jobs = new Map<string, Cron>()
  /**
   * Rows that could not be scheduled, kept as data so the UI can show them.
   *
   * One unschedulable row must not stop the other six from loading, so a broken
   * pattern lands here instead of throwing out of `start`.
   */
  private readonly problems = new Map<string, string>()
  private stopped = false

  constructor(private readonly deps: CronDeps) {}

  private now(): number {
    return (this.deps.clock ?? Date.now)()
  }

  private row(cronId: string): CronRow | undefined {
    return this.deps.db.select().from(schema.cron).where(eq(schema.cron.id, cronId)).all()[0]
  }

  /** A `run` row for an attempt that never reached the gateway. */
  private recordSkip(row: CronRow, state: 'missed', message: string): string {
    const runId = randomUUID()
    const at = this.now()
    this.deps.db
      .insert(schema.run)
      .values({
        id: runId,
        agentId: row.agentId,
        cronId: row.id,
        trigger: 'cron',
        state,
        startedAt: at,
        endedAt: at,
        error: message,
      })
      .run()
    return runId
  }

  /**
   * Records what should have happened while the process was not running.
   *
   * `lastRunAt` doubles as "last fire time accounted for" and is advanced to the
   * final missed occurrence, not to now. Advancing it is what stops a second
   * restart from logging the same gap again; using the occurrence rather than
   * now keeps a schedule due in the next few minutes still due.
   */
  private recordMissed(): void {
    const now = this.now()
    const rows = this.deps.db.select().from(schema.cron).where(eq(schema.cron.enabled, 1)).all()
    for (const row of rows) {
      const since = row.lastRunAt ?? row.createdAt
      // A row with neither -- created before migration 6 backfilled zero -- has
      // no meaningful window, and treating epoch 0 as the anchor would report
      // the cap every time.
      if (since <= 0) {
        this.deps.db.update(schema.cron).set({ lastRunAt: now }).where(eq(schema.cron.id, row.id)).run()
        continue
      }
      let count: number
      let last: number | null = null
      try {
        const upcoming = new Cron(row.schedule, { timezone: row.timezone }).nextRuns(MISSED_CAP, new Date(since))
        const passed = upcoming.filter((d) => d.getTime() <= now)
        count = passed.length
        last = passed.length > 0 ? (passed[passed.length - 1] as Date).getTime() : null
      } catch {
        // Reported by `load` below, which is where the operator can act on it.
        continue
      }
      if (count === 0) continue

      const capped = count >= MISSED_CAP
      const message =
        `missed ${capped ? `${MISSED_CAP}+` : count} scheduled run(s) while the manager was not running. ` +
        'Not caught up on purpose: running them now would repeat work and repeat the bill.'
      this.recordSkip(row, 'missed', message)
      this.deps.db
        .update(schema.cron)
        .set({ lastRunAt: last ?? now, lastState: 'missed', lastError: message })
        .where(eq(schema.cron.id, row.id))
        .run()
      this.deps.log.warn(`cron ${row.name}: ${message}`)
    }
  }

  /**
   * The daily ceiling, checked only for unattended runs.
   *
   * A person clicking a button is present and deciding; a schedule firing at
   * 03:00 is not. Gating manual runs on the same number would turn "you are near
   * your budget" into "you cannot use your own tool".
   */
  private budgetBlock(): { reason: SkipReason; message: string } | null {
    const budget = this.deps.config.runner.dailyBudgetMicroUsd
    if (budget === null) return null
    const spent = daySpend(this.deps.db, currentDay(this.now()))
    if (spent.unpriced > 0) {
      return {
        reason: 'unmeasurable',
        message:
          `${spent.unpriced} usage record(s) today have no configured rate, so today's spend cannot be ` +
          'compared against the daily budget. Refusing to run rather than spending blind -- add the ' +
          "model's rate to the pricing section of manager.config.yaml (the spend page names it).",
      }
    }
    if (spent.costMicroUsd >= budget) {
      return {
        reason: 'budget',
        message:
          `today's spend has reached the daily budget ` +
          `($${(spent.costMicroUsd / USD_TO_MICRO).toFixed(4)} of $${(budget / USD_TO_MICRO).toFixed(2)}). ` +
          'Scheduled runs resume tomorrow; a manual run is still allowed.',
      }
    }
    return null
  }

  /**
   * One attempt at one schedule.
   *
   * `force` is the "run it now" button: it ignores both the enabled flag and the
   * budget, because you asked for this one explicitly and are watching it.
   */
  async attempt(cronId: string, force = false): Promise<CronAttempt> {
    const row = this.row(cronId)
    if (row === undefined) {
      return { cronId, ran: false, skipped: 'misconfigured', runId: null, state: 'missed', message: 'no such schedule' }
    }

    const skip = (reason: SkipReason, message: string, record = true): CronAttempt => {
      const runId = record ? this.recordSkip(row, 'missed', message) : null
      this.deps.db
        .update(schema.cron)
        .set({ lastState: 'missed', lastError: message, lastRunAt: this.now() })
        .where(eq(schema.cron.id, row.id))
        .run()
      this.deps.log.warn(`cron ${row.name}: ${message}`)
      return { cronId, ran: false, skipped: reason, runId, state: 'missed', message }
    }

    // Re-read rather than trust what was captured at load: the job may have been
    // switched off in the minutes since, and firing it then would ignore the
    // operator's most recent instruction.
    if (!force && row.enabled !== 1) {
      return { cronId, ran: false, skipped: 'disabled', runId: null, state: 'missed', message: 'schedule is disabled' }
    }

    const agent = this.deps.config.agents[row.agentId]
    if (agent === undefined) {
      return skip('misconfigured', `agent "${row.agentId}" is no longer in manager.config.yaml`)
    }
    const driver = this.deps.config.endpoints[agent.endpoint]?.driver ?? 'gateway'
    const upstream = this.deps.upstreamClients?.get(agent.endpoint)
    const client = this.deps.clients.get(agent.endpoint)
    if (driver === 'apiproxy' && upstream === undefined) {
      return skip('misconfigured', `endpoint "${agent.endpoint}" is apiproxy but has no upstream client`)
    }
    if (driver === 'gateway' && client === undefined) {
      return skip('misconfigured', `endpoint "${agent.endpoint}" is not configured`)
    }

    if (!force) {
      const blocked = this.budgetBlock()
      if (blocked !== null) return skip(blocked.reason, blocked.message)
    }

    const run = this.deps.runTurn ?? runAgent
    try {
      const outcome = await run(
        { db: this.deps.db, pricing: this.deps.config.pricing, log: this.deps.log },
        {
          agent,
          client: client ?? dummyGatewayClient(),
          ...(upstream === undefined ? {} : { upstream }),
          driver,
          prompt: row.prompt,
          trigger: 'cron',
          cronId: row.id,
          timeoutMs: this.deps.config.runner.timeoutMs,
          silenceMs: this.deps.config.runner.silenceMs,
        },
      )
      if (outcome.state === 'done') {
        this.deps.db
          .update(schema.cron)
          .set({ consecutiveFailures: 0, lastRunAt: this.now(), lastState: 'done', lastError: null })
          .where(eq(schema.cron.id, row.id))
          .run()
        this.deps.log.info(`cron ${row.name}: done (${outcome.runId})`)
        notify(this.deps.db, {
          kind: 'cron_done',
          title: `scheduled task finished: ${row.name}`,
          body: outcome.summary ?? '(no output text)',
          // 公开版精简（DAC v1.0.0）：定时任务页已下线，通知改指任务页看这次运行。
          link: '/runs',
        })
        return { cronId, ran: true, skipped: null, runId: outcome.runId, state: 'done', message: null }
      }
      return this.countFailure(row, outcome.error ?? 'the run failed without a reason', outcome.runId)
    } catch (error) {
      // 蜂群 P5.4：不再有「agent 忙」的拒绝——cron 与任何回合一样直接并发跑，
      // 上限由 gateway 名额约束。这里的 catch 只剩真正的故障。
      return this.countFailure(row, error instanceof Error ? error.message : String(error), null)
    }
  }

  /**
   * Counts a real failure and auto-disables at the ceiling.
   *
   * The reason is stored separately from `enabled` so the UI can say the manager
   * did this, and why. A toggle found in the off position with no explanation
   * reads as the operator's own earlier decision.
   */
  private countFailure(row: CronRow, message: string, runId: string | null): CronAttempt {
    const failures = row.consecutiveFailures + 1
    const ceiling = this.deps.config.runner.maxConsecutiveFailures
    const disable = failures >= ceiling
    notify(this.deps.db, {
      kind: 'cron_failed',
      title: `scheduled task failed: ${row.name}${disable ? ' (disabled automatically)' : ''}`,
      body: message,
      // 同上：/crons 页已下线，失败详情去任务页看这一次运行。
      link: '/runs',
    })
    this.deps.db
      .update(schema.cron)
      .set({
        consecutiveFailures: failures,
        lastRunAt: this.now(),
        lastState: 'failed',
        lastError: message,
        ...(disable
          ? {
              enabled: 0,
              disabledReason:
                `switched off automatically after ${failures} consecutive failures. ` +
                `Last error: ${message}. Fix the cause, then switch it back on.`,
            }
          : {}),
      })
      .where(eq(schema.cron.id, row.id))
      .run()
    if (disable) {
      this.jobs.get(row.id)?.stop()
      this.jobs.delete(row.id)
      this.deps.log.error(`cron ${row.name}: disabled after ${failures} consecutive failures -- ${message}`)
    } else {
      this.deps.log.error(`cron ${row.name}: failed (${failures}/${ceiling}) -- ${message}`)
    }
    return { cronId: row.id, ran: true, skipped: null, runId, state: 'failed', message }
  }

  /** Builds a croner job per enabled row. Unschedulable rows become problems. */
  private load(): void {
    for (const job of this.jobs.values()) job.stop()
    this.jobs.clear()
    this.problems.clear()

    const rows = this.deps.db.select().from(schema.cron).where(eq(schema.cron.enabled, 1)).all()
    for (const row of rows) {
      const problem = scheduleProblem(row.schedule, row.timezone)
      if (problem !== null) {
        this.problems.set(row.id, problem)
        this.deps.log.error(`cron ${row.name}: cannot be scheduled -- ${problem}`)
        continue
      }
      try {
        const job = new Cron(
          row.schedule,
          {
            timezone: row.timezone,
            // Croner's own overlap guard. The agent lock would catch it too, but
            // only after a wasted session; this stops it a step earlier.
            protect: (active) => {
              this.deps.log.warn(
                `cron ${row.name}: previous run started ${active.currentRun()?.toISOString() ?? 'earlier'} ` +
                  'is still going, so this occurrence was dropped',
              )
            },
            // Without this the timer alone keeps the process alive, which turns a
            // clean shutdown into a hang.
            unref: true,
          },
          () => {
            // Errors are handled inside `attempt`; this guard is for the
            // unexpected, where an unhandled rejection would take the process
            // down and stop every other schedule with it.
            void this.attempt(row.id).catch((error: unknown) => {
              this.deps.log.error(`cron ${row.name}: attempt threw -- ${String(error)}`)
            })
          },
        )
        this.jobs.set(row.id, job)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.problems.set(row.id, message)
        this.deps.log.error(`cron ${row.name}: cannot be scheduled -- ${message}`)
      }
    }

    const budget = this.deps.config.runner.dailyBudgetMicroUsd
    if (this.jobs.size > 0 && budget === null) {
      this.deps.log.warn(
        `${this.jobs.size} schedule(s) are active with no daily budget configured. ` +
          'Auto-disable only catches a job that keeps failing, not one that keeps succeeding expensively. ' +
          'Set runner.daily_budget_usd in manager.config.yaml.',
      )
    }
  }

  start(): void {
    this.stopped = false
    // Before loading, so a gap is reported once against the state the process
    // woke up to rather than racing the first live fire.
    this.recordMissed()
    this.load()
    this.deps.log.info(`cron: ${this.jobs.size} schedule(s) active`)
  }

  /** Rebuilds every job. Called after any edit, since croner has no re-pattern. */
  reload(): void {
    if (this.stopped) return
    this.load()
  }

  stop(): void {
    this.stopped = true
    for (const job of this.jobs.values()) job.stop()
    this.jobs.clear()
  }

  nextRunAt(cronId: string): number | null {
    return this.jobs.get(cronId)?.nextRun()?.getTime() ?? null
  }

  problemFor(cronId: string): string | null {
    return this.problems.get(cronId) ?? null
  }

  activeCount(): number {
    return this.jobs.size
  }
}
