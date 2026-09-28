import type { Db } from '../db/index.js'
import { desc, eq, isNull } from 'drizzle-orm'
import { schema } from '../db/index.js'
import { notify } from '../notify.js'
import { AGENT_OFFLINE_MS } from '../routes/agents.js'

/**
 * Capability four (Fleet M3-3, the §13 patch pulled forward): the fleet watchdog -- an agent going offline or an
 * agent node turning abnormal raises an in-app notification (the bell). Edge-triggered (a state transition is reported
 * once), and unread dedup keeps a manager restart from spamming the bell (same object already unread = do not insert).
 *
 * Scope: only "agent runner" nodes are reported (a remote node dying silently is the Fleet's new blind spot);
 * local process/docker nodes already have supervisor retries plus a red dot on the nodes page, so this stays out of their way.
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
  /** The agent machine snapshot (by default it reads the agentMachine table directly and decides online by heartbeat). */
  agents?: () => FleetAgentSnapshot[]
  /** The node supervisor snapshot (wiring injects it by iterating nodeSupervisors). */
  nodeStates?: () => FleetNodeSnapshot[]
}

/** Whether the bell already holds an unread offline alert for the same object (agent id) -- dedup across restarts. */
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
  // In-process state: agent:<id> / node:<id> -> the previous observation (the first observation after a restart is the baseline)
  const last = new Map<string, string>()

  return () => {
    let alerts = 0

    // ---- agent machines: a heartbeat timeout = offline (AGENT_OFFLINE_MS comes from the same source as /api/agents) ----
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

    // ---- agent nodes: supervisor offline = abnormal (cold/starting are transitional states and are not reported) ----
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
      // starting/restarting/cold: the previous verdict is kept (only live counts as recovery)
    }

    return { alerts }
  }
}
