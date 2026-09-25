// @ts-check
// 能力三 v1（2026-09-20）：节点原生 GUI 的隧道命令——纯函数层，可单测
// （gui-access.test.mjs）。
// 红线：SSH 私钥永不进 manager——只生成「怎么连」的命令，密钥留在用户本机
// （体验优化：ssh_key 只是用户本机上的私钥**路径**，非密钥内容）。
//
// UI 精简（DAC v1.0.0）：原先这里还有三张常显卡（隧道卡/直连卡/配置入口按钮），
// 挂在每个节点行右侧。节点行改成「状态 + ID + ⋮ 菜单」后它们没有调用方了——
// 隧道命令与「打开 GUI」搬进原生访问抽屉（配一次、用一次，本就该在一起），
// 所以三张卡随行内 UI 一起删除，只留这里真正共用的命令拼装。

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
