import { test } from 'node:test'
import assert from 'node:assert/strict'
import { useTestDictionary } from './test-i18n.mjs'

useTestDictionary('en')

const { formTag, machineAlive, managerCardHtml, machineCardHtml, nodeCardHtml, edgePairs, topologyHtml, localMachineCardHtml, platformLabel } =
  await import('./topology.js')

const machine = (over = {}) => ({
  id: 'agent-abc',
  hostname: 'srv-b',
  os: 'linux',
  arch: 'amd64',
  nodeVersion: '22.23.2',
  online: true,
  revoked: false,
  pendingCommands: 0,
  agentVersion: '1.1.1',
  managerVersion: '1.1.1',
  latestMetric: null,
  ...over,
})

const node = (over = {}) => ({
  id: 'spike02',
  state: 'live',
  agents: ['spike02'],
  managed: true,
  dshVersion: '0.1.5',
  dshCompatible: true,
  dshDrift: false,
  configuredDshVersion: null,
  host: null,
  image: null,
  ...over,
})

test('UI 收尾 C: 形态 tag——远端/容器/宿主机/外管', () => {
  assert.equal(formTag(node({ host: 'agent-abc' })), 'remote agent')
  assert.equal(formTag(node({ image: 'dac:0.1.5' })), 'container node')
  assert.equal(formTag(node({})), 'host process')
  assert.equal(formTag(node({ managed: false })), 'external')
})

test('UI 收尾 C: 机器在线态——在线且未吊销才算活', () => {
  assert.equal(machineAlive(machine()), true)
  assert.equal(machineAlive(machine({ online: false })), false)
  assert.equal(machineAlive(machine({ revoked: true })), false)
})

test('UI 收尾 C: manager 卡片——版本/监听面/部署形态/计数', () => {
  const html = managerCardHtml({ managerVersion: '1.1.2', origin: 'https://app.example.com', containerForm: false, machineCount: 3, nodeCount: 5 })
  assert.ok(html.includes('v1.1.2'))
  assert.ok(html.includes('https://app.example.com'))
  assert.ok(html.includes('bare-metal deployment'))
  assert.ok(html.includes('3 machines · 5 nodes'))
  assert.ok(managerCardHtml({ managerVersion: '1.1.2', origin: 'x', containerForm: true, machineCount: 0, nodeCount: 0 }).includes('container deployment'))
})

test('UI 收尾 C: 机器卡片——在线点/待更新/吊销/指标徽标', () => {
  const on = machineCardHtml(machine(), '1.1.1')
  assert.ok(on.includes('dot ok'), '在线绿点')
  assert.ok(on.includes('srv-b'))
  assert.ok(!on.includes('topo-item-off'), '在线不加离线类')
  assert.ok(!on.includes('update available'), '同版本无徽标')
  const stale = machineCardHtml(machine({ agentVersion: '1.0.0' }), '1.1.2')
  assert.ok(stale.includes('update available'), '旧 agent 版本显示待更新')
  const off = machineCardHtml(machine({ online: false }), '1.1.1')
  assert.ok(off.includes('topo-item-off'), '离线卡片加灰类')
  assert.ok(off.includes('dot err'), '离线红点')
  const revoked = machineCardHtml(machine({ revoked: true, online: true }), '1.1.1')
  assert.ok(revoked.includes('revoked'))
  const metrics = machineCardHtml(machine({ latestMetric: { cpuPercent: 125, memTotal: 16_000_000_000, memUsed: 8_000_000_000, diskTotal: 500_000_000_000, diskFree: 200_000_000_000 } }), '1.1.1')
  assert.ok(metrics.includes('CPU 12.5%'))
  assert.ok(metrics.includes('memory 50%'))
  assert.ok(metrics.includes('disk 60%'))
})

test('UI 收尾 C: 节点卡片——状态点/工作区/版本/漂移/主机映射', () => {
  const html = nodeCardHtml(node({}), new Map())
  assert.ok(html.includes('dot ok'), 'live 绿点')
  assert.ok(html.includes('spike02'))
  assert.ok(html.includes('DSH 0.1.5'))
  assert.ok(html.includes('host process'))
  assert.ok(!html.includes('profile drift'))
  const warn = nodeCardHtml(node({ dshCompatible: false, dshDrift: true }), new Map())
  assert.ok(warn.includes('version mismatch') && warn.includes('profile drift'))
  const remote = nodeCardHtml(node({ host: 'agent-abc' }), new Map([['agent-abc', 'srv-b']]))
  assert.ok(remote.includes('remote agent'))
  assert.ok(remote.includes('host srv-b'), '主机名映射')
  const cold = nodeCardHtml(node({ state: 'offline' }), new Map())
  assert.ok(cold.includes('dot bad'), 'offline 红点')
})

