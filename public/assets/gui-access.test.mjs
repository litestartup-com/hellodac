import { test } from 'node:test'
import assert from 'node:assert/strict'
import { guiTunnelCommand } from './gui-access.js'

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

// UI 精简（DAC v1.0.0）：原「原生 GUI 卡」三张（隧道卡/直连卡/配置入口按钮）是
// 节点行右侧的常显区块，行改成「状态 + ID + ⋮ 菜单」后已无调用方，随行内 UI
// 一起删除；隧道命令与「打开 GUI」搬进原生访问抽屉（那里从表单值实时计算命令）。
// 所以这里只剩命令拼装的回归——它仍是生产代码，卡片渲染不再是。
