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

test('UI wrap-up C: form tag -- remote/container/host process/external', () => {
  assert.equal(formTag(node({ host: 'agent-abc' })), 'remote agent')
  assert.equal(formTag(node({ image: 'dac:0.1.5' })), 'container node')
  assert.equal(formTag(node({})), 'host process')
  assert.equal(formTag(node({ managed: false })), 'external')
})

test('UI wrap-up C: machine liveness -- online and not revoked is alive', () => {
  assert.equal(machineAlive(machine()), true)
  assert.equal(machineAlive(machine({ online: false })), false)
  assert.equal(machineAlive(machine({ revoked: true })), false)
})

test('UI wrap-up C: manager card -- version/listening surface/deployment form/counts', () => {
  const html = managerCardHtml({ managerVersion: '1.1.2', origin: 'https://app.example.com', containerForm: false, machineCount: 3, nodeCount: 5 })
  assert.ok(html.includes('v1.1.2'))
  assert.ok(html.includes('https://app.example.com'))
  assert.ok(html.includes('bare-metal deployment'))
  assert.ok(html.includes('3 machines · 5 nodes'))
  assert.ok(managerCardHtml({ managerVersion: '1.1.2', origin: 'x', containerForm: true, machineCount: 0, nodeCount: 0 }).includes('container deployment'))
})

test('UI wrap-up C: machine card -- online dot/update available/revoked/metric badge', () => {
  const on = machineCardHtml(machine(), '1.1.1')
  assert.ok(on.includes('dot ok'), 'online green dot')
  assert.ok(on.includes('srv-b'))
  assert.ok(!on.includes('topo-item-off'), 'no offline class while online')
  assert.ok(!on.includes('update available'), 'no badge on the same version')
  const stale = machineCardHtml(machine({ agentVersion: '1.0.0' }), '1.1.2')
  assert.ok(stale.includes('update available'), 'an old agent version shows update available')
  const off = machineCardHtml(machine({ online: false }), '1.1.1')
  assert.ok(off.includes('topo-item-off'), 'an offline card gets the greyed class')
  assert.ok(off.includes('dot err'), 'offline red dot')
  const revoked = machineCardHtml(machine({ revoked: true, online: true }), '1.1.1')
  assert.ok(revoked.includes('revoked'))
  const metrics = machineCardHtml(machine({ latestMetric: { cpuPercent: 125, memTotal: 16_000_000_000, memUsed: 8_000_000_000, diskTotal: 500_000_000_000, diskFree: 200_000_000_000 } }), '1.1.1')
  assert.ok(metrics.includes('CPU 12.5%'))
  assert.ok(metrics.includes('memory 50%'))
  assert.ok(metrics.includes('disk 60%'))
})

test('UI wrap-up C: node card -- state dot/workspace/version/drift/host mapping', () => {
  const html = nodeCardHtml(node({}), new Map())
  assert.ok(html.includes('dot ok'), 'live green dot')
  assert.ok(html.includes('spike02'))
  assert.ok(html.includes('DSH 0.1.5'))
  assert.ok(html.includes('host process'))
  assert.ok(!html.includes('profile drift'))
  const warn = nodeCardHtml(node({ dshCompatible: false, dshDrift: true }), new Map())
  assert.ok(warn.includes('version mismatch') && warn.includes('profile drift'))
  const remote = nodeCardHtml(node({ host: 'agent-abc' }), new Map([['agent-abc', 'srv-b']]))
  assert.ok(remote.includes('remote agent'))
  assert.ok(remote.includes('host srv-b'), 'hostname mapping')
  const cold = nodeCardHtml(node({ state: 'offline' }), new Map())
  assert.ok(cold.includes('dot bad'), 'offline red dot')
})

test('UI wrap-up C-P1.5: local card -- platform mapping/deployment form/directly managed node count', () => {
  assert.equal(platformLabel('win32'), 'Windows')
  assert.equal(platformLabel('linux'), 'Linux')
  assert.equal(platformLabel('darwin'), 'macOS')
  assert.equal(platformLabel('freebsd'), 'freebsd', 'an unknown platform falls back to the raw string')
  const html = localMachineCardHtml({ os: 'win32', arch: 'x64', containerForm: false, nodeCount: 3 })
  assert.ok(html.includes('data-topo-machine="local"'), 'the local card sits in the machine column (pseudo machine id "local")')
  assert.ok(html.includes('This host (manager)'))
  assert.ok(html.includes('host process'))
  assert.ok(html.includes('Windows'))
  assert.ok(html.includes('direct 3'))
  assert.ok(localMachineCardHtml({ os: 'linux', arch: 'arm64', containerForm: true, nodeCount: 1 }).includes('container node'))
})

test('UI wrap-up C: edge pairing -- manager links every machine, nodes follow their host', () => {
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
  assert.equal(pairOf('manager', 'machine:agent-abc').on, true, 'an online machine gets a green edge')
  assert.equal(pairOf('manager', 'machine:agent-off').on, false, 'an offline machine gets a dashed red edge')
  assert.equal(pairOf('machine:agent-abc', 'node:a').on, true, 'an online host -> node green edge')
  assert.equal(pairOf('machine:agent-off', 'node:b').on, false, 'an offline host -> node dashed red edge')
  assert.equal(pairOf('manager', 'machine:local').on, true, 'C-P1.5: manager -> local card stays green while local nodes exist')
  assert.equal(pairOf('machine:local', 'node:c').on, true, 'C-P1.5: a local node starts from the local card (live green edge)')
  assert.equal(pairOf('machine:local', 'node:e').on, false, 'C-P1.5: an offline local node gets a dashed red edge')
  assert.equal(pairOf('manager', 'node:d').on, true, 'a host outside the machine directory -> falls back to manager')
  assert.equal(pairs.length, machines.length + 1 + nodes.length, 'edge count = machines + local card + nodes')
  const withoutLocal = edgePairs(machines, nodes, false)
  assert.equal(withoutLocal.find((p) => p.to === 'machine:local'), undefined, 'no local nodes means no local edge')
  assert.equal(withoutLocal.find((p) => p.from === 'manager' && p.to === 'node:c').on, true, 'without a local card a local node falls back to manager')
})

test('UI wrap-up C: topology skeleton -- all three columns, offline machines folded', () => {
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
  assert.ok(html.includes('2 offline / revoked'), 'offline + revoked fold into the collapsed section')
  assert.ok(html.indexOf('data-topo-machine="agent-off"') < html.indexOf('data-topo-machine="agent-rev"'), 'offline machines are inside the collapsed section')
  assert.ok(html.includes('data-topo-machine="local"'), 'C-P1.5: the local card renders while local nodes exist')
  assert.ok(html.indexOf('data-topo-machine="local"') < html.indexOf('data-topo-machine="agent-abc"'), 'the local card comes first in the machine column')
  const onlyOnline = topologyHtml({ ...data, machines: [machine()] })
  assert.ok(!onlyOnline.includes('topo-fold'), 'no offline machines means no collapsed section')
  const noLocalNodes = topologyHtml({ ...data, nodes: [node({ host: 'agent-abc' })], machines: [machine()] })
  assert.ok(!noLocalNodes.includes('data-topo-machine="local"'), 'no local nodes means no local card')
})
