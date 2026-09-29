/**
 * One reconcile entry (A list #2, the second item of the road-work phase, decided alongside SessionDriver).
 *
 * Four sync paths converge here: the DB registry mirror, leftover run / orphan chat convergence
 * (boot only), the fleet.md derived handout, and managed node adoption (docker adopt / process start).
 * **Boot and every config change (the provision route) go through reconcileAll** -- no new scattered
 * shape branches (the FK incident was a missed branch): a change goes back to the source of truth
 * (config) and this entry converges the derived artifacts.
 */
import { eq, inArray } from 'drizzle-orm'
import type { AppConfig } from '../config.js'
import { schema, type Db } from '../db/index.js'
import { archiveOrphanChats } from '../chat/store.js'
import { sweepIdleConversations } from '../public-api/idle-sweep.js'
import { syncFleetDocs } from '../workspace/fleet-doc.js'
import { syncOutwardAgentDocs } from '../workspace/outward-doc.js'
import type { NodeSupervisor } from '../nodes/supervisor.js'
import { DockerRunner, NODE_LABEL, type DockerRunner as DockerRunnerType } from '../nodes/docker-runner.js'

export interface ReconcileContext {
  db: Db
  config: AppConfig
  supervisors: Map<string, NodeSupervisor>
  docker: DockerRunnerType | null
  log: (line: string) => void
}

export interface MirrorResult {
  inserted: number
  updated: number
  deleted: number
}

/** The minimum fact surface of one mirrored row (provision's DB-first step has only these fields). */
export type AgentRowFace = Pick<
  import('../config.js').ResolvedAgent,
  'id' | 'name' | 'workspacePath' | 'endpoint' | 'preset' | 'gitRemote' | 'public'
>

/**
 * Mirror one agent into the DB registry (insert or update, idempotent).
 * mirrorAgents and provision's DB-first step share this one implementation -- mirroring lives here only.
 */
export const mirrorAgentRow = (db: Db, agent: AgentRowFace): 'inserted' | 'updated' => {
  const rows = db.select({ id: schema.agent.id }).from(schema.agent).where(eq(schema.agent.id, agent.id)).all()
  const values = {
    id: agent.id,
    name: agent.name,
    workspacePath: agent.workspacePath,
    endpoint: agent.endpoint,
    preset: agent.preset,
    gitRemote: agent.gitRemote,
    public: agent.public ? 1 : 0,
    createdAt: Date.now(),
  }
  if (rows.length === 0) {
    db.insert(schema.agent).values(values).run()
    return 'inserted'
  }
  const { createdAt: _ignored, ...rest } = values
  db.update(schema.agent).set(rest).where(eq(schema.agent.id, agent.id)).run()
  return 'updated'
}

/** Delete one agent row (shared by provision rollback and convergence deletes). */
export const removeAgentRow = (db: Db, id: string): void => {
  db.delete(schema.agent).where(eq(schema.agent.id, id)).run()
}

/**
 * The DB registry is a derived artifact of the config: mirror each agent (insert/update) and delete
 * rows whose config is gone -- manager.config.yaml is the only source of truth.
 *
 * removeStale=false (Debt R9: provision's hot-change path): mirror only, no convergence deletes --
 * after a node is deleted its agent row survives for the life of the process (billing and audit FK
 * references), and only reconcileAll at boot / on the periodic tick converges deletes.
 */
export const mirrorAgents = (db: Db, config: AppConfig, removeStale = true): MirrorResult => {
  const known = new Set(Object.keys(config.agents))
  let inserted = 0
  let updated = 0
  for (const agent of Object.values(config.agents)) {
    const result = mirrorAgentRow(db, agent)
    if (result === 'inserted') inserted += 1
    else updated += 1
  }
  let deleted = 0
  if (removeStale) {
    // Convergence delete: an agent row whose config is gone is not kept (FK lesson -- never let a derived artifact remember a deleted truth).
    const all = db.select({ id: schema.agent.id }).from(schema.agent).all()
    for (const row of all) {
      if (!known.has(row.id)) {
        removeAgentRow(db, row.id)
        deleted += 1
      }
    }
  }
  return { inserted, updated, deleted }
}

/**
 * A run only exists inside a manager process: a row still pending/running at boot belongs to a
 * dead process, so it converges to failed.
 */
