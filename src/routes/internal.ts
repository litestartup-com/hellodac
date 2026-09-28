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
 * Hive P2: the brain-side internal REST API.
 *
 * The brain (a skill plus curl inside DSH) consumes this side; third parties go through the northbound /api/v1.
 * Both doors are required, and without both this side does not exist (fail closed):
 *
 * 1. Private-network sources only (bare metal = loopback; container form = the brain is on the hive's internal
 *    network, source 172.x/10.x -- even a token carried out cannot get in from the public internet);
 * 2. `X-Brain-Token` compared in constant time, with the value coming from `BRAIN_TOKEN` in `.env`.
 *
 * The semantics align with BRAINSTORM §3.2's three groups: look (read-only) and do (decided on the manager side);
 * the red lines (writing files / sending mail / management operations) have no routes on this side at all.
 */

const tokenOk = (candidate: string | null): boolean => {
  const token = process.env.BRAIN_TOKEN ?? ''
  if (token === '' || candidate === null) return false
  const a = Buffer.from(candidate, 'utf8')
  const b = Buffer.from(token, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** Loopback plus RFC1918 private ranges (docker internal sources; the public internet never passes). */
const isPrivateSource = (ip: string): boolean => {
  const raw = ip.replace(/^::ffff:/, '')
  if (raw === '127.0.0.1' || raw === '::1') return true
  const parts = raw.split('.').map(Number)
  if (parts.length !== 4 || !parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return false
  const a = parts[0] ?? -1
  const b = parts[1] ?? -1
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
}

// An async hook uses fastify's async-specific type: preHandlerHookHandler is signed as returning void (it is for
// callback-style hooks), and marking an async function with it hides "a promise returned to someone who does not await it" from the linter.
const brainGate: preHandlerAsyncHookHandler = async (request, reply) => {
  // Hive plan 2 P6: trust the "directly connected peer" rather than forwarded headers -- behind a reverse proxy
  // (nginx/Cloudflare) request.ip is the public client IP and would misjudge loopback/internal sources as public (smoke measured a 403).
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
  /** Hive P2: the chat this dispatch was started from (the delegation frame's origin). */
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

  // ---- look ----

  app.get('/api/internal/agents', gated, async () => {
    const month = currentMonth()
    const byAgent = new Map(monthByAgent(db, month).map((s) => [s.agentId, s]))
    const cap = config.brainDailyBudgetMicroUsd ?? null
    const spent = cap === null ? 0 : brainSpendToday()
    return {
      // Hive P5.1: the budget forecast before a brain dispatch -- when what is left is below the task estimate the brain must say so honestly.
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

  // ---- do (decided on the manager side) ----

  /**
   * Hive P5.1: the daily budget breaker for brain dispatches (trigger=brain). It only stops brain dispatches;
   * manual human actions are not stopped -- §8.3 borrows rule 2 (runaway cost is the number one killer of enterprise projects).
   */
  const brainSpendToday = (): number => {
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    // Debt B5: the sum is pushed down into SQL (rows are no longer pulled into a JS reduce), and the range filter
    // hits the usage_at + run_trigger_started indexes
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
   * Hive P5.3 chat reuse: the brain continues an existing chat with one more prompt (ask_worker).
   *
   * The outcome comes back synchronously (the skill reads the JSON directly); with a turn already running in the
   * same chat it is a 409 -- the server-side gate for "serial within a chat"; the brain budget breaker applies here
   * too. The continued frames are pushed live to that chat page's relay, so a present user can see the brain writing on.
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
      // Hive P2: the live state of the delegation frame on the brain chat page -- one frame is pushed when a dispatch
      // ends, and the page refreshes that chat's dispatch list from it.
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
          // The brain may draft a scheduled task, but the switch must be human (BRAINSTORM §3.2): disabled by
          // default, enabled only after the user confirms on the crons page.
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
