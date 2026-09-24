import { randomUUID } from 'node:crypto'
import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { AppConfig } from '../config.js'
import type { Db } from '../db/index.js'
import { schema } from '../db/index.js'
import { dummyGatewayClient, type GatewayClient } from '../gateway/client.js'
import type { SessionDriver } from '../session-driver/port.js'
import { listChats, getChat, bindSession, touchChat } from '../chat/store.js'
import { publish } from './chat.js'
import { readBoard } from '../board/store.js'
import { notify } from '../notify.js'
import { activeRunCount, runAgent, runningRunId } from '../runner.js'
import { USD_TO_MICRO, monthTotals, monthByAgent, monthByModel, currentMonth } from '../usage/store.js'
import { scheduleProblem, type Scheduler } from '../cron/schedule.js'

/**
 * 蜂群 P2：brain 面内部 REST API。
 *
 * 主脑（DSH 里的 skill + curl）吃这一面；第三方走北向 /api/v1。两道门缺一
 * 不可，全不过则这一面不存在（fail closed）：
 *
 * 1. 仅接受私网来源（裸机=回环；容器形态=主脑在 hive 内网，来源 172.x/10.x——
 *    token 即使外带，公网也打不进来）；
 * 2. `X-Brain-Token` 常量时间比较，值来自 `.env` 的 `BRAIN_TOKEN`。
 *
 * 语义对齐 BRAINSTORM §3.2 三组：看（只读）与做（manager 侧裁决）；红线
 * （写文件 / 发信 / 管理操作）在此面根本不提供路由。
 */