export const convergeRuns = (db: Db): number => {
  const stale = db
    .update(schema.run)
    .set({ state: 'failed', endedAt: Date.now(), error: 'manager restarted while this run was in flight' })
    .where(inArray(schema.run.state, ['pending', 'running']))
    .run()
  return stale.changes
}

/**
 * Pre-release hardening (2026-09-26): a command interrupted inside the delivery window is also a leftover of the previous process.
 *
 * A row still `delivered` at boot = the agent claimed it but never reported back (usually a manager
 * restart; the 2026-09-24/26 maintenance windows left 2 rows each). It is neither redelivered
 * (claimCommands only takes pending) nor read, yet holds the whole DSH profile bundle forever --
 * 273 KB per row in production, and those 339 KB became the DB's largest block once cleared.
 * Converge to failed and **clear the payload**; `pending` stays and is still delivered.
 */
export const convergeAgentCommands = (db: Db): number => {
  const stale = db
    .update(schema.agentCommand)
    .set({
      state: 'failed',
      doneAt: Date.now(),
      result: JSON.stringify({ message: 'manager restarted while this command was in flight' }),
      payload: '{}',
    })
    .where(eq(schema.agentCommand.state, 'delivered'))
    .run()
  return stale.changes
}

/** Orphan chat archiving: a chat whose agent is gone from the config always 409s agent_gone. */
export const convergeOrphanChats = (db: Db, config: AppConfig): number =>
  archiveOrphanChats(db, new Set(Object.keys(config.agents)))

/** The derived fleet.md handout (one per workspace, synced automatically with the config, idempotent). */
export const convergeFleet = async (config: AppConfig, log: (line: string) => void): Promise<string[]> =>
  syncFleetDocs(config, log)

/**
 * Managed node adoption: a docker runner is reconciled (adopt a running one / pull a missing one /
 * rebuild on a spec mismatch), a process runner is started directly. Idempotent: repeating it on an
 * adopted node never creates a second container.
 *
 * healOnly (for the periodic tick): **only offline and live-state probing are treated** -- a node a
 * human stopped (nodes/down) lands in cold and the tick never grabs it (the same rule as 'a DSH the
 * user started by hand is never taken over'); a live node is health-reconciled through
 * supervisor.probeLive() (Road work A3: consecutive failures flip it offline) and heals in the same
 * tick through restart() (a plain start for a dead process or a docker with no containerId, stop then
 * pull again for a stuck one). Boot runs healOnly=false (cold = never started: start plus full adoption).
 */
