import { test } from 'node:test'
import assert from 'node:assert/strict'
import { useTestDictionary } from './test-i18n.mjs'

// 先注入语言包再加载被测模块（模块顶层会 await loadI18n）。
useTestDictionary('en')

const { machineRowHtml, joinCommand, localMachineRowHtml } = await import('./machines.js')

test('UI 收尾 C-P1.5: 本机行——直管标注/平台信息/无 agent 专属动作', () => {
  const html = localMachineRowHtml({ hostname: 'WIN-PC', os: 'win32', arch: 'x64', nodeVersion: '22.23.2', containerForm: false, nodeCount: 3 })
  assert.ok(html.includes('This host (manager)'), '行首标注本机身份')
  assert.ok(html.includes('direct'), '直管 pill')
  assert.ok(html.includes('Windows/x64'), '平台名映射 + 架构')
  assert.ok(html.includes('node 22.23.2'))
  assert.ok(html.includes('WIN-PC'))
  assert.ok(html.includes('3'), '直管节点数')
  assert.ok(html.includes('no node-agent'), '标注不经 agent')
  assert.ok(!html.includes('data-agent-revoke'), '本机行不渲染吊销按钮')
  assert.ok(!html.includes('data-agent-rotate'), '本机行不渲染轮换按钮')
  assert.ok(!html.includes('data-agent-delete'), '本机行不渲染删除按钮')
  assert.ok(!html.includes('update available'), '本机行无待更新徽标')
  assert.ok(!html.includes('CPU'), '本机行无指标徽标')
  const docker = localMachineRowHtml({ hostname: 'srv', os: 'linux', arch: 'arm64', nodeVersion: '22.23.2', containerForm: true, nodeCount: 1 })
  assert.ok(docker.includes('container node'), '容器部署形态标注')
})

test('能力四 M1-7: 机器行——在线/离线/吊销/待执行指令各态渲染', () => {
  const base = { id: 'agent-abc123', hostname: 'srv-b', os: 'linux', arch: 'amd64', nodeVersion: '22.23.2', joinedAt: Date.now(), online: true, revoked: false, pendingCommands: 0 }
  assert.ok(machineRowHtml(base).includes('dot ok'), '在线绿点')
  assert.ok(machineRowHtml(base).includes('srv-b'))
  assert.ok(machineRowHtml({ ...base, online: false }).includes('dot err'), '离线红点')
  assert.ok(machineRowHtml({ ...base, online: false }).includes('offline'))
  assert.ok(machineRowHtml({ ...base, revoked: true }).includes('revoked'), '吊销态文案')
  assert.ok(!machineRowHtml({ ...base, revoked: true }).includes('data-agent-revoke'), '已吊销不显示吊销按钮')
  assert.ok(machineRowHtml({ ...base, pendingCommands: 3 }).includes('3 commands queued'))
  assert.ok(machineRowHtml(base).includes('data-agent-revoke="agent-abc123"'))
  assert.ok(machineRowHtml(base).includes('data-agent-rotate="agent-abc123"'), 'M4-1: 未吊销机器显示轮换密钥按钮')
  assert.ok(!machineRowHtml({ ...base, revoked: true }).includes('data-agent-rotate'), '已吊销不显示轮换按钮')
  assert.ok(machineRowHtml({ ...base, revoked: true }).includes('data-agent-delete="agent-abc123"'), 'UI 收尾 B: 已吊销显示删除记录按钮')
  assert.ok(!machineRowHtml(base).includes('data-agent-delete'), '未吊销不显示删除按钮')
  // M4-3：版本协商徽标
  assert.ok(machineRowHtml({ ...base, agentVersion: '1.0.0', managerVersion: '1.1.2' }).includes('update available'), '旧版本显示待更新徽标')
  assert.ok(!machineRowHtml({ ...base, agentVersion: '1.1.2', managerVersion: '1.1.2' }).includes('update available'), '同版本无徽标')
  assert.ok(!machineRowHtml({ ...base, agentVersion: null, managerVersion: '1.1.2' }).includes('update available'), '旧 agent 未上报版本不误报')
  // M4-4：最新指标快照
  const withMetrics = machineRowHtml({ ...base, latestMetric: { cpuPercent: 125, memTotal: 16_000_000_000, memUsed: 8_000_000_000, diskTotal: 500_000_000_000, diskFree: 200_000_000_000, uptime: 3600 } })
  assert.ok(withMetrics.includes('CPU 12.5%'), 'CPU 快照（×10 整数换算）')
  assert.ok(withMetrics.includes('memory 50%'), '内存占比')
  assert.ok(withMetrics.includes('disk 60%'), '磁盘占比')
  assert.ok(!machineRowHtml(base).includes('CPU'), '无指标不渲染')
})

test('能力四 M1-7: join 命令——origin 与 token 注入，静态面分发 join.sh', () => {
  const cmd = joinCommand('https://app.example.com', 'dac-join-xyz')
  assert.ok(cmd.includes('https://app.example.com/assets/agent/join.sh'), 'join.sh 走 manager 静态面')
  assert.ok(cmd.includes('MANAGER_URL=https://app.example.com'), 'MANAGER_URL 注入')
  assert.ok(cmd.includes('AGENT_JOIN_TOKEN=dac-join-xyz'), '一次性 token 注入')
  assert.ok(cmd.includes('| sudo '), '管道交给 sudo')
  assert.ok(cmd.trimEnd().endsWith(' bash'), 'bash 从 stdin 读脚本')
})

/**
 * 事故回归（2026-09-25，全新 Ubuntu 20.04 实测）：
 *
 * ① 必须提权——join.sh 装的是 systemd **system** unit，非 root 会被显式拒绝。
 * ② **赋值必须在 sudo 右边**。`FOO=bar sudo bash` 里的 FOO 会被 sudo 的
 *    `Defaults env_reset` 丢掉，脚本报「需要 MANAGER_URL」当场退出——这就是
 *    一键命令在干净机器上第一步失败的原因。实测 `sudo FOO=bar bash` 才稳
 *    （赋值作为 sudo 的命令参数）；`sudo -E` 依赖调用方 sudoers 允许，不可依赖。
 */
test('事故回归: join 命令的 env 赋值必须在 sudo 右边，否则会被 env_reset 丢掉', () => {
  const cmd = joinCommand('https://app.example.com', 'dac-join-xyz')
  const afterPipe = cmd.slice(cmd.indexOf('|') + 1).trim()
  assert.match(
    afterPipe,
    /^sudo MANAGER_URL=\S+ AGENT_JOIN_TOKEN=\S+ bash$/,
    'sodu 右侧依次是 sudo / 两个赋值 / bash',
  )
  assert.ok(!/^MANAGER_URL=/.test(afterPipe), 'env 前缀绝不能出现在 sudo 左边（会被 env_reset 清掉）')
  assert.ok(!cmd.includes('sudo -E'), '不依赖 -E：它取决于调用方 sudoers 是否允许')
  assert.ok(!cmd.includes('sudo curl'), 'sudo 不得落在 curl 上')
})