const tokenOk = (candidate: string | null): boolean => {
  const token = process.env.BRAIN_TOKEN ?? ''
  if (token === '' || candidate === null) return false
  const a = Buffer.from(candidate, 'utf8')
  const b = Buffer.from(token, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** 回环 + RFC1918 私网（docker 内网来源；公网永远不过）。 */
const isPrivateSource = (ip: string): boolean => {
  const raw = ip.replace(/^::ffff:/, '')
  if (raw === '127.0.0.1' || raw === '::1') return true
  const parts = raw.split('.').map(Number)
  if (parts.length !== 4 || !parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return false
  const a = parts[0] ?? -1
  const b = parts[1] ?? -1
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
}

// async 钩子用 fastify 的 async 专用类型：preHandlerHookHandler 的签名是 void 返回
// （给回调式钩子用的），把 async 函数标成它会让"返回 promise 给不等待方"无法被 lint 区分。
const brainGate: preHandlerAsyncHookHandler = async (request, reply) => {
  // 蜂群2计划 P6：信任「直连对端」而不是转发头——反代（nginx/Cloudflare）之后
  // request.ip 是公网客户端 IP，会把回环/内网来源误判成公网（smoke 实测 403）。
  const peerIp = request.socket.remoteAddress ?? request.ip
  if (!isPrivateSource(peerIp)) {
    await reply.code(403).send({ error: 'private_network_only', hint: 'the brain API accepts private-network connections only' })
    return
  }
  if ((process.env.BRAIN_TOKEN ?? '') === '') {
    await reply.code(503).send({ error: 'brain_disabled', hint: 'BRAIN_TOKEN is not set in .env' })
    return
  }
  const candidate = typeof request.headers['x-brain-token'] === 'string' ? request.headers['x-brain-token'] : null
  if (!tokenOk(candidate)) {
    await reply.code(401).send({ error: 'unauthorized' })
    return
  }
}

const dispatchBody = z.object({
  agentId: z.string().min(1),
  prompt: z.string().min(1).max(20_000),
  chatId: z.string().optional(),
  /** 蜂群 P2：主脑发起本次派工所在的会话（delegation 帧归属）。 */
  sourceChatId: z.string().optional(),
})

const cronBody = z.object({
  agentId: z.string().min(1),
  name: z.string().min(1).max(80),
  schedule: z.string().min(1).max(120),
  timezone: z.string().min(1).max(60).default('Asia/Shanghai'),
  prompt: z.string().min(1).max(20_000),
})

export const registerInternalRoutes = (
  app: FastifyInstance,
  config: AppConfig,
  db: Db,
  clients: Map<string, GatewayClient>,
  upstreamClients: Map<string, SessionDriver>,
  scheduler: Scheduler,
): void => {
  const gated = { preHandler: brainGate }

  // ---- 看 ----

  app.get('/api/internal/agents', gated, async () => {
    const month = currentMonth()
    const byAgent = new Map(monthByAgent(db, month).map((s) => [s.agentId, s]))
    const cap = config.brainDailyBudgetMicroUsd ?? null
    const spent = cap === null ? 0 : brainSpendToday()
    return {
      // 蜂群 P5.1：主脑派工前的预算预判——余量低于任务估价时主脑应如实告知。
      brainBudget:
        cap === null
          ? null
          : { capMicroUsd: cap, spentMicroUsd: spent, remainingMicroUsd: Math.max(0, cap - spent) },
      agents: Object.values(config.agents).map((agent) => {
        const chats = listChats(db, agent.id, 1_000)
        const running = runningRunId(agent.id)
        return {
          id: agent.id,
          name: agent.name,
          public: agent.public,
          preset: agent.preset,
          sandboxMode: agent.sandboxMode,
          busy: running !== null,
          runningRunId: running,
          activeRuns: activeRunCount(agent.id),
          chatCount: chats.length,
          spendMicroUsd: byAgent.get(agent.id)?.costMicroUsd ?? 0,
        }
      }),
    }
  })

  app.get<{ Params: { id: string } }>('/api/internal/agents/:id', gated, async (request, reply) => {
    const agent = config.agents[request.params.id]
    if (agent === undefined) return reply.code(404).send({ error: 'unknown_agent' })
    const endpoint = config.endpoints[agent.endpoint]
    const runs = db
      .select()
      .from(schema.run)
      .where(eq(schema.run.agentId, agent.id))
      .orderBy(desc(schema.run.startedAt))
      .limit(5)
      .all()
    return {
      ...agent,
      endpoint: {
        id: agent.endpoint,
        driver: endpoint?.driver ?? null,
        url: endpoint?.url ?? null,
      },
      runningRunId: runningRunId(agent.id),
      activeRuns: activeRunCount(agent.id),
      recentRuns: runs.map((r) => ({
        id: r.id,
        state: r.state,
        trigger: r.trigger,
        summary: r.resultSummary,
        startedAt: r.startedAt,
      })),
    }
  })

  app.get<{ Params: { id: string } }>('/api/internal/agents/:id/board', gated, async (request, reply) => {
    const agent = config.agents[request.params.id]
    if (agent === undefined) return reply.code(404).send({ error: 'unknown_agent' })
    return readBoard(agent.workspacePath, agent.name)
  })

  app.get('/api/internal/usage', gated, async () => {
    const month = currentMonth()
    return { month, totals: monthTotals(db, month), byAgent: monthByAgent(db, month), byModel: monthByModel(db, month) }
  })

  app.get<{ Params: { id: string } }>('/api/internal/agents/:id/chats', gated, async (request, reply) => {
    const agent = config.agents[request.params.id]
    if (agent === undefined) return reply.code(404).send({ error: 'unknown_agent' })
    return {
      chats: listChats(db, agent.id).map((chat) => ({
        id: chat.id,
        title: chat.title,
        turns: chat.turns,
        lastActiveAt: chat.lastActiveAt,
      })),
    }
  })

  app.get<{ Params: { id: string } }>('/api/internal/chats/:id/summary', gated, async (request, reply) => {
    const chat = getChat(db, request.params.id)
    if (chat === null) return reply.code(404).send({ error: 'unknown_chat' })
    const lastRun = db
      .select()
      .from(schema.run)
      .where(eq(schema.run.chatId, chat.id))
      .orderBy(desc(schema.run.startedAt))
      .limit(1)
      .all()[0]
    return {
      id: chat.id,
      agentId: chat.agentId,
      title: chat.title,
      state: chat.removedAt === null ? 'active' : 'archived',
      turns: listChats(db, chat.agentId).find((c) => c.id === chat.id)?.turns ?? 0,
      lastRun: lastRun === undefined
        ? null
        : { state: lastRun.state, summary: lastRun.resultSummary, startedAt: lastRun.startedAt },
    }
  })

  // ---- 做（manager 侧裁决） ----

  /**
   * 蜂群 P5.1：主脑派工（trigger=brain）的日预算熔断。只拦主脑的派工，
   * 人手动操作不拦——§8.3 借用第 2 条（成本失控是企业项目头号死因）。
   */
  const brainSpendToday = (): number => {
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    // 债务 B5:求和下推 SQL(不再把行拉进 JS reduce),范围过滤命中
    // usage_at + run_trigger_started 索引
    const rows = db.all<{ total: number | null }>(sql`
      SELECT COALESCE(SUM(usage_record.cost), 0) AS total
      FROM usage_record
      JOIN run ON run.id = usage_record.run_id
      WHERE run.trigger = 'brain' AND usage_record.at >= ${start.getTime()}
    `)
    return rows[0]?.total ?? 0
  }

  const promptBody = z.object({ text: z.string().min(1, 'a prompt is required').max(20_000) })

  /**
   * 蜂群 P5.3 会话复用：主脑往已有会话续一句（ask_worker）。
   *
   * 同步返回 outcome（技能直接读 JSON）；同会话已有回合在跑时 409——
   * 「会话内串行」的服务端闸门；同样走主脑预算熔断。续接的帧实时推给该
   * 会话页的 relay，用户在场时看得到主脑在续写。
   */
  app.post<{ Params: { id: string }; Body: unknown }>('/api/internal/chats/:id/prompt', { ...gated, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    const parsed = promptBody.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', detail: parsed.error.issues.map((i) => i.message) })
    }
    const chat = getChat(db, request.params.id)
    if (chat === null || chat.removedAt !== null) return reply.code(404).send({ error: 'unknown_chat' })
    const agent = config.agents[chat.agentId]
    if (agent === undefined) {
      return reply
        .code(409)
        .send({ error: 'agent_gone', detail: `this session belongs to agent "${chat.agentId}", which is no longer in the config` })
    }

    const cap = config.brainDailyBudgetMicroUsd ?? null
    if (cap !== null && brainSpendToday() >= cap) {
      const detail = `the brain's dispatch budget for today is used up (${(brainSpendToday() / USD_TO_MICRO).toFixed(2)} / ${(cap / USD_TO_MICRO).toFixed(2)} USD); try again tomorrow or act by hand.`
      notify(db, { kind: 'brain_budget', title: "the brain's dispatch budget for today is used up", body: detail, link: '/spend' })
      return reply.code(409).send({ error: 'brain_budget_exhausted', detail })
    }

    const live = db
      .select({ id: schema.run.id })
      .from(schema.run)
      .where(and(eq(schema.run.chatId, chat.id), inArray(schema.run.state, ['pending', 'running'])))
      .limit(1)
      .all()
    if (live.length > 0) {
      return reply.code(409).send({ error: 'chat_busy', detail: 'this session is running a turn — continue it once that finishes.' })
    }

    const driver = config.endpoints[agent.endpoint]?.driver ?? 'gateway'
    const upstream = upstreamClients.get(agent.endpoint)
    const client = clients.get(agent.endpoint)
    if (driver === 'apiproxy' && upstream === undefined) return reply.code(500).send({ error: 'endpoint_not_configured' })
    if (driver === 'gateway' && client === undefined) return reply.code(500).send({ error: 'endpoint_not_configured' })

    try {
      const outcome = await runAgent(
        {
          db,
          pricing: config.pricing,
          log: { info: (m) => app.log.info(m), warn: (m) => app.log.warn(m), error: (m) => app.log.error(m) },
        },
        {
          agent,
          client: client ?? dummyGatewayClient(),
          ...(upstream === undefined ? {} : { upstream }),
          driver,
          prompt: parsed.data.text,
          trigger: 'brain',
          chatId: chat.id,
          sessionId: chat.dshSessionId,
          onSession: (sessionId) => {
            if (getChat(db, chat.id)?.dshSessionId === null) bindSession(db, chat.id, sessionId)
          },
          keepSession: true,
          timeoutMs: config.runner.timeoutMs,
          silenceMs: config.runner.silenceMs,
          onFrame: (frame) => {
            if (frame.kind === 'user') return
            publish(chat.id, frame)
          },
        },
      )
      if (outcome.sessionId !== null && chat.dshSessionId === null) bindSession(db, chat.id, outcome.sessionId)
      else touchChat(db, chat.id)
      publish(chat.id, { kind: 'turn_done', runId: outcome.runId, state: outcome.state, error: outcome.error })
      return reply.code(200).send(outcome)
    } catch (error) {
      app.log.error(`internal prompt failed for ${chat.id}: ${(error as Error).message}`)
      return reply.code(500).send({ error: 'prompt_failed', detail: (error as Error).message })
    }
  })

  app.post<{ Body: unknown }>('/api/internal/dispatch', { ...gated, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    const parsed = dispatchBody.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', detail: parsed.error.issues.map((i) => i.message) })
    }
    const body = parsed.data
    const agent = config.agents[body.agentId]
    if (agent === undefined) return reply.code(404).send({ error: 'unknown_agent' })

    const cap = config.brainDailyBudgetMicroUsd ?? null
    if (cap !== null) {
      const spent = brainSpendToday()
      if (spent >= cap) {
        const detail = `the brain's dispatch budget for today is used up (${(spent / USD_TO_MICRO).toFixed(2)} / ${(cap / USD_TO_MICRO).toFixed(2)} USD); try again tomorrow or act by hand.`
        notify(db, { kind: 'brain_budget', title: "the brain's dispatch budget for today is used up", body: detail, link: '/spend' })
        return reply.code(409).send({
          error: 'brain_budget_exhausted',
          detail,
        })
      }
    }

    const driver = config.endpoints[agent.endpoint]?.driver ?? 'gateway'
    const upstream = upstreamClients.get(agent.endpoint)
    const client = clients.get(agent.endpoint)
    if (driver === 'apiproxy' && upstream === undefined) return reply.code(500).send({ error: 'endpoint_not_configured' })
    if (driver === 'gateway' && client === undefined) return reply.code(500).send({ error: 'endpoint_not_configured' })

    try {
      const outcome = await runAgent(
        {
          db,
          pricing: config.pricing,
          log: {
            info: (m) => app.log.info(m),
            warn: (m) => app.log.warn(m),
            error: (m) => app.log.error(m),
          },
        },
        {
          agent,
          client: client ?? dummyGatewayClient(),
          ...(upstream === undefined ? {} : { upstream }),
          driver,
          prompt: body.prompt,
          trigger: 'brain',
          sourceChatId: body.sourceChatId ?? null,
          timeoutMs: config.runner.timeoutMs,
          silenceMs: config.runner.silenceMs,
        },
      )
      // 蜂群 P2：主脑会话页的 delegation 帧实时态——派工结束推一帧，页面据
      // 此刷新该会话的派工列表。
      if (body.sourceChatId !== undefined && body.sourceChatId !== '') {
        publish(body.sourceChatId, {
          kind: 'delegation_done',
          runId: outcome.runId,
          agentId: agent.id,
          agentName: agent.name,
          state: outcome.state,
          summary: outcome.summary,
          error: outcome.error ?? null,
        })
        notify(db, {
          kind: 'brain_done',
          title: `brain dispatch finished: ${agent.name}`,
          body: outcome.summary ?? '(no output text)',
          link: `/chat/${encodeURIComponent(body.sourceChatId)}`,
        })
      }
      return reply.code(200).send(outcome)
    } catch (error) {
      app.log.error(`internal dispatch failed for ${agent.id}: ${(error as Error).message}`)
      return reply.code(500).send({ error: 'dispatch_failed', detail: (error as Error).message })
    }
  })

  app.post<{ Body: unknown }>('/api/internal/crons', { ...gated, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    const parsed = cronBody.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', detail: parsed.error.issues.map((i) => i.message) })
    }
    const body = parsed.data
    if (config.agents[body.agentId] === undefined) return reply.code(404).send({ error: 'unknown_agent' })
    const problem = scheduleProblem(body.schedule, body.timezone)
    if (problem !== null) return reply.code(400).send({ error: 'invalid_schedule', detail: problem })

    const id = randomUUID()
    try {
      db.insert(schema.cron)
        .values({
          id,
          agentId: body.agentId,
          name: body.name,
          schedule: body.schedule,
          timezone: body.timezone,
          prompt: body.prompt,
          // 主脑可以起草定时任务，开关必须是人（BRAINSTORM §3.2）：默认停用，
          // 用户在 crons 页确认后才启用。
          enabled: 0,
          consecutiveFailures: 0,
          createdAt: Date.now(),
        })
        .run()
    } catch (error) {
      if (String(error).includes('UNIQUE')) {
        return reply.code(409).send({ error: 'duplicate_name', detail: 'this agent already has a schedule by that name' })
      }
      throw error
    }
    scheduler.reload()
    return reply.code(201).send({ id, enabled: false, note: 'drafted — enable it once you have confirmed it' })
  })
}
