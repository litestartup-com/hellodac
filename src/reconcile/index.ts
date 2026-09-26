/**
 * 对账单一化（A 清单 #2，修路阶段第二项，与 SessionDriver 并列拍板）。
 *
 * 四路同步收敛进本入口：DB 注册表镜像、遗留 run / 孤儿会话收敛（boot 专用）、
 * fleet.md 派生下发、托管节点认领（docker adopt / process 拉起）。
 * **boot 与每次配置变更（provision 路由）都走 reconcileAll**——任何散落的
 * 形态分支（FK 事故 = 分支漏抄）禁止新增：改动只能回到真相源（config），
 * 由本入口收敛派生品。
 */
import { eq, inArray } from 'drizzle-orm'
import type { AppConfig } from '../config.js'
import { schema, type Db } from '../db/index.js'
import { archiveOrphanChats } from '../chat/store.js'
import { syncFleetDocs } from '../workspace/fleet-doc.js'
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

/** 镜像一行的最小事实面（provision 的 DB-first 步只有这些字段）。 */
export type AgentRowFace = Pick<
  import('../config.js').ResolvedAgent,
  'id' | 'name' | 'workspacePath' | 'endpoint' | 'preset' | 'gitRemote' | 'public'
>

/**
 * 镜像单个 agent 到 DB registry（insert/update 二选一，幂等）。
 * mirrorAgents 与 provision 的 DB-first 步共用这一个实现——镜像逻辑只此一处。
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

/** 删除一行 agent（provision 回滚与收敛删除共用）。 */
export const removeAgentRow = (db: Db, id: string): void => {
  db.delete(schema.agent).where(eq(schema.agent.id, id)).run()
}

/**
 * DB 注册表 = 配置的派生品：逐 agent 镜像（insert/update），并按需从表里删除
 * 配置已不存在的行——唯一真相源是 manager.config.yaml。
 *
 * removeStale=false（债务 R9：provision 热变更路径）：只镜像、不收敛删除——
 * 节点删除后其 agent 行在进程存活期内保留（账单与审计的 FK 引用），
 * boot / 周期对账的 reconcileAll 才做收敛删除。
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
    // 收敛删除：配置里没有的 agent 行不再保留（FK 教训——别让派生品记住已删的真相）。
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
 * A run only exists inside a manager process：boot 时仍挂 pending/running 的
 * 行属于上一个已死进程，收敛为 failed。
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
 * 发布前优化（2026-09-26）：中断在投递窗口里的指令同属"上一个进程的遗留"。
 *
 * boot 时仍挂 `delivered` 的行 = agent 领走了却没能回报（多半是 manager 重启打断，
 * 2026-09-24/26 两次维护窗口各留 2 行）。此后它既不会被重投（claimCommands 只取
 * pending）、也不会被读，却带着整份 DSH profile bundle 永久占库——生产实测
 * 273 KB/条，清完存量后这 339 KB 反而成了库里最大的一块。
 * 收敛为 failed 并**清 payload**；`pending` 不动：那是真没送达的，仍要投。
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

/** 孤儿会话归档：agent 已从配置删除的会话永远 409 agent_gone。 */
export const convergeOrphanChats = (db: Db, config: AppConfig): number =>
  archiveOrphanChats(db, new Set(Object.keys(config.agents)))

/** fleet.md 派生下发（每工作区一份，随 config 自动同步，幂等）。 */
export const convergeFleet = async (config: AppConfig, log: (line: string) => void): Promise<string[]> =>
  syncFleetDocs(config, log)

/**
 * 托管节点认领：docker runner 走对账（认领在跑 / 补拉缺失 / 规格不符重建），
 * process runner 直接拉起。幂等：对已认领的节点重复执行不产生第二个容器。
 *
 * healOnly（周期对账用）：**只治 offline + live 态探活**——人手动停的节点
 * （nodes/down）落在 cold，周期 tick 绝不抢拉（「用户手动起的 DSH 不会被
 * 抢管」同理）；live 态经 supervisor.probeLive() 健康对账（修路 A3：连续
 * 失败转 offline），发现即经 restart() 同 tick 自愈（restart 对已死进程/
 * 已清 containerId 的 docker = 直接 start；对僵进程 = stop→重拉）。
 * boot 走 healOnly=false（冷态 = 从未启动，需要拉起 + 完整 docker 认领）。
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
    // 债务 R9:热变更路径只收敛指定节点(provision 新节点/回滚重同步),
    // 绝不借机把用户手动停掉的其它冷节点抢拉起来。null = 全部(boot 语义)。
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

/** 唯一对账入口。runHygiene 只在 boot 打开（变更事件路径不需要收敛历史行）。 */
export const reconcileAll = async (
  deps: ReconcileContext,
  opts: {
    runHygiene?: boolean
    healOnly?: boolean
    /**
     * 债务 R9:节点收敛范围。undefined = 全部(boot/周期对账);
     * Set(可为空)= 只收敛集合内节点(provision 热变更:空集 = 本轮不动任何节点)。
     */
    onlyNodes?: Set<string>
    /** 债务 R9:false = 只镜像不收敛删除(热变更路径,进程存活期保留已删 agent 行)。 */
    removeStaleAgents?: boolean
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
  const fleet = await convergeFleet(config, log)
  if (fleet.length > 0) log(`fleet.md synced: ${fleet.join(', ')}`)
  await convergeNodes(supervisors, config, docker, log, opts.healOnly === true, opts.onlyNodes ?? null)
}

/**
 * 修路 A2：周期对账。intervalMs <= 0 时不开（返回 no-op 停止器）。
 * 返回停止函数（测试与 onClose 用它拆定时器）；timer unref 不挡进程退出。
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
