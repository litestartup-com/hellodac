import type { Db } from '../db/index.js'
import { desc, eq, isNull } from 'drizzle-orm'
import { schema } from '../db/index.js'
import { notify } from '../notify.js'
import { AGENT_OFFLINE_MS } from '../routes/agents.js'

/**
 * 能力四（舰队 M3-3，§13 补丁提前）：fleet 看门狗——agent 掉线 / agent 节点
 * 异常进站内通知（铃铛）。边沿触发（状态转换只报一次），未读去重防 manager
 * 重启刷屏（铃铛已有同对象未读告警 = 不再插入）。
 *
 * 范围：只报「agent runner」节点（远端节点静默死亡是舰队的新盲区）；本机
 * process/docker 节点已有监督器重试 + 节点页红点，不越界重复。
 */

export interface FleetNodeSnapshot {
  id: string
  state: string
  runner: string
  host: string | null
  lastError: string | null
}

export interface FleetAgentSnapshot {
  id: string
  hostname: string
  online: boolean
}

export interface FleetWatchdogDeps {
  db: Db
  /** agent 机器快照（缺省 = 直接读 agentMachine 表，按心跳判定在线）。 */
  agents?: () => FleetAgentSnapshot[]
  /** 节点监督器快照（wiring 从 nodeSupervisors 迭代注入）。 */
  nodeStates?: () => FleetNodeSnapshot[]
}

/** 铃铛里是否已存在同一对象（agent id）的未读掉线告警（重启去重）。 */
const hasUnreadAlert = (db: Db, kind: string, needle: string): boolean =>
  db
    .select()
    .from(schema.notification)
    .where(eq(schema.notification.kind, kind))
    .orderBy(desc(schema.notification.at))
    .all()
    .some((n) => n.read === 0 && n.body.includes(needle))

export const createFleetWatchdog = (deps: FleetWatchdogDeps): (() => { alerts: number }) => {
  const { db } = deps
  // 进程内状态：agent:<id> / node:<id> → 上一观测值（重启后首个观测 = 基线）
  const last = new Map<string, string>()

  return () => {
    let alerts = 0

    // ---- agent 机器：心跳超时 = 掉线（AGENT_OFFLINE_MS 与 /api/agents 同源）----
    const agents = deps.agents?.() ?? db
      .select()
      .from(schema.agentMachine)
      .where(isNull(schema.agentMachine.revokedAt))
      .all()
      .map((r) => ({
        id: r.id,
        hostname: r.hostname,
        online: r.lastSeenAt !== null && Date.now() - r.lastSeenAt <= AGENT_OFFLINE_MS,
      }))
    for (const agent of agents) {
      const key = `agent:${agent.id}`
      const prev = last.get(key)
      if (!agent.online) {
        if (prev !== 'offline' && !hasUnreadAlert(db, 'agent_offline', `（${agent.id}）`)) {
          notify(db, {
            kind: 'agent_offline',
            title: `machine ${agent.hostname} went offline`,
            body: `machine ${agent.hostname} (${agent.id}) has not sent a heartbeat for over ${Math.round(AGENT_OFFLINE_MS / 1000)}s — commands for nodes on it cannot be delivered`,
            link: '/nodes',
          })
          alerts += 1
        }
        last.set(key, 'offline')
      } else {
        if (prev === 'offline') {
          notify(db, { kind: 'agent_recovered', title: `machine ${agent.hostname} recovered`, body: `machine ${agent.hostname} (${agent.id}) is sending heartbeats again`, link: '/nodes' })
          alerts += 1
        }
        last.set(key, 'online')
      }
    }

    // ---- agent 节点：监督器 offline = 异常（冷态/starting 是过渡态，不报）----
    for (const node of deps.nodeStates?.() ?? []) {
      if (node.runner !== 'agent') continue
      const key = `node:${node.id}`
      const prev = last.get(key)
      if (node.state === 'offline') {
        if (prev !== 'offline' && !hasUnreadAlert(db, 'node_offline', `node ${node.id}`)) {
          notify(db, {
            kind: 'node_offline',
            title: `node ${node.id} is abnormal`,
            body: `node ${node.id} is down${node.host !== null ? ` (agent ${node.host})` : ''}: ${node.lastError ?? 'probe failed'}`,
            link: '/nodes',
          })
          alerts += 1
        }
        last.set(key, 'offline')
      } else if (node.state === 'live') {
        if (prev === 'offline') {
          notify(db, { kind: 'node_recovered', title: `node ${node.id} recovered`, body: `node ${node.id} is online again`, link: '/nodes' })
          alerts += 1
        }
        last.set(key, 'live')
      }
      // starting/restarting/cold：不改变上一判定（只有 live 才算恢复）
    }

    return { alerts }
  }
}
