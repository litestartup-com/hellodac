import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify } from 'yaml'
import { loadConfig } from '../config.js'
import { applyService, deleteService, previewService, serviceEditorContext, type ServiceDraft } from './config-edit.js'

/**
 * The service declaration editor (the operator flow this exists for): preview must be able to say
 * "no" without writing, and apply must never leave a config the manager would refuse to boot.
 *
 * The fixtures go through the real `loadConfig`, so what these tests pin is the same web of rules the
 * manager enforces at boot (public members, one process per agent, one service per machine, pinned and
 * priced models, count == workers).
 */
const WS = tmpdir()

const fileFor = (extra: Record<string, unknown> = {}): string => {
  const dir = mkdtempSync(join(tmpdir(), 'dac-cfg-edit-'))
  const path = join(dir, 'manager.config.yaml')
  writeFileSync(
    path,
    stringify({
      // The version stamp matters: an unstamped file goes through the config migration on load, which
      // rewrites the file and drops comments -- the very thing the comment test below guards against.
      config_version: 1,
      listen: { host: '127.0.0.1', port: 8080 },
      endpoints: {
        'svc-1': {
          url: 'http://127.0.0.1:3201',
          driver: 'apiproxy',
          prefix: '/api-gw/v1/proxy',
          key_ref: 'GW_KEY_TEST',
          spawn: { managed: true, command: 'node', args: [], runner: 'agent', host: 'box-1' },
        },
        'in-1': { url: 'http://127.0.0.1:3090', driver: 'apiproxy', prefix: '/api-gw/v1/proxy', key_ref: 'GW_KEY_TEST' },
      },
      agents: {
        'svc-1': { name: 'Support 1', endpoint: 'svc-1', workspace: '/srv/ws', public: true, preset: 'standard', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        'in-1': { name: 'Personal', endpoint: 'in-1', workspace: WS, public: false, preset: 'standard' },
      },
      pricing: {
        models: { 'deepseek-v4-flash': { off_peak: { input: 0.22, output: 0.66 } } },
      },
      ...extra,
    }),
    'utf8',
  )
  return path
}

const previous = process.env.GW_KEY_TEST
process.env.GW_KEY_TEST = 'test-gateway-key'
process.on('exit', () => {
  if (previous === undefined) delete process.env.GW_KEY_TEST
  else process.env.GW_KEY_TEST = previous
})

const draft = (over: Partial<ServiceDraft> = {}): ServiceDraft => ({
  id: 'chat',
  label: 'Support',
  workers: ['svc-1'],
  surfaces: ['conversations'],
  permission: 'read',
  session_idle_hours: 24,
  placement: 'pin',
  machines: ['box-1'],
  max_agents_per_machine: 4,
  capacity: { max_sessions_per_agent: 4 },
  knowledge: [],
  ...over,
})

test('service editor: a valid declaration previews green, with the resolved service to show the operator', () => {
  const configPath = fileFor()
  const config = loadConfig(configPath)

  const preview = previewService({ config, configPath, draft: draft() })

  assert.equal(preview.ok, true, preview.errors.join('\n'))
  assert.equal(preview.resolved?.id, 'chat')
  assert.equal(preview.resolved?.maxSessionsPerAgent, 4)
  assert.ok(preview.yaml.includes('services:'), 'the rendered file must contain the new section')
  assert.ok(preview.diff.some((line) => line.kind === 'add' && line.text.includes('id: chat')), 'the operator sees what would be added')
  assert.equal(readFileSync(configPath, 'utf8').includes('services:'), false, 'a preview never writes')
})

test('service editor: an inward agent cannot serve a service, and the loader says so in its own words', () => {
  const configPath = fileFor()
  const config = loadConfig(configPath)

  const preview = previewService({ config, configPath, draft: draft({ workers: ['in-1'] }) })

  assert.equal(preview.ok, false)
  assert.match(preview.errors.join('\n'), /is not public/)
  assert.equal(readFileSync(configPath, 'utf8').includes('services:'), false, 'a rejected preview still writes nothing')
})

test('service editor: a declaration the loader refuses (pin without machines) comes back as a readable error', () => {
  const configPath = fileFor()
  const config = loadConfig(configPath)

  const preview = previewService({ config, configPath, draft: draft({ machines: [] }) })

  assert.equal(preview.ok, false)
  assert.match(preview.errors.join('\n'), /needs machines/)
})

test('service editor: applying writes the file, keeps the comments, and hot-swaps the in-memory config', async () => {
  const configPath = fileFor()
  // A hand-written comment is the config's own documentation; the writer must not eat it.
  writeFileSync(configPath, `# my hand-written note\n${readFileSync(configPath, 'utf8')}`, 'utf8')
  const config = loadConfig(configPath)
  const hash = serviceEditorContext({ config, configPath }).configHash

  const result = await applyService({ config, configPath, draft: draft(), expectHash: hash })

  assert.equal(result.ok, true, result.errors.join('\n'))
  assert.equal(result.changed, true)
  const onDisk = readFileSync(configPath, 'utf8')
  assert.ok(onDisk.includes('# my hand-written note'), 'comments survive the write')
  assert.ok(onDisk.includes('id: chat'))
  assert.equal(config.services?.length, 1, 'the running process sees the new service without a restart')
  assert.equal(config.services?.[0]?.id, 'chat')
  assert.ok(loadConfig(configPath).services?.some((service) => service.id === 'chat'), 'the file itself boots')
})

test('service editor: applying against a file somebody else changed is refused, not merged over', async () => {
  const configPath = fileFor()
  const config = loadConfig(configPath)
  const staleHash = serviceEditorContext({ config, configPath }).configHash
  // Another operator edits the file between preview and apply.
  writeFileSync(configPath, `${readFileSync(configPath, 'utf8')}\n# someone else was here\n`, 'utf8')

  const result = await applyService({ config, configPath, draft: draft(), expectHash: staleHash })

  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /changed on disk/)
  assert.equal(readFileSync(configPath, 'utf8').includes('id: chat'), false, 'nothing was written over their edit')
})

