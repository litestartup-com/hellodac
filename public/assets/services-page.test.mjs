import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * Page-script runtime smoke for the outward-service page: run services.js as a real module against a
 * stub DOM and drive the real functions (open editor -> preview -> apply) through the test hook the
 * module exposes only under `__DAC_TEST__`.
 *
 * The point is the same one keys-page.test.mjs was written for after the 2026-09-27 incident: every
 * asset answers 200 and the API answers 200, yet the page sits at "Loading…" because the script used
 * the wrong shape. `node --check` and a liveness probe cannot see that; only executing the module can.
 * Driving the real functions (not string-matching the DOM) is what catches a wrong payload shape
 * before it reaches production.
 *
 * The 2026-09-28 "key-first" additions under test here: `?create=1` opens the editor by itself
 * (the keys page's "create a service first" lands here), applying with `?return=keys` redirects back
 * with the new service preselected, and every card carries an "issue a key" action.
 */
const nodes = new Map()

const el = (id) => {
  const existing = nodes.get(id)
  if (existing !== undefined) return existing
  const node = { id, innerHTML: '', textContent: '', hidden: false, disabled: false, value: '', checked: false, options: [], listeners: {}, addEventListener: (type, fn) => { node.listeners[type] = fn } }
  nodes.set(id, node)
  return node
}

globalThis.__DAC_TEST__ = true
globalThis.document = {
  documentElement: { lang: 'en' },
  cookie: '',
  getElementById: (id) => nodes.get(id) ?? null,
  addEventListener: () => undefined,
}
globalThis.window = globalThis
Object.defineProperty(globalThis, 'location', { value: { search: '?create=1&return=keys' }, configurable: true })
globalThis.HTMLElement = class {}
const realSetTimeout = globalThis.setTimeout
globalThis.setTimeout = () => 0
globalThis.clearTimeout = () => undefined

// Every id in services.html -- the script must never hit a missing node.
for (const id of [
  'service-new', 'services-refresh', 'services-note', 'editor', 'editor-title', 'service-form',
  'svc-label', 'svc-id', 'svc-surface-conversations', 'svc-surface-tasks', 'svc-agents', 'svc-agents-note',
  'svc-capacity', 'svc-idle', 'svc-max-agents', 'svc-permission', 'svc-placement', 'svc-machines-wrap', 'svc-machines',
  'svc-knowledge', 'svc-knowledge-add', 'svc-preview-wrap', 'svc-preview-state', 'svc-preview-errors',
  'svc-preview-warnings', 'svc-preview-diff', 'svc-preview-yaml', 'svc-apply', 'svc-cancel', 'svc-msg',
  'services-list',
]) el(id)

// The real page starts with these hidden (the HTML carries the attribute); the stub must model that,
// or the auto-open guard reads "already open" and never opens.
el('editor').hidden = true
el('svc-machines-wrap').hidden = true
el('svc-preview-wrap').hidden = true

const snapshotPayload = {
  services: [
    {
      id: 'chat', label: 'Support', surfaces: ['conversations'], declaredCount: 1, permission: 'read',
      sessionIdleHours: 24, placement: 'pin', machines: ['box-1'], knowledge: [],
      agents: [{ id: 'svc-chat-1', name: 'Support 1', endpoint: 'svc-chat-1', machine: 'box-1', online: true, sessions: 2, queueDepth: 0, maxSessions: 4, provider: 'deepseek-official', model: 'deepseek-v4-flash', sandboxMode: 'read-only' }],
      capacity: { maxConcurrent: 4, onlineMaxConcurrent: 4, inUse: 2, queued: 0, onlineAgents: 1, declaredAgents: 1 },
      keys: [{ id: 'a814ce63ac3b', name: 'Acme', usedToday: 2, quotaRunsDay: 50, active: 0, maxConcurrency: 4, revokedAt: null }],
    },
  ],
  keysExist: true,
}

const contextPayload = {
  configHash: 'hash-1234',
  services: [{ id: 'chat', label: 'Support', workers: ['svc-chat-1'], surfaces: ['conversations'], permission: 'read', session_idle_hours: 24, placement: 'pin', machines: ['box-1'], max_agents_per_machine: 4, capacity: { max_sessions_per_agent: 4 }, knowledge: [] }],
  workers: [{ id: 'svc-chat-1', name: 'Support 1', public: true, serviceId: 'chat', endpoint: 'svc-chat-1', machine: 'box-1', provider: 'deepseek-official', model: 'deepseek-v4-flash', priced: true, blockedReason: null }],
  machines: [{ id: 'box-1', hostname: null, services: ['chat'], outwardAgents: 1 }],
}

const calls = { previewBodies: [], applyBodies: [] }
const previewResponse = { ok: true, yaml: 'services:\n  - id: chat\n    label: Support', diff: [{ kind: 'add', text: 'id: chat' }], errors: [], warnings: [], resolved: { id: 'chat' } }

globalThis.fetch = async (url, options) => {
  const path = String(url)
  if (path.includes('/api/i18n/')) return { ok: true, json: async () => ({ locale: 'en', dict: {}, locales: [] }) }
  if (path.endsWith('/api/services') && (options?.method ?? 'GET') === 'GET') return { ok: true, status: 200, json: async () => snapshotPayload }
  if (path.endsWith('/api/config/services/preview')) {
    calls.previewBodies.push(JSON.parse(options?.body ?? '{}'))
    return { ok: true, status: 200, json: async () => previewResponse }
  }
  if (path.endsWith('/api/config/services') && options?.method === 'POST') {
    calls.applyBodies.push(JSON.parse(options?.body ?? '{}'))
    return { ok: true, status: 200, json: async () => ({ ok: true, resolved: { id: 'chat' }, warnings: [], changed: true, restartRequired: false }) }
  }
  if (path.endsWith('/api/config/services')) return { ok: true, status: 200, json: async () => contextPayload }
  return { ok: false, status: 404, json: async () => ({ error: 'not_found' }) }
}

test('services page: ?create=1 opens the editor by itself, the snapshot renders, and the preview sends exactly the draft', async () => {
  await import('./services.js')
  await new Promise((resolve) => realSetTimeout(resolve, 20))
  const hook = globalThis.__DAC_SERVICES_TEST__

  assert.equal(nodes.get('editor').hidden, false, 'the keys page round trip opens the editor without a click')

  const list = nodes.get('services-list')
  assert.ok(list !== undefined && list.innerHTML.includes('Support'), 'the running service renders')
  assert.ok(list.innerHTML.includes('/keys?service=chat'), 'every card carries the "issue a key" action')

  hook.setDraft({ id: 'chat', label: 'Support', workers: ['svc-chat-1'], placement: 'pin', machines: ['box-1'], capacity: 8, sessionIdleHours: 12, maxAgentsPerMachine: 2 })
  await hook.runPreview()
  await new Promise((resolve) => realSetTimeout(resolve, 20))

  const sent = calls.previewBodies.at(-1)
  assert.deepEqual(sent, {
    id: 'chat', label: 'Support', workers: ['svc-chat-1'], surfaces: ['conversations'], permission: 'read',
    session_idle_hours: 12, placement: 'pin', machines: ['box-1'],
    max_agents_per_machine: 2,
    capacity: { max_sessions_per_agent: 8 }, knowledge: [],
  }, 'the preview carries the form draft in the file spelling (snake_case), including the per-machine cap')

  assert.equal(nodes.get('svc-preview-wrap').hidden, false, 'a filled form reveals the preview')
  assert.ok(nodes.get('svc-preview-yaml').textContent.includes('id: chat'), 'the exact YAML to be written is shown')
})

test('services page: applying with ?return=keys redirects back with the new service preselected', async () => {
  await import('./services.js')
  await new Promise((resolve) => realSetTimeout(resolve, 20))
  const hook = globalThis.__DAC_SERVICES_TEST__

  hook.openEditor()
  hook.setDraft({ id: 'chat', label: 'Support', workers: ['svc-chat-1'], placement: 'pin', machines: ['box-1'] })
  await hook.apply()
  await new Promise((resolve) => realSetTimeout(resolve, 20))

  const sent = calls.applyBodies.at(-1)
  assert.equal(sent?.configHash, 'hash-1234', 'apply carries the hash of the file the operator was looking at (stale-edit guard)')
  assert.equal(sent?.draft.max_agents_per_machine, 4, 'the default per-machine cap rides along explicitly')
  assert.equal(hook.lastRedirect(), '/keys?service=chat', 'the round trip ends back on the key page with the new service selected')
  assert.equal(nodes.get('editor').hidden, true, 'a successful apply closes the editor')
  assert.ok(nodes.get('svc-msg').textContent.includes('applied'), 'the operator is told the change is live without a restart')
})
