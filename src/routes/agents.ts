import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import { and, asc, count, desc, eq, lt } from 'drizzle-orm'
import { z } from 'zod'
import { schema, type Db } from '../db/index.js'
import type { AuditKind } from '../audit.js'
import { MANAGER_VERSION } from '../version.js'

/**
 * Capability four (Fleet, M1-2/M1-3): the node-agent registration chain + the command and event channel.
 *
 * Three surfaces:
 * - The user surface (requireUser): issue a join / list agents / revoke;
 * - The agent surface (Bearer agentToken): register (exchange a join token for an identity),
 *   commands long polling (claim commands), events (report results / heartbeats / log chunks).
 * The network surface: the agent dials in from a remote, with no brain-surface private-network gate -- a one-shot token + rate limiting + Bearer as the backstop.
 */

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')

export const JOIN_TOKEN_TTL_MS = 15 * 60_000
/** Heartbeat timeout: no authenticated appearance for longer than this = offline (the agent polls about every 30s, so three cycles are the backstop). */
export const AGENT_OFFLINE_MS = 90_000
/** M4-1: the rotation grace period -- the old token still works inside this window (so a lost ack does not brick the machine). */
export const ROTATION_GRACE_MS = 30 * 60_000
/** The maximum wait for one long poll. */
const MAX_WAIT_MS = 25_000
/** The agent log ring buffer (in memory, keyed by agent:node, 64KB each -- design section 5.2). */
export const AGENT_LOG_RING_BYTES = 64 * 1024

export const COMMAND_TYPES = ['node.spawn', 'node.stop', 'node.restart', 'node.logs', 'node.status', 'config.deliver', 'agent.update'] as const
export type AgentCommandType = (typeof COMMAND_TYPES)[number]

const commandTypeSchema = z.enum(COMMAND_TYPES)

const registerBody = z.object({
  joinToken: z.string().min(1).max(200),
  hostname: z.string().min(1).max(128),
  os: z.string().min(1).max(64),
  arch: z.string().min(1).max(32),
  nodeVersion: z.string().min(1).max(32),
  /** M4-3: the agent runtime version (self-update negotiation; an old agent does not report it = null by default). */
  agentVersion: z.string().min(1).max(32).optional(),
})

const eventsBody = z.object({
  events: z.array(z.discriminatedUnion('type', [
    z.object({ type: z.literal('command_result'), commandId: z.number().int().positive(), ok: z.boolean(), result: z.unknown().optional() }),
    z.object({ type: z.literal('heartbeat'), detail: z.record(z.string(), z.unknown()).optional() }),
    z.object({ type: z.literal('log_chunk'), nodeId: z.string().min(1).max(64), chunk: z.string().max(32_000) }),
  ])).max(100),
})

/** Find the non-revoked agent row by agentToken; not found or revoked = null.
 * M4-1: an old token still authenticates inside the rotation grace period (the prev slot, cleared after the ack). */
export const findAgentByToken = (db: Db, token: string): { id: string; hostname: string; os: string; arch: string; nodeVersion: string } | null => {
  const digest = hashToken(token)
  const row = db.select().from(schema.agentMachine).where(eq(schema.agentMachine.tokenHash, digest)).all()[0]
    ?? db.select().from(schema.agentMachine).where(eq(schema.agentMachine.prevTokenHash, digest)).all()[0]
  if (row === undefined || row.revokedAt !== null) return null
  const prevMatches = row.tokenHash !== digest
  if (prevMatches && (row.prevSetAt === null || Date.now() - row.prevSetAt > ROTATION_GRACE_MS)) return null
  return { id: row.id, hostname: row.hostname, os: row.os, arch: row.arch, nodeVersion: row.nodeVersion }
}

// ---- The command queue (the database is the truth source; in-memory waiters only serve as a wake-up) ----
const waiters = new Map<string, Array<() => void>>()

const wake = (agentId: string): void => {
  const list = waiters.get(agentId)
  if (list === undefined) return
  waiters.delete(agentId)
  for (const done of list) done()
}

/** Enqueue on the manager side (used by the supervisor and for derived dispatch); returns the command id. */
export const enqueueAgentCommand = (db: Db, agentId: string, type: AgentCommandType, payload: unknown): number => {
  const result = db.insert(schema.agentCommand).values({
    agentId,
    type,
    payload: JSON.stringify(payload ?? null),
    state: 'pending',
    result: null,
    createdAt: Date.now(),
    deliveredAt: null,
    doneAt: null,
  }).run()
  const id = Number(result.lastInsertRowid)
  wake(agentId)
  return id
}

