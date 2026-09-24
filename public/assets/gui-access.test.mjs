import { test } from 'node:test'
import assert from 'node:assert/strict'
import { guiTunnelCommand, guiCardHtml, guiDirectCardHtml, guiSetupButton } from './gui-access.js'

import { useTestDictionary } from './test-i18n.mjs'

useTestDictionary('en')

const ACCESS = { sshUser: 'ubuntu', sshHost: '10.0.0.5', sshPort: 22, guiPort: 3080, localPort: 3088 }

test('债务 P1 回归: 隧道命令——-N 纯隧道、22 端口省略 -p、其余字段照拼', () => {
  assert.equal(
    guiTunnelCommand(ACCESS),
    'ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:3088:127.0.0.1:3080 ubuntu@10.0.0.5',
  )
  assert.equal(
    guiTunnelCommand({ ...ACCESS, sshPort: 2222, guiPort: 3082, localPort: 4090 }),
    'ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:4090:127.0.0.1:3082 -p 2222 ubuntu@10.0.0.5',
  )
})

test('体验优化回归: 私钥路径——配置了 ssh_key 命令带 -i，留空/缺省不带', () => {
  assert.equal(
    guiTunnelCommand({ ...ACCESS, sshKey: 'C:\\Users\\you\\.ssh\\id_ed25519' }),
    'ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:3088:127.0.0.1:3080 ubuntu@10.0.0.5 -i "C:\\Users\\you\\.ssh\\id_ed25519"',
  )
  assert.ok(!guiTunnelCommand(ACCESS).includes(' -i '), '未配置私钥 = 用 ssh 默认密钥')
  assert.ok(!guiTunnelCommand({ ...ACCESS, sshKey: '' }).includes(' -i '))
})

test('债务 P1 回归: GUI 卡——命令+打开按钮；guiUrl 为空时按钮禁用并提示', () => {
  const ready = guiCardHtml('brain', ACCESS, 'http://127.0.0.1:3088/?token=tok-1')
  assert.ok(ready.includes('ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:3088:127.0.0.1:3080 ubuntu@10.0.0.5'), '卡片含隧道命令')
  assert.ok(ready.includes('data-gui-open="brain"'), '打开按钮挂节点 id')
  assert.ok(ready.includes('http://127.0.0.1:3088/?token=tok-1'), '打开 URL 拼入')
  assert.ok(!ready.includes('disabled'), '有 guiUrl 时按钮不禁用')
  assert.ok(ready.includes('Permission denied'), '含私钥提示语')

  const booting = guiCardHtml('brain', ACCESS, null)
  assert.ok(booting.includes('disabled'), '节点未就绪时打开按钮禁用')
})

test('体验优化回归: 本机直连卡——无需隧道命令，直接打开 + 配置隧道入口', () => {
  const html = guiDirectCardHtml('personal', 'http://127.0.0.1:3081/?token=tok-9')
  assert.ok(html.includes('direct on this host'), '标题注明直连形态')
  assert.ok(!html.includes('ssh -N'), '不出现隧道命令')
  assert.ok(html.includes('data-gui-open="personal"'), '打开按钮挂节点 id')
  assert.ok(html.includes('http://127.0.0.1:3081/?token=tok-9'), '打开 URL 拼入')
  assert.ok(html.includes('data-node-access="personal"'), '仍可切换到隧道配置')
})

test('债务 P1 回归: 未配置 access 的非本机节点显示「配置原生访问」入口', () => {
  const html = guiSetupButton('personal')
  assert.ok(html.includes('data-node-access="personal"'), '配置入口挂节点 id')
  assert.ok(html.includes('Set up native access'), '文案')
})
