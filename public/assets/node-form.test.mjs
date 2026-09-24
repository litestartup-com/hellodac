import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nodeCreatePayload, hostRunnerConfirmText, dangerSandboxConfirmText, versionOptionsHtml } from './node-form.js'

import { useTestDictionary } from './test-i18n.mjs'

useTestDictionary('en')

test('能力一回归: runner=auto 时省略字段（后端按部署自动判定），显式选择才下发', () => {
  const base = { name: 'worker', port: '3083', dshVersion: '', agent: { preset: 'standard', sandboxMode: 'workspace-write' } }
  assert.deepEqual(nodeCreatePayload({ ...base, runner: 'auto' }), {
    name: 'worker', port: 3083, agent: { preset: 'standard', sandboxMode: 'workspace-write' },
  }, 'auto = 不下发 runner；版本空串 = 跟随默认不下发')
  assert.deepEqual(nodeCreatePayload({ ...base, runner: 'process' }), {
    name: 'worker', port: 3083, runner: 'process', agent: { preset: 'standard', sandboxMode: 'workspace-write' },
  }, '显式 process 下发')
  assert.deepEqual(nodeCreatePayload({ ...base, runner: 'docker' }), {
    name: 'worker', port: 3083, runner: 'docker', agent: { preset: 'standard', sandboxMode: 'workspace-write' },
  }, '显式 docker 下发')
})

test('能力四 M1-7 回归: 选了主机 = host+url 一起下发；未选则缺省不出现', () => {
  const base = { name: 'ops01', port: '', runner: 'auto', dshVersion: '', agent: { preset: 'standard', sandboxMode: 'workspace-write' } }
  assert.deepEqual(nodeCreatePayload({ ...base, host: 'agent-abc123', url: 'http://10.0.0.7:3081' }), {
    name: 'ops01', host: 'agent-abc123', url: 'http://10.0.0.7:3081', agent: { preset: 'standard', sandboxMode: 'workspace-write' },
  }, 'agent 远端节点 = host + url 下发')
  assert.deepEqual(nodeCreatePayload({ ...base, host: '', url: '' }), {
    name: 'ops01', agent: { preset: 'standard', sandboxMode: 'workspace-write' },
  }, '未选主机不下发')
})

test('能力二回归: 向导选版本 → dsh_version 进载荷；缺省字段不出现', () => {
  const base = { name: 'v15', port: '', runner: 'auto', agent: { preset: 'standard', sandboxMode: 'workspace-write' } }
  assert.deepEqual(nodeCreatePayload({ ...base, dshVersion: '0.1.5-rc.2' }), {
    name: 'v15', dsh_version: '0.1.5-rc.2', agent: { preset: 'standard', sandboxMode: 'workspace-write' },
  }, '选中版本下发 dsh_version；空端口省略')
  assert.deepEqual(nodeCreatePayload({ ...base, dshVersion: '' }), {
    name: 'v15', agent: { preset: 'standard', sandboxMode: 'workspace-write' },
  }, '空串 = 跟随矩阵首行')
  assert.deepEqual(nodeCreatePayload(base), {
    name: 'v15', agent: { preset: 'standard', sandboxMode: 'workspace-write' },
  }, '缺省字段不出现 dsh_version')
})

test('能力一回归: 宿主机进程形态的确认文案含整机风险警告', () => {
  const text = hostRunnerConfirmText('ops-agent')
  assert.match(text, /host process/)
  assert.match(text, /whole machine/)
  assert.match(text, /ops-agent/)
})

test('舰队 M3-1 回归: ops 第三档沙箱进载荷 + 独立黄字确认文案（审批卡片/凭据口径）', () => {
  const payload = nodeCreatePayload({
    name: 'ops01', port: '', runner: 'auto', dshVersion: '',
    host: 'agent-abc123', url: 'http://10.0.0.7:3081',
    agent: { preset: 'standard', sandboxMode: 'danger-full-access' },
  })
  assert.equal(payload.agent.sandboxMode, 'danger-full-access', '第三档沙箱原样下发（后端 schema 已放行）')
  const text = dangerSandboxConfirmText('ops01')
  assert.match(text, /full-access/)
  assert.match(text, /approval card/)
  assert.match(text, /never receives them/)
})

test('P2 回归: versionOptionsHtml——跟随默认/当前钉版选中态/pending 标注', () => {
  const list = [
    { dsh: '0.1.2-rc.1', status: 'verified' },
    { dsh: '0.1.5-rc.2', status: 'pending' },
  ]
  const dflt = versionOptionsHtml(list, null)
  assert.ok(dflt.includes('<option value="" selected>Follow the default</option>'), '未钉版 = 跟随默认选中')
  assert.ok(dflt.includes('0.1.2-rc.1') && dflt.includes('0.1.5-rc.2'), '矩阵行全列出')
  assert.ok(dflt.includes('(unverified)'), 'pending 配对带标注')

  const pinned = versionOptionsHtml(list, '0.1.5-rc.2')
  assert.ok(pinned.includes('value="0.1.5-rc.2" selected'), '当前钉版选中')
  assert.ok(!pinned.includes('<option value="" selected>'), '钉版后不选跟随默认')

  assert.equal(versionOptionsHtml(undefined, null), '<option value="" selected>Follow the default</option>', '数据源缺失不炸')
})