/** Atomically claim all pending commands of this agent (no concurrent race with a single connection, and the conditional update is a second safety net). */
const claimCommands = (db: Db, agentId: string): Array<{ id: number; type: AgentCommandType; payload: unknown }> => {
  const rows = db.select().from(schema.agentCommand)
    .where(and(eq(schema.agentCommand.agentId, agentId), eq(schema.agentCommand.state, 'pending')))
    .orderBy(asc(schema.agentCommand.id))
    .all()
  const claimed: Array<{ id: number; type: AgentCommandType; payload: unknown }> = []
  for (const row of rows) {
    const res = db.update(schema.agentCommand)
      .set({ state: 'delivered', deliveredAt: Date.now() })
      .where(and(eq(schema.agentCommand.id, row.id), eq(schema.agentCommand.state, 'pending')))
      .run()
    if (res.changes === 0) continue
    let payload: unknown = null
    try {
      payload = JSON.parse(row.payload) as unknown
    } catch {
      payload = null
    }
    if (commandTypeSchema.safeParse(row.type).success) claimed.push({ id: row.id, type: row.type as AgentCommandType, payload })
  }
  return claimed
}

// ---- The agent log ring buffer (in memory) ----
const logRing = new Map<string, string>()
const appendLog = (agentId: string, nodeId: string, chunk: string): void => {
  const key = `${agentId}:${nodeId}`
  const next = `${logRing.get(key) ?? ''}${chunk}`
  logRing.set(key, next.length > AGENT_LOG_RING_BYTES ? next.slice(next.length - AGENT_LOG_RING_BYTES) : next)
}

/** Read by the UI and the log drawer (M1-7). */
export const readAgentLog = (agentId: string, nodeId: string): string => logRing.get(`${agentId}:${nodeId}`) ?? ''

// ---- Command result subscription (used by the supervisor's agent branch: a spawn failure fails fast instead of waiting for the ready timeout) ----
const resultSubs = new Set<(commandId: number, ok: boolean) => void>()

/** Subscribe to command results; returns the unsubscribe function. */
export const subscribeAgentCommandResults = (cb: (commandId: number, ok: boolean) => void): (() => void) => {
  resultSubs.add(cb)
  return () => {
    resultSubs.delete(cb)
  }
}

/** Bearer token -> agent id; it returns only when the token is valid and matches the route's :id (no existence is leaked). */
const channelAgent = (db: Db, request: FastifyRequest, id: string): string | null => {
  const header = request.headers.authorization
  const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : ''
  if (token === '') return null
  const agent = findAgentByToken(db, token)
  if (agent === null || agent.id !== id) return null
  return agent.id
}