export const convergeNodes = async (
  supervisors: Map<string, NodeSupervisor>,
  config: AppConfig,
  docker: DockerRunnerType | null,
  log: (line: string) => void,
  healOnly = false,
  only: Set<string> | null = null,
): Promise<void> => {
  for (const [id, supervisor] of supervisors) {
    // Debt R9: the hot-change path converges only the named nodes (a new provision node / a rollback
    // resync) and never grabs other cold nodes the user stopped by hand. null = all of them (boot).
    if (only !== null && !only.has(id)) continue
    const spec = config.endpoints[id]?.spawn
    if (spec === null || spec === undefined) continue
    if (healOnly) {
      const state = supervisor.current.state
      if (state === 'live') {
        await supervisor.probeLive()
        if (supervisor.current.state === 'offline') {
          log(`node ${id}: live probe failed → restarting (heal)`)
          supervisor.restart(spec)
        }
        continue
      }
      if (state !== 'offline') continue
      log(`node ${id}: offline → restarting (heal)`)
      supervisor.restart(spec)
      continue
    }
    if (spec.runner === 'docker') {
      if (docker === null) {
        log(`node ${id}: runner=docker but docker.sock is unavailable — skipping the start`)
        continue
      }
      try {
        const managed = await docker.listManaged()
        const existing = managed.find((c) => c.labels[NODE_LABEL] === id && c.state === 'running')
        if (existing !== undefined) {
          const facts = await docker.runtimeFacts(existing.id)
          const expectedImageId = spec.docker === null ? null : await docker.imageIdOf(spec.docker.image)
          const expectedKey = config.endpoints[id]?.sandboxKey ?? ''
          const matches = facts !== null && DockerRunner.matchesSpec(facts, expectedKey, expectedImageId)
          if (!matches) {
            log(`node ${id}: container ${existing.name} does not match the current config (GW_KEY/image id) — recreating`)
            await docker.stop(existing.id).catch(() => undefined)
            supervisor.start(spec)
            continue
          }
          log(`node ${id}: adopt container ${existing.name} (${existing.id.slice(0, 12)})`)
          supervisor.adopt(spec, existing.id)
        } else {
          log(`node ${id}: managed (docker ${spec.docker?.image ?? '?'})`)
          supervisor.start(spec)
        }
      } catch (error) {
        log(`node ${id}: docker reconcile failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      continue
    }
    log(`node ${id}: managed (${spec.command} ${spec.args.join(' ')})`)
    supervisor.start(spec)
  }
}

/** The one reconcile entry. runHygiene is on at boot only (the change-event path needs no history convergence). */
export const reconcileAll = async (
  deps: ReconcileContext,
  opts: {
    runHygiene?: boolean
    healOnly?: boolean
    /**
     * Debt R9: node convergence scope. undefined = all of them (boot / the periodic tick);
     * a Set (possibly empty) = only the nodes in it (provision hot change: empty = touch nothing).
     */
    onlyNodes?: Set<string>
    /** Debt R9: false = mirror only, no convergence deletes (the hot-change path keeps deleted agent rows for the life of the process). */
    removeStaleAgents?: boolean
    /**
     * Outward idle reclaim. **On by default** (boot and the periodic tick; a reclaim window has to
     * hold while the manager is up, not only at boot). Set false on the config hot-change path, where
     * a provision action has no business archiving somebody's conversation.
     */
    sweepIdle?: boolean
  } = {},
): Promise<void> => {
  const { db, config, supervisors, docker, log } = deps
  const mirror = mirrorAgents(db, config, opts.removeStaleAgents !== false)
  if (mirror.inserted + mirror.updated + mirror.deleted > 0) {
    log(`registry mirror: +${mirror.inserted} ~${mirror.updated} -${mirror.deleted}`)
  }
  if (opts.runHygiene === true) {
    const stale = convergeRuns(db)
    if (stale > 0) log(`marked ${stale} interrupted run(s) as failed`)
    const dropped = convergeAgentCommands(db)
    if (dropped > 0) log(`marked ${dropped} interrupted agent command(s) as failed (payload cleared)`)
    const orphan = convergeOrphanChats(db, config)
    if (orphan > 0) log(`archived ${orphan} orphan chat(s) whose agent left the config`)
  }
  // Outward idle reclaim (CONCEPTS-ALIGNED.md §6/§8.3): a conversation idle past its service's
  // session_idle_hours is archived, which frees its agent slot and releases the sticky anchor.
  //
  // Deliberately **not** inside the runHygiene block above, and deliberately true on the periodic
  // tick: runHygiene is boot-only because converging in-flight runs would kill live turns on a tick,
  // whereas archiving an idle conversation is safe at any time and is a promise to the operator --
  // enforced only at boot, a conversation that goes idle while the manager is up would survive until
  // the next restart. It rides this existing tick rather than getting a scheduler of its own.
  // Cost: one indexed read of live rows, plus at most one update each.
  if (opts.sweepIdle !== false) {
    const idle = sweepIdleConversations({ db, config })
    if (idle > 0) log(`reclaimed ${idle} idle outward conversation(s)`)
  }
  const fleet = await convergeFleet(config, log)
  if (fleet.length > 0) log(`fleet.md synced: ${fleet.join(', ')}`)
  // The outward agents' workspace rules (platform rules + service persona) ride the same single
  // reconcile entry as fleet.md: boot + change events + the periodic tick, no scheduler of its own.
  const outward = await syncOutwardAgentDocs(config, log)
  if (outward.length > 0) log(`outward AGENTS.md synced: ${outward.join(', ')}`)
  await convergeNodes(supervisors, config, docker, log, opts.healOnly === true, opts.onlyNodes ?? null)
}

/**
 * Road work A2: periodic reconcile. Not started when intervalMs <= 0 (returns a no-op stopper).
 * Returns a stop function (tests and onClose use it to clear the timer); the timer is unref'd so it never holds the process.
 */
export const startPeriodicReconcile = (deps: ReconcileContext, intervalMs: number): (() => void) => {
  if (intervalMs <= 0) return () => {}
  const timer = setInterval(() => {
    void reconcileAll(deps, { healOnly: true }).catch((error: unknown) => {
      deps.log(`periodic reconcile failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }, intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}
