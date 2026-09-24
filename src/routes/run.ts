import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import { and, desc, eq, lt } from 'drizzle-orm'
import { z } from 'zod'
import type { AppConfig } from '../config.js'
import type { Db } from '../db/index.js'
import { schema } from '../db/index.js'
import { dummyGatewayClient, type GatewayClient } from '../gateway/client.js'
import type { SessionDriver } from '../session-driver/port.js'
import { activeRunCount, runAgent, runningRunId } from '../runner.js'

const runBody = z.object({
  prompt: z.string().min(1, 'a prompt is required').max(20_000),
})

/**
 * 债务 E9:API 面钱字段统一 MicroUsd 命名——旧代码把 usage 行裸列名
 * (cost/peakCost,无单位后缀)直接透出,与全站 costMicroUsd 口径漂移。
 */
const usageApi = (u: (typeof schema.usageRecord.$inferSelect) | null | undefined) => {
  if (u === undefined || u === null) return null
  return {
    runId: u.runId,
    provider: u.provider,
    model: u.model,
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cacheReadTokens: u.cacheRead,
    cacheWriteTokens: u.cacheWrite,
    reasoningTokens: u.reasoningTokens,
    costMicroUsd: u.cost,
    peakCostMicroUsd: u.peakCost,
    at: u.at,
  }
}

export const registerRunRoutes = (
  app: FastifyInstance,
  config: AppConfig,
  db: Db,
  clients: Map<string, GatewayClient>,
  requireUser: preHandlerHookHandler,
  upstreamClients?: Map<string, SessionDriver>,
): void => {
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/agents/:id/run',
    {
      preHandler: requireUser,
      // A run costs money and holds the agent. Rate limited even for an
      // authenticated user, so a stuck browser tab cannot spend all day.
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const agent = config.agents[request.params.id]
      if (agent === undefined) return reply.code(404).send({ error: 'unknown_agent' })

      const parsed = runBody.safeParse(request.body)
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', detail: parsed.error.issues.map((i) => i.message) })
      }

      const driver = config.endpoints[agent.endpoint]?.driver ?? 'gateway'
      const upstream = upstreamClients?.get(agent.endpoint)
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
            prompt: parsed.data.prompt,
            trigger: 'manual',
            timeoutMs: config.runner.timeoutMs,
            silenceMs: config.runner.silenceMs,
          },
        )
        // A failed turn is a valid outcome that the caller must see, not a 500.
        return reply.code(200).send(outcome)
      } catch (error) {
        app.log.error(`run failed for ${agent.id}: ${(error as Error).message}`)
        return reply.code(500).send({ error: 'run_failed', detail: (error as Error).message })
      }
    },
  )

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/api/agents/:id/runs',
    { preHandler: requireUser },
    async (request, reply) => {
      const agent = config.agents[request.params.id]
      if (agent === undefined) return reply.code(404).send({ error: 'unknown_agent' })

      const limit = Math.min(Math.max(Number(request.query.limit ?? 20) || 20, 1), 100)
      const rows = db
        .select()
        .from(schema.run)
        .where(eq(schema.run.agentId, agent.id))
        .orderBy(desc(schema.run.startedAt))
        .limit(limit)
        .all()

      const usage = db
        .select()
        .from(schema.usageRecord)
        .orderBy(desc(schema.usageRecord.at))
        .limit(limit * 2)
        .all()
      const byRun = new Map(usage.map((u) => [u.runId, u]))

      return reply.send({
        busy: runningRunId(agent.id),
        activeRuns: activeRunCount(agent.id),
        runs: rows.map((r) => ({
          ...r,
          usage: usageApi(byRun.get(r.id)),
        })),
      })
    },
  )

  // 蜂群 Q4：全局最近任务流，跨所有 agent。/nodes 页的第二栏用，
  // 主脑在脑内看不到全局，节点页就是它的后视镜。
  // 舰队 UI 收尾 A：升级为筛选分页（任务页数据源）——agent_id/state/before
  // 游标 + next（before = 上一页末条 startedAt）。
  app.get<{ Querystring: { limit?: string; agent_id?: string; state?: string; before?: string } }>(
    '/api/runs',
    { preHandler: requireUser },
    async (request, reply) => {
      const limit = Math.min(Math.max(Number(request.query.limit ?? 50) || 50, 1), 200)
      const agentId = typeof request.query.agent_id === 'string' && request.query.agent_id !== '' ? request.query.agent_id : null
      const state = typeof request.query.state === 'string' && request.query.state !== '' ? request.query.state : null
      const before = Number(request.query.before)
      const conditions = []
      if (agentId !== null) conditions.push(eq(schema.run.agentId, agentId))
      if (state !== null) conditions.push(eq(schema.run.state, state))
      if (Number.isFinite(before) && before > 0) conditions.push(lt(schema.run.startedAt, before))
      const rows = db.select().from(schema.run)
        .where(conditions.length === 0 ? undefined : and(...conditions))
        .orderBy(desc(schema.run.startedAt))
        .limit(limit + 1)
        .all()
      const hasMore = rows.length > limit
      const page = hasMore ? rows.slice(0, limit) : rows
      // 游标 = 本页末条 startedAt（无末条 = 没有下一页）；用 at(-1) 取值，
      // 避免非空断言（lint 里 no-non-null-assertion 是 error 级）。
      const last = page.at(-1) ?? null
      return reply.header('cache-control', 'no-store').send({
        next: hasMore && last !== null ? last.startedAt : null,
        runs: page.map((r) => ({
          id: r.id,
          agentId: r.agentId,
          agentName: config.agents[r.agentId]?.name ?? r.agentId,
          trigger: r.trigger,
          state: r.state,
          summary: r.resultSummary,
          error: r.error,
          sourceChatId: r.sourceChatId,
          conflict: r.conflict,
          startedAt: r.startedAt,
          endedAt: r.endedAt,
        })),
      })
    },
  )

  app.get<{ Params: { id: string; runId: string } }>(
    '/api/agents/:id/runs/:runId',
    { preHandler: requireUser },
    async (request, reply) => {
      const agent = config.agents[request.params.id]
      if (agent === undefined) return reply.code(404).send({ error: 'unknown_agent' })
      const rows = db
        .select()
        .from(schema.run)
        .where(and(eq(schema.run.agentId, agent.id), eq(schema.run.id, request.params.runId)))
        .all()
      const run = rows[0]
      if (run === undefined) return reply.code(404).send({ error: 'unknown_run' })
      const usage = db.select().from(schema.usageRecord).where(eq(schema.usageRecord.runId, run.id)).all()
      return reply.send({ ...run, usage: usageApi(usage[0]) })
    },
  )
}