test('UI 收尾 C-P1.5: 本机卡——平台映射/部署形态/直管节点数', () => {
  assert.equal(platformLabel('win32'), 'Windows')
  assert.equal(platformLabel('linux'), 'Linux')
  assert.equal(platformLabel('darwin'), 'macOS')
  assert.equal(platformLabel('freebsd'), 'freebsd', '未知平台回退原文')
  const html = localMachineCardHtml({ os: 'win32', arch: 'x64', containerForm: false, nodeCount: 3 })
  assert.ok(html.includes('data-topo-machine="local"'), '本机卡挂在机器列（local 伪机器 id）')
  assert.ok(html.includes('This host (manager)'))
  assert.ok(html.includes('host process'))
  assert.ok(html.includes('Windows'))
  assert.ok(html.includes('direct 3'))
  assert.ok(localMachineCardHtml({ os: 'linux', arch: 'arm64', containerForm: true, nodeCount: 1 }).includes('container node'))
})

test('UI 收尾 C: 边配对——manager→机器全连，节点随 host 归属', () => {
  const machines = [machine(), machine({ id: 'agent-off', online: false, hostname: 'srv-off' })]
  const nodes = [
    node({ id: 'a', host: 'agent-abc' }),
    node({ id: 'b', host: 'agent-off' }),
    node({ id: 'c', host: null }),
    node({ id: 'd', host: 'agent-gone' }),
    node({ id: 'e', state: 'offline', host: null }),
  ]
  const pairs = edgePairs(machines, nodes, true)
  const pairOf = (from, to) => pairs.find((p) => p.from === from && p.to === to)
  assert.equal(pairOf('manager', 'machine:agent-abc').on, true, '在线机器绿边')
  assert.equal(pairOf('manager', 'machine:agent-off').on, false, '离线机器红虚线')
  assert.equal(pairOf('machine:agent-abc', 'node:a').on, true, '在线主机 → 节点绿边')
  assert.equal(pairOf('machine:agent-off', 'node:b').on, false, '离线主机 → 节点红虚线')
  assert.equal(pairOf('manager', 'machine:local').on, true, 'C-P1.5: 有本机节点时 manager→本机卡常绿')
  assert.equal(pairOf('machine:local', 'node:c').on, true, 'C-P1.5: 本机节点从本机卡出发（live 绿边）')
  assert.equal(pairOf('machine:local', 'node:e').on, false, 'C-P1.5: 本机离线节点红虚线')
  assert.equal(pairOf('manager', 'node:d').on, true, 'host 不在机器目录 → 回退 manager')
  assert.equal(pairs.length, machines.length + 1 + nodes.length, '边数 = 机器数 + 本机卡 + 节点数')
  const withoutLocal = edgePairs(machines, nodes, false)
  assert.equal(withoutLocal.find((p) => p.to === 'machine:local'), undefined, '没有本机节点不画本机边')
  assert.equal(withoutLocal.find((p) => p.from === 'manager' && p.to === 'node:c').on, true, '无本机卡时本机节点回退 manager')
})

test('UI 收尾 C: 拓扑骨架——三列齐备，离线机器折叠', () => {
  const data = {
    managerVersion: '1.1.2',
    origin: 'https://app.example.com',
    containerForm: false,
    machines: [machine(), machine({ id: 'agent-off', online: false, hostname: 'srv-off' }), machine({ id: 'agent-rev', revoked: true, hostname: 'srv-rev' })],
    nodes: [node({}), node({ id: 'ops33', agents: ['ops33'], state: 'offline' })],
    localHost: { os: 'win32', arch: 'x64' },
  }
  const html = topologyHtml(data)
  assert.ok(html.includes('data-topo-manager'))
  assert.ok(html.includes('data-topo-machine="agent-abc"'))
  assert.ok(html.includes('data-topo-node="spike02"'))
  assert.ok(html.includes('data-topo-node="ops33"'))
  assert.ok(html.includes('2 offline / revoked'), '离线 + 吊销收进折叠区')
  assert.ok(html.indexOf('data-topo-machine="agent-off"') < html.indexOf('data-topo-machine="agent-rev"'), '离线机器在折叠区内')
  assert.ok(html.includes('data-topo-machine="local"'), 'C-P1.5: 有本机节点时渲染本机卡')
  assert.ok(html.indexOf('data-topo-machine="local"') < html.indexOf('data-topo-machine="agent-abc"'), '本机卡排在机器列最前')
  const onlyOnline = topologyHtml({ ...data, machines: [machine()] })
  assert.ok(!onlyOnline.includes('topo-fold'), '没有离线机器不渲染折叠区')
  const noLocalNodes = topologyHtml({ ...data, nodes: [node({ host: 'agent-abc' })], machines: [machine()] })
  assert.ok(!noLocalNodes.includes('data-topo-machine="local"'), '没有本机节点不渲染本机卡')
})
