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
  assert.ok(cmd.includes('| MANAGER_URL='), '管道 + env 前缀执行')
  assert.ok(cmd.trimEnd().endsWith('sudo bash'), 'bash 从 stdin 读脚本，且必须提权')
})

/**
 * 事故回归（2026-09-25 ubuntu-focal 失联）：join.sh 装 systemd **system**
 * unit 后要求 root。生成的命令必须把 sudo 加在**读 stdin 的 bash** 上——
 * 漏了 sudo 则照 README 走的用户第一步就吃「需要 root」报错；加错地方
 * （sudo curl）则环境变量前缀失效、脚本下到 root 当前目录。
 */
test('事故回归: join 命令必须提权，且 sudo 作用于 bash 而非 curl', () => {
  const cmd = joinCommand('https://app.example.com', 'dac-join-xyz')
  assert.ok(/\|\s*MANAGER_URL=\S+ AGENT_JOIN_TOKEN=\S+ sudo bash$/.test(cmd), 'sudo 紧贴 bash（env 前缀在外层 shell 赋值）')
  assert.ok(!cmd.includes('sudo curl'), 'sudo 不得落在 curl 上')
})
