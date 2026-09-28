// @ts-check
/**
 * Capability four (fleet M1-5/M4-3): the node-agent entry point.
 * Environment: MANAGER_URL (manager base), AGENT_JOIN_TOKEN (one-time registration token) and
 * AGENT_DIR (working directory, default ~/.dac-agent).
 * Installed as a persistent service by join.sh / join.ps1 (systemd unit / Windows scheduled task).
 *
 * M4-3: apply the self-update swap or rollback first (pure fs, see update.mjs) and only then load the runtime
 * dynamically -- so the new code is already swapped in atomically, with an automatic rollback to the previous
 * generation when it crashes immediately.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { applyPendingUpdate } from './update.mjs'

const managerUrl = process.env.MANAGER_URL ?? ''
const joinToken = process.env.AGENT_JOIN_TOKEN ?? ''
const agentDir = process.env.AGENT_DIR ?? join(homedir(), '.dac-agent')

if (managerUrl === '' || joinToken === '') {
  console.error('[node-agent] MANAGER_URL and AGENT_JOIN_TOKEN are required (injected by join.sh)')
  process.exit(1)
}

applyPendingUpdate(agentDir)

const { AgentRuntime } = await import('./runtime.mjs')
const runtime = new AgentRuntime({ managerUrl, joinToken, agentDir })
await runtime.run()
