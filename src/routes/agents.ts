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
 * 能力四（舰队，M1-2/M1-3）：node-agent 注册链 + 指令/事件通道。
 *
 * 三条面：
 * - 用户面（requireUser）：join 签发 / agent 列表 / 吊销；
 * - agent 面（Bearer agentToken）：register（join token 换发身份）、
 *   commands 长轮询（领取指令）、events（结果/心跳/日志分块回报）。
 * 网络面：agent 从远端拨号，不套主脑面私网闸——一次性 token + 限流 + Bearer 兜底。
 */

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')

export const JOIN_TOKEN_TTL_MS = 15 * 60_000
/** 心跳超时：超过该时长未鉴权露面 = 离线（agent 轮询周期 ~30s，3 个周期兜底）。 */
export const AGENT_OFFLINE_MS = 90_000
/** M4-1：轮换宽限期——旧 token 在此窗口内仍可用（防 ack 丢失把机器打砖）。 */
export const ROTATION_GRACE_MS = 30 * 60_000
/** 长轮询单次等待上限。 */
const MAX_WAIT_MS = 25_000
/** agent 日志环形缓冲（内存，按 agent:node 键控，各 64KB——设计 §5.2）。 */
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
  /** M4-3：agent 运行时版本（自更新协商；旧 agent 不上报 = 缺省 null）。 */
  agentVersion: z.string().min(1).max(32).optional(),
})

const eventsBody = z.object({
  events: z.array(z.discriminatedUnion('type', [
    z.object({ type: z.literal('command_result'), commandId: z.number().int().positive(), ok: z.boolean(), result: z.unknown().optional() }),
    z.object({ type: z.literal('heartbeat'), detail: z.record(z.string(), z.unknown()).optional() }),
    z.object({ type: z.literal('log_chunk'), nodeId: z.string().min(1).max(64), chunk: z.string().max(32_000) }),
  ])).max(100),
})

/** 按 agentToken 找未吊销的 agent 行；找不到/已吊销 = null。
 * M4-1：轮换宽限期内的旧 token 同样可鉴权（prev 位，ack 后清除）。 */
export const findAgentByToken = (db: Db, token: string): { id: string; hostname: string; os: string; arch: string; nodeVersion: string } | null => {
  const digest = hashToken(token)
  const row = db.select().from(schema.agentMachine).where(eq(schema.agentMachine.tokenHash, digest)).all()[0]
    ?? db.select().from(schema.agentMachine).where(eq(schema.agentMachine.prevTokenHash, digest)).all()[0]
  if (row === undefined || row.revokedAt !== null) return null
  const prevMatches = row.tokenHash !== digest
  if (prevMatches && (row.prevSetAt === null || Date.now() - row.prevSetAt > ROTATION_GRACE_MS)) return null
  return { id: row.id, hostname: row.hostname, os: row.os, arch: row.arch, nodeVersion: row.nodeVersion }
}

// ---- 指令队列（DB 为真相源；内存等待者只做唤醒）----
const waiters = new Map<string, Array<() => void>>()

const wake = (agentId: string): void => {
  const list = waiters.get(agentId)
  if (list === undefined) return
  waiters.delete(agentId)
  for (const done of list) done()
}

/** manager 侧入队（supervisor/派生下发用）；返回指令 id。 */
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

/** 原子领取该 agent 的全部 pending 指令（单连接下无并发竞态，条件更新双保险）。 */
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

// ---- agent 日志环形缓冲（内存）----
const logRing = new Map<string, string>()
const appendLog = (agentId: string, nodeId: string, chunk: string): void => {
  const key = `${agentId}:${nodeId}`
  const next = `${logRing.get(key) ?? ''}${chunk}`
  logRing.set(key, next.length > AGENT_LOG_RING_BYTES ? next.slice(next.length - AGENT_LOG_RING_BYTES) : next)
}

/** 供 UI/日志抽屉读取（M1-7）。 */
export const readAgentLog = (agentId: string, nodeId: string): string => logRing.get(`${agentId}:${nodeId}`) ?? ''

// ---- 指令结果订阅（supervisor 的 agent 分支用：spawn 失败快速失败，不等就绪超时）----
const resultSubs = new Set<(commandId: number, ok: boolean) => void>()

/** 订阅指令结果；返回退订函数。 */
export const subscribeAgentCommandResults = (cb: (commandId: number, ok: boolean) => void): (() => void) => {
  resultSubs.add(cb)
  return () => {
    resultSubs.delete(cb)
  }
}

