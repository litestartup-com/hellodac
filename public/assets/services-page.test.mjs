import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * Page-script runtime smoke for the v2 services page (three views + drawer): run services.js as a
 * real module against a stub DOM and drive the real functions through the __DAC_TEST__ hook. The v2
 * assertions pin: the node-style list with key counts and the three-dot menu, the full-width detail
 * (agents + bound keys), the edit view with the loader-checked preview (including the write-only
 * thresholds round trip), the create drawer with the ?return=keys redirect, and the confirmed delete.
 */
const nodes = new Map()

const el = (id) => {
  const existing = nodes.get(id)
  if (existing !== undefined) return existing
  const node = { id, innerHTML: '', textContent: '', hidden: false, disabled: false, value: '', checked: false, options: [], listeners: {}, addEventListener: (type, fn) => { node.listeners[type] = fn }, setAttribute: (k, v) => { node.attrs = { ...(node.attrs ?? {}), [k]: v } }, removeAttribute: () => undefined, getAttribute: (k) => node.attrs?.[k] ?? null }
  nodes.set(id, node)
  return node
}

class StubElement {
  constructor() { this.dataset = {} }
  closest() { return null }
}

const docListeners = {}
globalThis.__DAC_TEST__ = true
globalThis.document = {
  documentElement: { lang: 'en' },
  cookie: '',
  hidden: false,
  getElementById: (id) => nodes.get(id) ?? null,
  addEventListener: (type, fn) => { docListeners[type] = fn },
  querySelectorAll: () => [],
}
globalThis.window = globalThis
Object.defineProperty(globalThis, 'location', { value: { search: '?create=1&return=keys' }, configurable: true })
globalThis.HTMLElement = StubElement
const realSetTimeout = globalThis.setTimeout
globalThis.setTimeout = () => 0
globalThis.clearTimeout = () => undefined
const confirms = []
globalThis.confirm = (text) => { confirms.push(text); return true }

for (const id of [
  'view-list', 'view-detail', 'view-form', 'new-service', 'services-refresh', 'services-count', 'services-list',
  'back-list', 'service-detail-title', 'service-detail-key', 'service-detail-edit', 'service-detail-delete', 'service-detail-body',
  'back-detail', 'edit-form-slot', 'service-editor', 'service-editor-title', 'service-editor-slot',
  'service-form', 'svc-msg', 'svc-label', 'svc-id', 'svc-agents', 'svc-capacity', 'svc-permission',
  'svc-surface-conversations', 'svc-surface-tasks', 'svc-idle', 'svc-max-agents', 'svc-placement',
  'svc-machines-wrap', 'svc-machines', 'svc-knowledge', 'svc-knowledge-add', 'svc-preview-wrap',
  'svc-preview-state', 'svc-preview-errors', 'svc-preview-warnings', 'svc-preview-diff', 'svc-preview-yaml',
  'svc-cancel', 'svc-apply',
]) el(id)

const snapshotPayload = {
  services: [
    {
      id: 'chat', label: 'Support', surfaces: ['conversations'], declaredCount: 1, permission: 'read',
      sessionIdleHours: 24, placement: 'pin', machines: ['box-1'], knowledge: [],
      agents: [{ id: 'svc-chat-1', name: 'Support 1', endpoint: 'svc-chat-1', machine: 'box-1', online: true, sessions: 2, queueDepth: 0, maxSessions: 4, provider: 'deepseek-official', model: 'deepseek-v4-flash', sandboxMode: 'read-only' }],
      capacity: { maxConcurrent: 4, onlineMaxConcurrent: 4, inUse: 2, queued: 0, onlineAgents: 1, declaredAgents: 1 },
      keys: [
        { id: 'a814ce63ac3b', name: 'Acme', usedToday: 2, quotaRunsDay: 50, active: 0, maxConcurrency: 4, revokedAt: null },
        { id: 'b4c36b603b1e', name: 'Other', usedToday: 4, quotaRunsDay: 200, active: 0, maxConcurrency: 4, revokedAt: null },
      ],
    },
  ],
  keysExist: true,
}

const contextPayload = {
  configHash: 'hash-1234',
  services: [{ id: 'chat', label: 'Support', workers: ['svc-chat-1'], surfaces: ['conversations'], permission: 'read', session_idle_hours: 24, placement: 'pin', machines: ['box-1'], max_agents_per_machine: 4, thresholds: { min_free_mem_bytes: 300_000_000 }, capacity: { max_sessions_per_agent: 4 }, knowledge: [] }],
  workers: [{ id: 'svc-chat-1', name: 'Support 1', public: true, serviceId: 'chat', endpoint: 'svc-chat-1', machine: 'box-1', provider: 'deepseek-official', model: 'deepseek-v4-flash', priced: true, blockedReason: null }],
  machines: [{ id: 'box-1', hostname: null, services: ['chat'], outwardAgents: 1 }],
}

