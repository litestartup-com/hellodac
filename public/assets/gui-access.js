// @ts-check
// 能力三 v1（2026-09-20）：节点原生 GUI 的隧道命令与卡片——纯函数层，
// DOM 装配留在 nodes.js。可单测（gui-access.test.mjs）。
// 红线：SSH 私钥永不进 manager——卡片只生成「怎么连」的命令，密钥留在用户本机
// （体验优化：ssh_key 只是用户本机上的私钥**路径**，非密钥内容）。
import { esc, t } from './ui.js'

/**
 * 用户在本机终端执行的隧道命令：本地 loopback localPort → 节点宿主机
 * loopback guiPort。ssh 端口 22 时省略 -p；配置了私钥路径则带 -i。
 * `-N`（纯隧道不开 shell）+ `-o ExitOnForwardFailure=yes`（映射口被占时大声失败）。
 * @param {{ sshUser: string, sshHost: string, sshPort: number, guiPort: number, localPort: number, sshKey?: string | null }} access
 * @returns {string}
 */
export const guiTunnelCommand = (access) => {
  const portPart = Number(access.sshPort) !== 22 ? ` -p ${Number(access.sshPort)}` : ''
  const keyPart = typeof access.sshKey === 'string' && access.sshKey !== '' ? ` -i "${access.sshKey}"` : ''
  return `ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:${Number(access.localPort)}:127.0.0.1:${Number(access.guiPort)}${portPart} ${access.sshUser}@${access.sshHost}${keyPart}`
}

/**
 * 节点行里的「原生 GUI」卡（SSH 隧道形态，已配置 access）。guiUrl 由后端按
 * 请求拼好（含 0.1.5 token）；null = 节点还没输出 GUI 启动行（未就绪），
 * 打开按钮禁用。
 * @param {string} nodeId
 * @param {{ sshUser: string, sshHost: string, sshPort: number, guiPort: number, localPort: number, sshKey?: string | null }} access
 * @param {string | null | undefined} guiUrl
 * @returns {string}
 */
export const guiCardHtml = (nodeId, access, guiUrl) => {
  const command = guiTunnelCommand(access)
  const notReady = guiUrl === null || guiUrl === undefined
  const urlAttr = notReady ? '' : ` data-gui-url="${esc(guiUrl)}"`
  return `<div class="node-gui">
    <div class="node-gui-title">${esc(t('gui.title'))} <span class="muted small">${esc(t('gui.tunnelNote'))}</span></div>
    <code class="node-gui-cmd">${esc(command)}</code>
    <div class="node-actions">
      <button type="button" class="btn-quiet btn-sm" data-gui-copy="${esc(nodeId)}" data-gui-cmd="${esc(command)}">${esc(t('common.copy'))}</button>
      <button type="button" class="btn btn-sm" data-gui-open="${esc(nodeId)}"${urlAttr}${notReady ? ' disabled' : ''}>${esc(t('gui.open'))}</button>
      <button type="button" class="btn-quiet btn-sm" data-node-access="${esc(nodeId)}">${esc(t('gui.configure'))}</button>
    </div>
    <div class="muted small">${esc(t('gui.tunnelHint'))}</div>
  </div>`
}

/**
 * 本机 loopback 节点的「原生 GUI」卡（直连形态，无需隧道）：浏览器与本机节点
 * 同为 loopback，直接打开即可。
 * @param {string} nodeId
 * @param {string} guiUrl
 * @returns {string}
 */
export const guiDirectCardHtml = (nodeId, guiUrl) => `<div class="node-gui">
    <div class="node-gui-title">${esc(t('gui.title'))} <span class="muted small">${esc(t('gui.directNote'))}</span></div>
    <div class="node-actions">
      <button type="button" class="btn btn-sm" data-gui-open="${esc(nodeId)}" data-gui-url="${esc(guiUrl)}">${esc(t('gui.open'))}</button>
      <button type="button" class="btn-quiet btn-sm" data-node-access="${esc(nodeId)}">${esc(t('gui.configureTunnel'))}</button>
    </div>
    <div class="muted small">${esc(t('gui.directHint'))}</div>
  </div>`

/** 未配置 access 且非本机直连的节点：一个「配置原生访问」入口。 */
export const guiSetupButton = (nodeId) =>
  `<button type="button" class="btn-quiet btn-sm" data-node-access="${esc(nodeId)}">${esc(t('gui.configureAccess'))}</button>`