/** Bearer token → agent id；仅当 token 有效且与路由 :id 一致才返回（不泄露存在性）。 */
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
  /** 审计回调（wiring 注入；测试可不传）。 */
  audit?: (actor: string, kind: AuditKind, detail: string) => void,
  /**
   * 事故回归（2026-09-25 ubuntu-focal 失联）：agent 从离线恢复时触发舰队
   * 对账自愈。看门狗只发通知不做自愈，节点本要干等周期对账（默认 10 分钟），
   * 而主机重启后正是「agent 先回来、节点还没起」的窗口。
   * 注入方负责只收敛该 agent 名下的节点（healOnly 语义：人手动停的冷节点不动）。
   */
  onAgentRecover?: (agentId: string) => void,
): void => {
  /**
   * 事故回归（2026-09-25 ubuntu-focal 失联）：刷新 lastSeenAt 并回报「本次之前
   * 是否已离线」。顺序是先读后写——反了就看不到边沿，自愈永不触发。
   * commands 长轮询与 events 回报都算在线证据（agent 每 25s 两条都发）。
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

  // ---- 用户面：签发一次性 join token ----
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

  // ---- agent 面：join token 换发 agent 身份 ----
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

  // ---- agent 面：长轮询领取指令 ----
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
      // 任何鉴权请求刷心跳（设计：心跳随轮询携带）；离线→在线即触发舰队自愈
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

  // ---- agent 面：结果/心跳/日志回报 ----
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
      // 事故回归：先判「本次请求之前是否已离线」，再刷 lastSeenAt——顺序反了
      // 就再也看不到边沿，自愈永不触发。任何鉴权抵达都算在线证据（心跳/回报/日志）。
      touchHeartbeat(agentId)

      const parsed = eventsBody.safeParse(request.body)
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', detail: 'an events array (command_result/heartbeat/log_chunk)' })

      for (const event of parsed.data.events) {
        if (event.type === 'command_result') {
          // 只认领自己 agent 的 delivered 指令；幂等（重复回报被条件更新忽略）
          const updated = db.update(schema.agentCommand)
            .set({ state: event.ok ? 'done' : 'failed', result: JSON.stringify(event.result ?? null), doneAt: Date.now() })
            .where(and(
              eq(schema.agentCommand.id, event.commandId),
              eq(schema.agentCommand.agentId, agentId),
              eq(schema.agentCommand.state, 'delivered'),
            ))
            .run()
          if (updated.changes > 0) {
            for (const cb of resultSubs) cb(event.commandId, event.ok)
            // M4-1：config.deliver（身份轮换）ack → 宽限位收敛——
            // 成功 = 清 prev；失败 = 回滚主 token（agent 还持旧 token）。
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
          // M4-3：心跳携带 agent 运行时版本（自更新协商徽标数据源）
          const version = event.detail?.agentVersion
          if (typeof version === 'string' && version !== '' && version.length <= 32) {
            db.update(schema.agentMachine).set({ agentVersion: version }).where(eq(schema.agentMachine.id, agentId)).run()
          }
          // M4-4：主机指标落库（字段级校验）+ 7 天保留自动清理
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
        // lastSeenAt 已由入口统一刷新
      }
      return reply.send({ ok: true })
    },
  )

  // ---- 用户面：agent 目录列表（在线状态实时计算）----
  app.get('/api/agents', { preHandler: requireUser }, async () => {
    const rows = db.select().from(schema.agentMachine).orderBy(asc(schema.agentMachine.joinedAt)).all()
    const now = Date.now()
    const agents = rows.map((r) => {
      const pending = db.select({ n: count() })
        .from(schema.agentCommand)
        .where(and(eq(schema.agentCommand.agentId, r.id), eq(schema.agentCommand.state, 'pending')))
        .all()[0]?.n ?? 0
      // M4-4：最新指标快照（机器行展示 CPU/内存/磁盘）
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
        // M4-3：运行时版本（null = 旧 agent 未上报）；前端与 managerVersion 比对出徽标
        agentVersion: r.agentVersion,
        latestMetric: latest === undefined
          ? null
          : { at: latest.at, cpuPercent: latest.cpuPercent, memTotal: latest.memTotal, memUsed: latest.memUsed, diskTotal: latest.diskTotal, diskFree: latest.diskFree, uptime: latest.uptime },
      }
    })
    return { agents, managerVersion: MANAGER_VERSION }
  })

  // ---- 用户面：单机指标趋势（M4-4；最多 1440 个点 = 24h@60s）----
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
      // .reverse() 之后末条 = 最新一次采样；用 at(-1) 取值，避免非空断言
      // （eslint no-non-null-assertion 在 CI 里是 error 级）。
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

  // ---- 用户面：吊销 agent ----
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

  // ---- 用户面：轮换 agent token（M4-1）----
  // 只对在线机器开放（离线轮换 = 旧 token 得不到续命，机器可能被打砖）；
  // 新 token 只经 config.deliver 指令投递给 agent（不返回给浏览器）。
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

  // ---- 用户面：删除机器记录（舰队 UI 收尾 B）----
  // 仅已吊销机器可删（在线身份误删 = 集群打砖）；machine 行 + 指令历史随删；
  // 账单（run/usage_record）与 machine 无外键不受影响。
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

  // ---- 用户面：下发 agent 自更新（M4-3）----
  // 载荷 = manager 当前静态面的 agent.mjs + runtime.mjs + 双文件拼接摘要；
  // agent 侧校验后原子换装并退出，由服务管理器重启加载新代码。
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
      // 摘要 = 按文件名排序的「文件名 + 内容」拼接（agent 侧同构）
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
