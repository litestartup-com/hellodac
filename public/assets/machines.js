// @ts-check
// 能力四（舰队 M1-7）：机器页纯函数层——agent 列表行与 join 命令拼装。
// DOM 装配在 nodes.js；可单测（machines.test.mjs）。
import { esc, platformLabel, t, loadI18n } from './ui.js'

await loadI18n()

/**
 * M4-4：最新指标快照徽标文案（CPU % / 内存 % / 磁盘 %）；无快照返回空数组。
 * 机器列表与集群拓扑共用同一换算（×10 整数、占比四舍五入）。
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
 * 机器（agent）行：在线点 / 吊销态 / 待执行指令数 / 待更新徽标（M4-3）。
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
 * join 命令（Linux 一条命令加入）：join.sh 由 manager 静态面分发。
 *
 * 事故回归（2026-09-25，全新机器实测抓到）：**env 前缀绝不能放在 sudo 左边**。
 * sudo 默认 `Defaults env_reset`，会把 `FOO=bar sudo bash` 里的 FOO 直接丢掉，
 * 脚本因而报「需要 MANAGER_URL」当场退出——照着命令做的用户第一步就失败。
 * 实测三种写法（ubuntu 20.04 / sudo 1.8.31）：
 *   FOO=bar sudo bash      → FOO 为空（错）
 *   sudo -E FOO=bar bash   → FOO=bar（但 -E 依赖调用方 sudoers 允许，不可依赖）
 *   sudo FOO=bar bash      → FOO=bar（赋值是 sudo 自己的命令参数，稳）
 * 取第三种：提权的仍是读 stdin 的 bash，两个变量作为 sudo 参数注入，不依赖环境保留。
 *
 * @param {string} origin manager 站点源（如 https://app.example.com）
 * @param {string} token 一次性 join token
 * @returns {string}
 */
export const joinCommand = (origin, token) =>
  `curl -fsSL ${origin}/assets/agent/join.sh | sudo MANAGER_URL=${origin} AGENT_JOIN_TOKEN=${token} bash`

/**
 * 本机行（UI 收尾 C-P1.5）：manager 宿主不是 node-agent 注册机器（机器目录
 * 语义 = 受管远端主机），但列表首行显式画出——纯 UI 投影，不写 agent_machine
 * 表。无 agent 专属动作（轮换/吊销/删除对本机无意义）、无待更新徽标、无指标
 * （本机指标不经 agent 上报）。点行跳「全部节点」区块。
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
