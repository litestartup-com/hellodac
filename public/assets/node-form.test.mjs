import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nodeCreatePayload, hostRunnerConfirmText, dangerSandboxConfirmText, versionOptionsHtml } from './node-form.js'

import { useTestDictionary } from './test-i18n.mjs'

useTestDictionary('en')

test('Capability one regression: runner=auto omits the field (the backend decides from the deployment), only an explicit choice is sent', () => {
  const base = { name: 'worker', port: '3083', dshVersion: '', agent: { preset: 'standard', sandboxMode: 'workspace-write' } }
  assert.deepEqual(nodeCreatePayload({ ...base, runner: 'auto' }), {
    name: 'worker', port: 3083, agent: { preset: 'standard', sandboxMode: 'workspace-write' },
  }, 'auto = runner is not sent; an empty version = follow the default, not sent')
  assert.deepEqual(nodeCreatePayload({ ...base, runner: 'process' }), {
    name: 'worker', port: 3083, runner: 'process', agent: { preset: 'standard', sandboxMode: 'workspace-write' },
  }, 'an explicit process is sent')
  assert.deepEqual(nodeCreatePayload({ ...base, runner: 'docker' }), {
    name: 'worker', port: 3083, runner: 'docker', agent: { preset: 'standard', sandboxMode: 'workspace-write' },
  }, 'an explicit docker is sent')
})

test('Capability four M1-7 regression: a chosen host = host+url sent together; without one they stay absent', () => {
  const base = { name: 'ops01', port: '', runner: 'auto', dshVersion: '', agent: { preset: 'standard', sandboxMode: 'workspace-write' } }
  assert.deepEqual(nodeCreatePayload({ ...base, host: 'agent-abc123', url: 'http://10.0.0.7:3081' }), {
    name: 'ops01', host: 'agent-abc123', url: 'http://10.0.0.7:3081', agent: { preset: 'standard', sandboxMode: 'workspace-write' },
  }, 'an agent remote node = host + url are sent')
  assert.deepEqual(nodeCreatePayload({ ...base, host: '', url: '' }), {
    name: 'ops01', agent: { preset: 'standard', sandboxMode: 'workspace-write' },
  }, 'no host chosen -> nothing is sent')
})

test('Capability two regression: picking a version in the wizard -> dsh_version enters the payload; the default field stays absent', () => {
  const base = { name: 'v15', port: '', runner: 'auto', agent: { preset: 'standard', sandboxMode: 'workspace-write' } }
  assert.deepEqual(nodeCreatePayload({ ...base, dshVersion: '0.1.5-rc.2' }), {
    name: 'v15', dsh_version: '0.1.5-rc.2', agent: { preset: 'standard', sandboxMode: 'workspace-write' },
  }, 'a selected version sends dsh_version; an empty port is omitted')
  assert.deepEqual(nodeCreatePayload({ ...base, dshVersion: '' }), {
    name: 'v15', agent: { preset: 'standard', sandboxMode: 'workspace-write' },
  }, 'an empty string = follow the first matrix row')
  assert.deepEqual(nodeCreatePayload(base), {
    name: 'v15', agent: { preset: 'standard', sandboxMode: 'workspace-write' },
  }, 'the default field does not appear as dsh_version')
})

test('Capability one regression: the host-process confirmation text carries the whole-machine risk warning', () => {
  const text = hostRunnerConfirmText('ops-agent')
  assert.match(text, /host process/)
  assert.match(text, /whole machine/)
  assert.match(text, /ops-agent/)
})

test('Fleet M3-1 regression: the third ops sandbox tier enters the payload + its own yellow-text confirmation (approval card / credential wording)', () => {
  const payload = nodeCreatePayload({
    name: 'ops01', port: '', runner: 'auto', dshVersion: '',
    host: 'agent-abc123', url: 'http://10.0.0.7:3081',
    agent: { preset: 'standard', sandboxMode: 'danger-full-access' },
  })
  assert.equal(payload.agent.sandboxMode, 'danger-full-access', 'the third sandbox tier is sent as-is (the backend schema already allows it)')
  const text = dangerSandboxConfirmText('ops01')
  assert.match(text, /full-access/)
  assert.match(text, /approval card/)
  assert.match(text, /never receives them/)
})

test('P2 regression: versionOptionsHtml -- follow-the-default / current pinned selection / pending label', () => {
  const list = [
    { dsh: '0.1.2-rc.1', status: 'verified' },
    { dsh: '0.1.5-rc.2', status: 'pending' },
  ]
  const dflt = versionOptionsHtml(list, null)
  assert.ok(dflt.includes('<option value="" selected>Follow the default</option>'), 'not pinned = follow the default is selected')
  assert.ok(dflt.includes('0.1.2-rc.1') && dflt.includes('0.1.5-rc.2'), 'every matrix row is listed')
  assert.ok(dflt.includes('(unverified)'), 'a pending pair carries the label')

  const pinned = versionOptionsHtml(list, '0.1.5-rc.2')
  assert.ok(pinned.includes('value="0.1.5-rc.2" selected'), 'the currently pinned version is selected')
  assert.ok(!pinned.includes('<option value="" selected>'), 'once pinned, follow-the-default is not selected')

  assert.equal(versionOptionsHtml(undefined, null), '<option value="" selected>Follow the default</option>', 'a missing data source does not blow up')
})