test('service editor: editing an existing declaration replaces it in place instead of appending a second one', async () => {
  const configPath = fileFor()
  const config = loadConfig(configPath)
  await applyService({ config, configPath, draft: draft() })

  const hash = serviceEditorContext({ config, configPath }).configHash
  const result = await applyService({
    config,
    configPath,
    draft: draft({ label: 'Customer support', capacity: { max_sessions_per_agent: 8 } }),
    expectHash: hash,
  })

  assert.equal(result.ok, true, result.errors.join('\n'))
  assert.equal(config.services?.length, 1, 'one declaration, not two')
  assert.equal(config.services?.[0]?.label, 'Customer support')
  assert.equal(config.services?.[0]?.maxSessionsPerAgent, 8)
})

test('service editor: a declaration the editor does not expose (thresholds) survives an edit, not silently dropped', async () => {
  // The production config carries a service-level threshold override; the editor has no such field,
  // so the only correct behaviour is to round-trip it unchanged. Losing it would silently change the
  // placement rules (real incident: a no-op apply on production dropped thresholds:).
  const configPath = fileFor({
    services: [
      {
        id: 'chat',
        label: 'Support',
        workers: ['svc-1'],
        count: 1,
        thresholds: { min_free_mem_bytes: 300_000_000 },
      },
    ],
  })
  const config = loadConfig(configPath)
  const hash = serviceEditorContext({ config, configPath }).configHash

  const result = await applyService({ config, configPath, draft: draft({ label: 'Support (renamed)' }), expectHash: hash })

  assert.equal(result.ok, true, result.errors.join('\n'))
  const onDisk = readFileSync(configPath, 'utf8')
  assert.ok(onDisk.includes('min_free_mem_bytes: 300000000'), 'the threshold override survives the edit')
  assert.equal(loadConfig(configPath).services?.[0]?.thresholds?.minFreeMemBytes, 300_000_000, 'and the loader still reads it')
})

test('service editor: the persona round-trips -- an unrelated edit keeps it, and clearing it in the editor clears it on disk', async () => {
  const voice = 'Be warm, brief, and never guess a price.'
  const configPath = fileFor({
    services: [{ id: 'chat', label: 'Support', workers: ['svc-1'], count: 1, persona: voice }],
  })
  const config = loadConfig(configPath)

  const ctx = serviceEditorContext({ config, configPath })
  assert.equal(ctx.services[0]?.persona, voice, 'the form is fed the declared persona')

  const hash = ctx.configHash
  const renamed = await applyService({ config, configPath, draft: draft({ label: 'Support (renamed)', persona: ctx.services[0]?.persona }), expectHash: hash })
  assert.equal(renamed.ok, true, renamed.errors.join('\n'))
  assert.equal(loadConfig(configPath).services?.[0]?.persona, voice, 'an unrelated edit does not drop the voice')

  // Clearing must clear: the persona is editor-exposed, so a draft without it means "the operator
  // emptied the field" -- never inherit it back (that would make the field un-clearable).
  const hash2 = serviceEditorContext({ config, configPath }).configHash
  const cleared = await applyService({ config, configPath, draft: draft({ persona: '   ' }), expectHash: hash2 })
  assert.equal(cleared.ok, true, cleared.errors.join('\n'))
  assert.equal(loadConfig(configPath).services?.[0]?.persona, undefined, 'whitespace-only clears the voice')
  assert.ok(!readFileSync(configPath, 'utf8').includes('persona:'), 'the field leaves the file entirely')
})