export const registerAgentsRoutes = (
  app: FastifyInstance,
  db: Db,
  requireUser: preHandlerHookHandler,
  /** The audit callback (injected by the wiring; tests may omit it). */
  audit?: (actor: string, kind: AuditKind, detail: string) => void,
  /**
   * Incident regression (the ubuntu-focal loss of contact on 2026-09-25): reconciling the Fleet heals itself when an agent
   * recovers from offline. The watchdog only notifies and does not heal, so a node would wait out the periodic reconcile
   * (10 minutes by default), and right after a host reboot comes exactly the window where "the agent is back, the node is not up yet".
   * The injecting side is responsible for converging only the nodes under that agent (the healOnly semantics: a cold node a human stopped by hand stays put).
   */
  onAgentRecover?: (agentId: string) => void,
): void => {
  /**
   * Incident regression (the ubuntu-focal loss of contact on 2026-09-25): refresh lastSeenAt and report whether it was already
   * offline before this call. The order is read then write -- reversed, the edge is never seen and the self-healing never triggers.
   * The commands long poll and the events report both count as evidence of being online (the agent sends both every 25s).
   */
  const touchHeartbeat = (agentId: string): void => {
    const priorSeen = db
      .select({ lastSeenAt: schema.agentMachine.lastSeenAt })
      .from(schema.agentMachine)
      .where(eq(schema.agentMachine.id, agentId))
      .all()[0]
    const wasOffline = priorSeen === undefined
      || priorSeen.lastSeenAt === null
      || Date.now() - priorSeen.lastSeenAt > AGENT_OFFLINE_MS
    db.update(schema.agentMachine).set({ lastSeenAt: Date.now() }).where(eq(schema.agentMachine.id, agentId)).run()
    if (wasOffline) onAgentRecover?.(agentId)
  }

  // ---- The user surface: issue a one-shot join token ----
  app.post(
    '/api/agents/join',
    { preHandler: requireUser, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const token = randomBytes(24).toString('base64url')
      const expiresAt = Date.now() + JOIN_TOKEN_TTL_MS
      db.insert(schema.agentJoinToken).values({
        tokenHash: hashToken(token),
        expiresAt,
        usedAt: null,
        createdAt: Date.now(),
      }).run()
      audit?.(request.currentUser?.username ?? 'unknown', 'agent_join_issued', `join token issued (valid for ${Math.round(JOIN_TOKEN_TTL_MS / 60_000)} minutes)`)
      return reply.send({ token, expiresAt })
    },
  )

  // ---- The agent surface: exchange a join token for the agent identity ----
  app.post(
    '/api/internal/agents/register',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = registerBody.safeParse(request.body)
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', detail: 'joinToken/hostname/os/arch/nodeVersion are required' })
      const { joinToken, hostname, os, arch, nodeVersion, agentVersion } = parsed.data

      const joinRow = db.select().from(schema.agentJoinToken).where(eq(schema.agentJoinToken.tokenHash, hashToken(joinToken))).all()[0]
      if (joinRow === undefined || joinRow.usedAt !== null || joinRow.expiresAt <= Date.now()) {
        return reply.code(401).send({ error: 'join_token_invalid', hint: 'the join token is invalid, already used or expired — issue a fresh one-time join token in the manager' })
      }
      db.update(schema.agentJoinToken).set({ usedAt: Date.now() }).where(eq(schema.agentJoinToken.tokenHash, hashToken(joinToken))).run()

      const agentId = `agent-${randomBytes(6).toString('hex')}`
      const agentToken = randomBytes(32).toString('base64url')
      db.insert(schema.agentMachine).values({
        id: agentId,
        hostname,
        os,
        arch,
        nodeVersion,
        tokenHash: hashToken(agentToken),
        joinedAt: Date.now(),
        lastSeenAt: Date.now(),
        revokedAt: null,
        prevTokenHash: null,
        prevSetAt: null,
        agentVersion: agentVersion ?? null,
      }).run()
      audit?.(agentId, 'agent_registered', `${hostname} ${os}/${arch} node ${nodeVersion}`)
      return reply.send({ agentId, agentToken })
    },
  )

  // ---- The agent surface: claim commands by long polling ----
  app.get<{ Params: { id: string }; Querystring: { wait?: string } }>(
    '/api/internal/agents/:id/commands',
    { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const agentId = channelAgent(db, request, request.params.id)
      if (agentId === null) {
        const header = request.headers.authorization
        const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : ''
        const known = token !== '' && findAgentByToken(db, token) !== null
        return known
          ? reply.code(404).send({ error: 'unknown_agent' })
          : reply.code(401).send({ error: 'unauthorized' })
      }
      // Any authenticated request refreshes the heartbeat (by design the heartbeat rides along with the poll); offline -> online triggers the Fleet self-healing
      touchHeartbeat(agentId)

      const waitRaw = Number(request.query.wait ?? MAX_WAIT_MS)
      const waitMs = Number.isFinite(waitRaw) ? Math.min(Math.max(waitRaw, 0), MAX_WAIT_MS + 5_000) : MAX_WAIT_MS
      let commands = claimCommands(db, agentId)
      if (commands.length === 0 && waitMs > 0) {
        await new Promise<void>((resolve) => {
          let settled = false
          const finish = (): void => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve()
          }
          const list = waiters.get(agentId) ?? []
          list.push(finish)
          waiters.set(agentId, list)
          const timer = setTimeout(() => {
            const cur = waiters.get(agentId) ?? []
            const idx = cur.indexOf(finish)
            if (idx >= 0) cur.splice(idx, 1)
            finish()
          }, waitMs)
        })
        commands = claimCommands(db, agentId)
      }
      return reply.send({ commands })
    },
  )

  // ---- The agent surface: report results / heartbeats / logs ----
  app.post<{ Params: { id: string } }>(
    '/api/internal/agents/:id/events',
    { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const agentId = channelAgent(db, request, request.params.id)
      if (agentId === null) {
        const header = request.headers.authorization
        const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : ''
        const known = token !== '' && findAgentByToken(db, token) !== null
        return known
          ? reply.code(404).send({ error: 'unknown_agent' })
          : reply.code(401).send({ error: 'unauthorized' })
      }
      // Incident regression: decide whether it was already offline before this request first, then refresh lastSeenAt -- reversed,
      // the edge can never be seen again and the self-healing never triggers. Any authenticated arrival counts as evidence of being online (heartbeat / report / log).
      touchHeartbeat(agentId)

      const parsed = eventsBody.safeParse(request.body)
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', detail: 'an events array (command_result/heartbeat/log_chunk)' })

      for (const event of parsed.data.events) {
        if (event.type === 'command_result') {
          // Claim only the delivered commands of this agent itself; idempotent (a repeated report is ignored by the conditional update)
          //
          // The payload serves delivery alone: the claim path reads `state='pending'` only (claimCommands),
          // and after a terminal state there is no read point at all. Yet a node.spawn payload carries a **whole DSH profile
          // bundle** -- measured in production, 99 rows averaged 273 KB, taking 32.8 MB of the database's 34 MB,
          // and every encrypted backup copies it along. So it is cleared in place on reaching a terminal state (the column is notNull,
          // so empty JSON keeps the contract); the history survives on type/state/result/doneAt.
          const updated = db.update(schema.agentCommand)
            .set({
              state: event.ok ? 'done' : 'failed',
              result: JSON.stringify(event.result ?? null),
              doneAt: Date.now(),
              payload: '{}',
            })
            .where(and(
              eq(schema.agentCommand.id, event.commandId),
              eq(schema.agentCommand.agentId, agentId),
              eq(schema.agentCommand.state, 'delivered'),
            ))
            .run()
          if (updated.changes > 0) {
            for (const cb of resultSubs) cb(event.commandId, event.ok)
            // M4-1: the config.deliver (identity rotation) ack -> the grace slot converges --
            // success = clear prev; failure = roll the main token back (the agent still holds the old token).
            const cmd = db.select().from(schema.agentCommand).where(eq(schema.agentCommand.id, event.commandId)).all()[0]
            if (cmd?.type === 'config.deliver') {
              if (event.ok) {
                db.update(schema.agentMachine).set({ prevTokenHash: null, prevSetAt: null }).where(eq(schema.agentMachine.id, agentId)).run()
              } else {
                const machine = db.select().from(schema.agentMachine).where(eq(schema.agentMachine.id, agentId)).all()[0]
                if (machine !== undefined && machine.prevTokenHash !== null) {
                  db.update(schema.agentMachine).set({ tokenHash: machine.prevTokenHash, prevTokenHash: null, prevSetAt: null }).where(eq(schema.agentMachine.id, agentId)).run()
                }
              }
            }
          }
        } else if (event.type === 'log_chunk') {
          appendLog(agentId, event.nodeId, event.chunk)
        } else if (event.type === 'heartbeat') {
          // M4-3: the heartbeat carries the agent runtime version (the data source for the self-update negotiation badge)
          const version = event.detail?.agentVersion
          if (typeof version === 'string' && version !== '' && version.length <= 32) {
            db.update(schema.agentMachine).set({ agentVersion: version }).where(eq(schema.agentMachine.id, agentId)).run()
          }
          // M4-4: host metrics land in the database (field-level validation) + automatic cleanup of the 7-day retention
          const metrics = event.detail?.metrics
          if (metrics !== null && typeof metrics === 'object') {
            const m = metrics as Record<string, unknown>
            const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
            db.insert(schema.agentMetric).values({
              agentId,
              at: Date.now(),
              cpuPercent: num(m.cpuPercentTenths),
              memTotal: num(m.memTotal),
              memUsed: num(m.memUsed),
              diskTotal: num(m.diskTotal),
              diskFree: num(m.diskFree),
              uptime: num(m.uptime),
              platform: typeof m.platform === 'string' && m.platform.length <= 32 ? m.platform : null,
            }).run()
            db.delete(schema.agentMetric)
              .where(and(eq(schema.agentMetric.agentId, agentId), lt(schema.agentMetric.at, Date.now() - 7 * 24 * 60 * 60 * 1000)))
              .run()
          }
        }
        // lastSeenAt has already been refreshed uniformly at the entry point
      }
      return reply.send({ ok: true })
    },
  )

  // ---- The user surface: the agent directory list (the online state is computed live) ----
  app.get('/api/agents', { preHandler: requireUser }, async () => {
    const rows = db.select().from(schema.agentMachine).orderBy(asc(schema.agentMachine.joinedAt)).all()
    const now = Date.now()
    const agents = rows.map((r) => {
      const pending = db.select({ n: count() })
        .from(schema.agentCommand)
        .where(and(eq(schema.agentCommand.agentId, r.id), eq(schema.agentCommand.state, 'pending')))
        .all()[0]?.n ?? 0
      // M4-4: the latest metric snapshot (the machine row shows CPU / memory / disk)
      const latest = db.select().from(schema.agentMetric)
        .where(eq(schema.agentMetric.agentId, r.id))
        .orderBy(desc(schema.agentMetric.at))
        .limit(1)
        .all()[0]
      return {
        id: r.id,
        hostname: r.hostname,
        os: r.os,
        arch: r.arch,
        nodeVersion: r.nodeVersion,
        joinedAt: r.joinedAt,
        lastSeenAt: r.lastSeenAt,
        revoked: r.revokedAt !== null,
        online: r.revokedAt === null && r.lastSeenAt !== null && now - r.lastSeenAt <= AGENT_OFFLINE_MS,
        pendingCommands: pending,
        // M4-3: the runtime version (null = an old agent that did not report it); the frontend compares it against managerVersion for the badge
        agentVersion: r.agentVersion,
        latestMetric: latest === undefined
          ? null
          : { at: latest.at, cpuPercent: latest.cpuPercent, memTotal: latest.memTotal, memUsed: latest.memUsed, diskTotal: latest.diskTotal, diskFree: latest.diskFree, uptime: latest.uptime },
      }
    })
    return { agents, managerVersion: MANAGER_VERSION }
  })

  // ---- The user surface: the metric trend of one machine (M4-4; at most 1440 points = 24h at 60s) ----
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/api/agents/:id/metrics',
    { preHandler: requireUser },
    async (request, reply) => {
      const row = db.select().from(schema.agentMachine).where(eq(schema.agentMachine.id, request.params.id)).all()[0]
      if (row === undefined) return reply.code(404).send({ error: 'unknown_agent' })
      const limitRaw = Number(request.query.limit ?? 120)
      const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 1440) : 120
      const metrics = db.select().from(schema.agentMetric)
        .where(eq(schema.agentMetric.agentId, row.id))
        .orderBy(desc(schema.agentMetric.at))
        .limit(limit)
        .all()
        .reverse()
      // After .reverse() the last entry = the newest sample; it is taken with at(-1) to avoid a non-null assertion
      // (eslint no-non-null-assertion is an error in CI).
      const newest = metrics.at(-1) ?? null
      return {
        metrics: metrics.map((m) => ({
          at: m.at, cpuPercent: m.cpuPercent, memTotal: m.memTotal, memUsed: m.memUsed,
          diskTotal: m.diskTotal, diskFree: m.diskFree, uptime: m.uptime,
        })),
        latest: newest === null
          ? null
          : { at: newest.at, cpuPercent: newest.cpuPercent, memTotal: newest.memTotal, memUsed: newest.memUsed, diskTotal: newest.diskTotal, diskFree: newest.diskFree, uptime: newest.uptime },
      }
    },
  )

  // ---- The user surface: revoke an agent ----
  app.post<{ Params: { id: string } }>(
    '/api/agents/:id/revoke',
    { preHandler: requireUser, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const row = db.select().from(schema.agentMachine).where(eq(schema.agentMachine.id, request.params.id)).all()[0]
      if (row === undefined) return reply.code(404).send({ error: 'unknown_agent' })
      db.update(schema.agentMachine).set({ revokedAt: Date.now() }).where(eq(schema.agentMachine.id, request.params.id)).run()
      audit?.(request.currentUser?.username ?? 'unknown', 'agent_revoked', `agent ${request.params.id} (${row.hostname}) revoked`)
      return reply.send({ ok: true })
    },
  )

  // ---- The user surface: rotate the agent token (M4-1) ----
  // Offered for online machines only (rotating while offline = the old token gets no reprieve, and the machine may be bricked);
  // the new token reaches the agent only through a config.deliver command (it is not returned to the browser).
  app.post<{ Params: { id: string } }>(
    '/api/agents/:id/rotate',
    { preHandler: requireUser, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const row = db.select().from(schema.agentMachine).where(eq(schema.agentMachine.id, request.params.id)).all()[0]
      if (row === undefined) return reply.code(404).send({ error: 'unknown_agent' })
      if (row.revokedAt !== null) return reply.code(409).send({ error: 'agent_revoked' })
      const online = row.lastSeenAt !== null && Date.now() - row.lastSeenAt <= AGENT_OFFLINE_MS
      if (!online) {
        return reply.code(409).send({ error: 'agent_offline', detail: 'machine is offline — rotating now could brick the agent (the old token could not keep it alive); bring the agent online first' })
      }
      const agentToken = randomBytes(32).toString('base64url')
      db.update(schema.agentMachine)
        .set({ tokenHash: hashToken(agentToken), prevTokenHash: row.tokenHash, prevSetAt: Date.now() })
        .where(eq(schema.agentMachine.id, row.id))
        .run()
      const commandId = enqueueAgentCommand(db, row.id, 'config.deliver', { kind: 'identity', agentToken })
      audit?.(request.currentUser?.username ?? 'unknown', 'agent_token_rotated', `agent ${row.id} (${row.hostname}) key rotated via deliver command #${commandId}`)
      return reply.send({ ok: true, commandId })
    },
  )

  // ---- The user surface: delete a machine record (Fleet UI wrap-up B) ----
  // Only a revoked machine can be deleted (deleting a live identity by mistake = bricking the cluster); the machine row and its command history go with it;
  // the accounts (run/usage_record) have no foreign key to machine and are unaffected.
  app.post<{ Params: { id: string } }>(
    '/api/agents/:id/delete',
    { preHandler: requireUser, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const row = db.select().from(schema.agentMachine).where(eq(schema.agentMachine.id, request.params.id)).all()[0]
      if (row === undefined) return reply.code(404).send({ error: 'unknown_agent' })
      if (row.revokedAt === null) {
        return reply.code(409).send({ error: 'agent_not_revoked', detail: 'the machine is still registered — revoke it first (the token dies immediately), then delete the record' })
      }
      db.delete(schema.agentCommand).where(eq(schema.agentCommand.agentId, row.id)).run()
      db.delete(schema.agentMachine).where(eq(schema.agentMachine.id, row.id)).run()
      audit?.(request.currentUser?.username ?? 'unknown', 'agent_deleted', `agent ${row.id} (${row.hostname}) record deleted (command history included)`)
      return reply.send({ ok: true })
    },
  )

  // ---- The user surface: dispatch an agent self-update (M4-3) ----
  // The payload = agent.mjs + runtime.mjs from the manager's current static surface + the digest of the two concatenated;
  // the agent verifies it, swaps itself in atomically and exits, and the service manager restarts it to load the new code.
  app.post<{ Params: { id: string } }>(
    '/api/agents/:id/update',
    { preHandler: requireUser, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const row = db.select().from(schema.agentMachine).where(eq(schema.agentMachine.id, request.params.id)).all()[0]
      if (row === undefined) return reply.code(404).send({ error: 'unknown_agent' })
      if (row.revokedAt !== null) return reply.code(409).send({ error: 'agent_revoked' })
      const online = row.lastSeenAt !== null && Date.now() - row.lastSeenAt <= AGENT_OFFLINE_MS
      if (!online) {
        return reply.code(409).send({ error: 'agent_offline', detail: 'machine is offline — commands cannot be delivered; bring the agent online before updating' })
      }
      const agentDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'assets', 'agent')
      const files = Object.fromEntries(
        ['agent.mjs', 'runtime.mjs', 'update.mjs'].map((name) => [name, readFileSync(join(agentDir, name), 'utf8')]),
      )
      // The digest = the concatenation of "filename + content" sorted by filename (isomorphic on the agent side)
      const sha256 = createHash('sha256')
        .update(Object.keys(files).sort().map((name) => `${name}:${files[name]}`).join('\n'))
        .digest('hex')
      const commandId = enqueueAgentCommand(db, row.id, 'agent.update', {
        files,
        sha256,
        managerVersion: MANAGER_VERSION,
      })
      audit?.(request.currentUser?.username ?? 'unknown', 'agent_update_requested', `agent ${row.id} (${row.hostname}) self-update dispatched → ${MANAGER_VERSION} (command #${commandId})`)
      return reply.send({ ok: true, commandId, managerVersion: MANAGER_VERSION })
    },
  )
}