const calls = { previewBodies: [], applyBodies: [], deletes: [] }
globalThis.fetch = async (url, options) => {
  const path = String(url)
  if (path.includes('/api/i18n/')) return { ok: true, json: async () => ({ locale: 'en', dict: { 'services.detail': 'Details', 'services.edit': 'Edit', 'services.delete': 'Delete service', 'services.deleteConfirm': 'Delete "{label}"?', 'services.form.applied': 'Saved', 'services.keysShort': 'keys', 'services.agentsOnline': 'agents online', 'services.inUse': 'conversations in use', 'services.queued': 'queued', 'services.issueKey': 'Issue a key' }, locales: [] }) }
  if (path.endsWith('/api/services')) return { ok: true, status: 200, json: async () => snapshotPayload }
  if (path.endsWith('/api/config/services/preview')) {
    calls.previewBodies.push(JSON.parse(options?.body ?? '{}'))
    return { ok: true, status: 200, json: async () => ({ ok: true, yaml: 'services:\n  - id: chat', diff: [{ kind: 'add', text: 'id: chat' }], errors: [], warnings: [], resolved: { id: 'chat' } }) }
  }
  if (path.endsWith('/api/config/services') && options?.method === 'POST') {
    calls.applyBodies.push(JSON.parse(options?.body ?? '{}'))
    return { ok: true, status: 200, json: async () => ({ ok: true, resolved: { id: 'chat' }, warnings: [], changed: true, restartRequired: false }) }
  }
  if (path.endsWith('/api/config/services/chat') && options?.method === 'DELETE') {
    calls.deletes.push('chat')
    return { ok: true, status: 200, json: async () => ({ ok: true, removed: 'chat' }) }
  }
  if (path.endsWith('/api/config/services')) return { ok: true, status: 200, json: async () => contextPayload }
  return { ok: false, status: 404, json: async () => ({ error: 'not_found' }) }
}

test('services v2: the list renders node-style rows with the key count and the three-dot menu', async () => {
  await import('./services.js')
  await new Promise((resolve) => realSetTimeout(resolve, 20))

  const list = nodes.get('services-list')
  assert.ok(list.innerHTML.includes('Support'), 'the service renders')
  assert.ok(list.innerHTML.includes('2 keys'), 'the row shows how many keys it serves')
  assert.ok(list.innerHTML.includes('1/1 agents online'), 'the capacity line is on the row')
  assert.ok(list.innerHTML.includes('Details') && list.innerHTML.includes('Delete service'), 'the three-dot menu carries detail/edit/key/delete')
  assert.equal(nodes.get('services-count').textContent, '1', 'the count sits next to All services')
})

test('services v2: the detail view shows the overview, its agents and the keys it serves', async () => {
  await import('./services.js')
  await new Promise((resolve) => realSetTimeout(resolve, 20))
  const hook = globalThis.__DAC_SERVICES_TEST__

  hook.openDetail('chat')
  assert.equal(hook.view(), 'detail')
  const body = nodes.get('service-detail-body')
  assert.ok(body.innerHTML.includes('Support 1'), 'the agents render')
  assert.ok(body.innerHTML.includes('Acme'), 'the serving keys render')
  assert.ok(body.innerHTML.includes('2/4'), 'capacity in use is spelled out')
  assert.equal(nodes.get('service-detail-key').getAttribute('href'), '/keys?service=chat', 'issue-a-key preselects this service')
})

test('services v2: editing an existing declaration keeps the thresholds the form does not expose', async () => {
  await import('./services.js')
  const hook = globalThis.__DAC_SERVICES_TEST__

  hook.openEdit('chat')
  assert.equal(hook.view(), 'form', 'editing is a full-width view')
  hook.setDraft({ label: 'Support (renamed)' })
  await hook.runPreview()
  await new Promise((resolve) => realSetTimeout(resolve, 20))

  const sent = calls.previewBodies.at(-1)
  assert.equal(sent.label, 'Support (renamed)')
  assert.deepEqual(sent.thresholds, { min_free_mem_bytes: 300_000_000 }, 'the write-only thresholds round-trip through the edit')
  assert.equal(sent.max_agents_per_machine, 4, 'the per-machine cap rides along')
})

test('services v2: the create drawer applies the declaration and redirects back to the key page', async () => {
  await import('./services.js')
  await new Promise((resolve) => realSetTimeout(resolve, 20))
  const hook = globalThis.__DAC_SERVICES_TEST__

  assert.equal(nodes.get('service-editor').hidden, false, '?create=1 opens the drawer by itself')
  hook.setDraft({ id: 'chat', label: 'Support', workers: ['svc-chat-1'], placement: 'pin', machines: ['box-1'] })
  await hook.apply()
  await new Promise((resolve) => realSetTimeout(resolve, 20))

  const sent = calls.applyBodies.at(-1)
  assert.equal(sent.configHash, 'hash-1234', 'apply carries the file hash (stale-edit guard)')
  assert.equal(hook.lastRedirect(), '/keys?service=chat', 'the round trip ends on the key page with the new service preselected')
})

test('services v2: deleting asks for confirmation and removes the declaration', async () => {
  await import('./services.js')
  const hook = globalThis.__DAC_SERVICES_TEST__

  await hook.deleteService('chat', 'Support')
  await new Promise((resolve) => realSetTimeout(resolve, 20))

  assert.equal(confirms.length, 1, 'deletion must be confirmed')
  assert.ok(confirms[0].includes('Support'), 'the confirmation names the service')
  assert.deepEqual(calls.deletes, ['chat'], 'the DELETE fired')
})