test('service editor: deleting a service removes its declaration and hot-swaps it out of memory', async () => {
  const configPath = fileFor()
  const config = loadConfig(configPath)
  await applyService({ config, configPath, draft: draft() })
  assert.equal(config.services?.length, 1)

  const removed = await deleteService({ config, configPath, id: 'chat' })

  assert.equal(removed, 'chat', 'the removed id comes back')
  assert.equal(config.services?.length, 0, 'the running process loses the service without a restart')
  assert.ok(!readFileSync(configPath, 'utf8').includes('id: chat'), 'the declaration is gone from the truth source')
  assert.equal(loadConfig(configPath).services?.length ?? 0, 0, 'and the file itself still boots')
})

test('service editor: deleting a service that does not exist is a no-op, not an error to route around', async () => {
  const configPath = fileFor()
  const config = loadConfig(configPath)

  const removed = await deleteService({ config, configPath, id: 'ghost' })

  assert.equal(removed, null)
  assert.equal(readFileSync(configPath, 'utf8').includes('services:'), false, 'nothing was written')
})

test('service editor: the context lists candidates with a reason attached, never a bare disabled row', () => {
  // Two outward agents on two machines (a machine may serve only one service), and a service already
  // holding the first one.
  const configPath = fileFor({
    endpoints: {
      'svc-1': { url: 'http://127.0.0.1:3201', driver: 'apiproxy', prefix: '/api-gw/v1/proxy', key_ref: 'GW_KEY_TEST', sandbox_base: 'http://127.0.0.1:3299/api-gw/v1', sandbox_key_ref: 'GW_KEY_TEST', spawn: { managed: true, command: 'node', args: [], runner: 'agent', host: 'box-1' } },
      'svc-2': { url: 'http://127.0.0.1:3202', driver: 'apiproxy', prefix: '/api-gw/v1/proxy', key_ref: 'GW_KEY_TEST', sandbox_base: 'http://127.0.0.1:3299/api-gw/v1', sandbox_key_ref: 'GW_KEY_TEST', spawn: { managed: true, command: 'node', args: [], runner: 'agent', host: 'box-2' } },
      'in-1': { url: 'http://127.0.0.1:3090', driver: 'apiproxy', prefix: '/api-gw/v1/proxy', key_ref: 'GW_KEY_TEST' },
    },
    agents: {
      'svc-1': { name: 'Support 1', endpoint: 'svc-1', workspace: '/srv/ws', public: true, preset: 'standard', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      'svc-2': { name: 'Support 2', endpoint: 'svc-2', workspace: '/srv/ws2', public: true, preset: 'standard', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      'in-1': { name: 'Personal', endpoint: 'in-1', workspace: WS, public: false, preset: 'standard' },
    },
    services: [{ id: 'chat', label: 'Support', workers: ['svc-1'], count: 1 }],
  })
  const config = loadConfig(configPath)

  const context = serviceEditorContext({ config, configPath })

  assert.deepEqual(context.workers.map((w) => w.id), ['svc-1', 'svc-2'], 'only public agents are candidates')
  const busy = context.workers.find((w) => w.id === 'svc-1')
  assert.equal(busy?.serviceId, 'chat')
  assert.equal(busy?.blockedReason, 'already serves chat', 'a taken agent says why it is taken')
  const free = context.workers.find((w) => w.id === 'svc-2')
  assert.equal(free?.blockedReason, null)
  assert.equal(free?.priced, true, 'the price check is on the candidate list, not discovered later')
  assert.equal(free?.machine, 'box-2')
  assert.ok(context.configHash.length > 0)
  assert.ok(context.machines.some((m) => m.id === 'box-1' && m.services.includes('chat')))
})

