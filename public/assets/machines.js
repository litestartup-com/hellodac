// @ts-check
// Capability four (fleet M1-7): pure function layer of the machines page -- agent list rows and join
// command assembly. DOM assembly lives in nodes.js; unit-testable (machines.test.mjs).
import { esc, platformLabel, t, loadI18n } from './ui.js'

await loadI18n()

/**
 * M4-4: badge text for the newest metrics snapshot (CPU % / memory % / disk %); an empty array when there
 * is no snapshot. The machine list and the cluster topology share this conversion (permille integers,
 * percentages rounded).
 * @param {{ cpuPercent?: number | null, memTotal?: number | null, memUsed?: number | null, diskTotal?: number | null, diskFree?: number | null } | null | undefined} lm
 * @returns {string[]}
 */
export const machineMetricBits = (lm) => {
  if (lm === null || lm === undefined) return []
  const pct = (used, total) => (typeof used === 'number' && typeof total === 'number' && total > 0 ? Math.round((used / total) * 100) : null)
  return [
    typeof lm.cpuPercent === 'number' ? t('machines.cpu', { percent: lm.cpuPercent / 10 }) : null,
    pct(lm.memUsed, lm.memTotal) !== null ? t('machines.mem', { percent: pct(lm.memUsed, lm.memTotal) }) : null,
    pct(lm.diskTotal - lm.diskFree, lm.diskTotal) !== null ? t('machines.disk', { percent: pct(lm.diskTotal - lm.diskFree, lm.diskTotal) }) : null,
  ].filter(Boolean)
}

/**
 * Machine (agent) row: online dot / revoked state / pending command count / update badge (M4-3).
 * @param {{ id: string, hostname: string, os: string, arch: string, nodeVersion: string, joinedAt: number, online: boolean, revoked: boolean, pendingCommands: number, agentVersion?: string | null, managerVersion?: string }} m
 * @returns {string}
 */
export const machineRowHtml = (m) => {
  const dot = m.revoked ? 'muted' : m.online ? 'ok' : 'err'
  const when = new Date(m.joinedAt).toLocaleString('zh-CN', { hour12: false })
  const stale = typeof m.agentVersion === 'string' && m.agentVersion !== '' && typeof m.managerVersion === 'string' && m.agentVersion !== m.managerVersion
  const metricBits = machineMetricBits(m.latestMetric)
  const detail = [
    m.online ? t('machines.online') : t('machines.offline'),
    t('machines.registeredAt', { time: when }),
    m.pendingCommands > 0 ? t('machines.pendingCommands', { count: m.pendingCommands }) : null,
    typeof m.agentVersion === 'string' && m.agentVersion !== '' ? `agent v${m.agentVersion}` : null,
    ...metricBits,
    m.revoked ? t('machines.revoked') : null,
  ].filter(Boolean).join(' · ')
  return `<div class="node-row" data-machine-row="${esc(m.id)}">
    <div class="node-main">
      <div class="node-title"><span class="dot ${dot}"></span>${esc(m.hostname)} <span class="muted">· ${esc(m.os)}/${esc(m.arch)} · node ${esc(m.nodeVersion)}</span>${stale ? ` <span class="badge warn">${esc(t('machines.stale'))}</span>` : ''}</div>
      <div class="node-detail">${esc(detail)}</div>
    </div>
    <div class="node-actions">
      ${m.revoked
        ? `<button type="button" class="btn-quiet btn-sm" data-agent-delete="${esc(m.id)}">${esc(t('machines.action.delete'))}</button>`
        : `<button type="button" class="btn-quiet btn-sm" data-agent-rotate="${esc(m.id)}">${esc(t('machines.action.rotate'))}</button>`}
      ${m.revoked ? '' : `<button type="button" class="btn-quiet btn-sm" data-agent-revoke="${esc(m.id)}">${esc(t('machines.action.revoke'))}</button>`}
    </div>
  </div>`
}

/**
 * Join command (one line to join from Linux): join.sh is served from the manager's static surface.
 *
 * Incident regression (2026-09-25, caught on a brand-new machine): an **env prefix must never sit left of sudo**.
 * sudo defaults to `Defaults env_reset`, which drops FOO from `FOO=bar sudo bash`, so the script reports
 * "MANAGER_URL is required" and exits -- a user following the command fails on the very first step.
 * Three forms measured (ubuntu 20.04 / sudo 1.8.31):
 *   FOO=bar sudo bash      -> FOO empty (wrong)
 *   sudo -E FOO=bar bash   -> FOO=bar (but -E depends on the caller's sudoers, not something to rely on)
 *   sudo FOO=bar bash      -> FOO=bar (the assignment is an argument to sudo itself; reliable)
 * The third form wins: bash still reads stdin after the privilege escalation, and both variables are injected
 * as sudo arguments instead of relying on the environment surviving.
 *
 * @param {string} origin manager site origin (e.g. https://app.example.com)
 * @param {string} token one-time join token
 * @returns {string}
 */
export const joinCommand = (origin, token) =>
  `curl -fsSL ${origin}/assets/agent/join.sh | sudo MANAGER_URL=${origin} AGENT_JOIN_TOKEN=${token} bash`

/**
 * The local row (UI wrap-up C-P1.5): the manager host is not a node-agent registered machine (the machine
 * directory means managed remote hosts), but the list shows it explicitly on the first row -- a pure UI
 * projection that writes nothing to the agent_machine table. It has no agent-only actions (rotate/revoke/
 * delete are meaningless for this host), no update badge and no metrics (local metrics do not arrive through
 * an agent). Clicking the row jumps to the "all nodes" section.
 * @param {{ hostname: string, os: string, arch: string, nodeVersion: string, containerForm: boolean, nodeCount: number }} m
 * @returns {string}
 */
export const localMachineRowHtml = (m) => {
  const deploy = m.containerForm ? t('nodes.local.deployDocker') : t('nodes.local.deployProcess')
  return `<div class="node-row" data-local-machine-row title="${esc(t('topology.local.title'))}">
    <div class="node-main">
      <div class="node-title"><span class="dot ok"></span>${esc(t('nodes.local.row'))} <span class="pill-mini">${esc(t('nodes.local.direct'))}</span> <span class="muted">· ${esc(platformLabel(m.os))}/${esc(m.arch)} · node ${esc(m.nodeVersion)}</span></div>
      <div class="node-detail">${esc(t('nodes.local.detail', { hostname: m.hostname, deploy, count: m.nodeCount }))}</div>
    </div>
    <div class="node-side"><button type="button" class="btn-quiet btn-sm" data-local-jump>${esc(t('nodes.local.jump'))}</button></div>
  </div>`
}
