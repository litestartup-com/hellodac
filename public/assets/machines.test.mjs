import { test } from 'node:test'
import assert from 'node:assert/strict'
import { useTestDictionary } from './test-i18n.mjs'

// Inject the dictionary before loading the module under test (its top level awaits loadI18n).
useTestDictionary('en')

const { machineRowHtml, joinCommand, localMachineRowHtml } = await import('./machines.js')

test('UI wrap-up C-P1.5: the local row -- direct label / platform info / no agent-only actions', () => {
  const html = localMachineRowHtml({ hostname: 'WIN-PC', os: 'win32', arch: 'x64', nodeVersion: '22.23.2', containerForm: false, nodeCount: 3 })
  assert.ok(html.includes('This host (manager)'), 'the row opens by marking the local identity')
  assert.ok(html.includes('direct'), 'the direct pill')
  assert.ok(html.includes('Windows/x64'), 'platform name mapping + arch')
  assert.ok(html.includes('node 22.23.2'))
  assert.ok(html.includes('WIN-PC'))
  assert.ok(html.includes('3'), 'the number of directly managed nodes')
  assert.ok(html.includes('no node-agent'), 'marks that it does not go through an agent')
  assert.ok(!html.includes('data-agent-revoke'), 'the local row renders no revoke button')
  assert.ok(!html.includes('data-agent-rotate'), 'the local row renders no rotate-key button')
  assert.ok(!html.includes('data-agent-delete'), 'the local row renders no delete button')
  assert.ok(!html.includes('update available'), 'the local row has no update-pending badge')
  assert.ok(!html.includes('CPU'), 'the local row has no metric badge')
  const docker = localMachineRowHtml({ hostname: 'srv', os: 'linux', arch: 'arm64', nodeVersion: '22.23.2', containerForm: true, nodeCount: 1 })
  assert.ok(docker.includes('container node'), 'marks the container deployment form')
})

test('Capability four M1-7: the machine row -- online / offline / revoked / pending commands all render', () => {
  const base = { id: 'agent-abc123', hostname: 'srv-b', os: 'linux', arch: 'amd64', nodeVersion: '22.23.2', joinedAt: Date.now(), online: true, revoked: false, pendingCommands: 0 }
  assert.ok(machineRowHtml(base).includes('dot ok'), 'the green dot when online')
  assert.ok(machineRowHtml(base).includes('srv-b'))
  assert.ok(machineRowHtml({ ...base, online: false }).includes('dot err'), 'the red dot when offline')
  assert.ok(machineRowHtml({ ...base, online: false }).includes('offline'))
  assert.ok(machineRowHtml({ ...base, revoked: true }).includes('revoked'), 'the revoked wording')
  assert.ok(!machineRowHtml({ ...base, revoked: true }).includes('data-agent-revoke'), 'a revoked machine shows no revoke button')
  assert.ok(machineRowHtml({ ...base, pendingCommands: 3 }).includes('3 commands queued'))
  assert.ok(machineRowHtml(base).includes('data-agent-revoke="agent-abc123"'))
  assert.ok(machineRowHtml(base).includes('data-agent-rotate="agent-abc123"'), 'M4-1: a non-revoked machine shows the rotate-key button')
  assert.ok(!machineRowHtml({ ...base, revoked: true }).includes('data-agent-rotate'), 'a revoked machine shows no rotate button')
  assert.ok(machineRowHtml({ ...base, revoked: true }).includes('data-agent-delete="agent-abc123"'), 'UI wrap-up B: a revoked machine shows the delete-record button')
  assert.ok(!machineRowHtml(base).includes('data-agent-delete'), 'a non-revoked machine shows no delete button')
  // M4-3: the version negotiation badge
  assert.ok(machineRowHtml({ ...base, agentVersion: '1.0.0', managerVersion: '1.1.2' }).includes('update available'), 'an older version shows the update-pending badge')
  assert.ok(!machineRowHtml({ ...base, agentVersion: '1.1.2', managerVersion: '1.1.2' }).includes('update available'), 'the same version carries no badge')
  assert.ok(!machineRowHtml({ ...base, agentVersion: null, managerVersion: '1.1.2' }).includes('update available'), 'an old agent that reports no version is not a false positive')
  // M4-4: the latest metric snapshot
  const withMetrics = machineRowHtml({ ...base, latestMetric: { cpuPercent: 125, memTotal: 16_000_000_000, memUsed: 8_000_000_000, diskTotal: 500_000_000_000, diskFree: 200_000_000_000, uptime: 3600 } })
  assert.ok(withMetrics.includes('CPU 12.5%'), 'the CPU snapshot (percent stored x10)')
  assert.ok(withMetrics.includes('memory 50%'), 'the memory share')
  assert.ok(withMetrics.includes('disk 60%'), 'the disk share')
  assert.ok(!machineRowHtml(base).includes('CPU'), 'no metrics -> nothing is rendered')
})

test('Capability four M1-7: the join command -- origin and token injected, join.sh served from the static surface', () => {
  const cmd = joinCommand('https://app.example.com', 'dac-join-xyz')
  assert.ok(cmd.includes('https://app.example.com/assets/agent/join.sh'), 'join.sh goes through the manager static surface')
  assert.ok(cmd.includes('MANAGER_URL=https://app.example.com'), 'MANAGER_URL is injected')
  assert.ok(cmd.includes('AGENT_JOIN_TOKEN=dac-join-xyz'), 'the one-time token is injected')
  assert.ok(cmd.includes('| sudo '), 'the pipe hands off to sudo')
  assert.ok(cmd.trimEnd().endsWith(' bash'), 'bash reads the script from stdin')
})

/**
 * Incident regression (2026-09-25, measured on a brand-new Ubuntu 20.04):
 *
 * (1) It must be privileged -- join.sh installs a systemd **system** unit, and a non-root run is explicitly rejected.
 * (2) **The assignment must sit to the right of sudo**. A FOO in `FOO=bar sudo bash` is dropped by sudo's
 *     `Defaults env_reset` and the script exits on the spot with "MANAGER_URL is required" -- that is why the
 *     one-line command fails at its first step on a clean machine. Measured: `sudo FOO=bar bash` is the form
 *     that holds (the assignment as sudo's command argument); `sudo -E` depends on the caller's sudoers.
 */
test('Incident regression: the join command env assignment must sit to the right of sudo, or env_reset drops it', () => {
  const cmd = joinCommand('https://app.example.com', 'dac-join-xyz')
  const afterPipe = cmd.slice(cmd.indexOf('|') + 1).trim()
  assert.match(
    afterPipe,
    /^sudo MANAGER_URL=\S+ AGENT_JOIN_TOKEN=\S+ bash$/,
    'the right of the pipe, in order: sudo / the two assignments / bash',
  )
  assert.ok(!/^MANAGER_URL=/.test(afterPipe), 'the env prefix must never appear left of sudo (env_reset clears it)')
  assert.ok(!cmd.includes('sudo -E'), 'no reliance on -E: it depends on whether sudoers allows it for the caller')
  assert.ok(!cmd.includes('sudo curl'), 'sudo must not land on curl')
})
