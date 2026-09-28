import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * Page-script runtime smoke for the v2 API-key page (three views + drawer): run keys.js as a real
 * module against a stub DOM and drive the real functions through the __DAC_TEST__ hook. This is the
 * guard added after the 2026-09-27 "Loading…" incident: only executing the module catches a wrong
 * payload shape. The v2 assertions pin the new structure: node-row list with a three-dot menu,
 * detail view with services + activity, full-width edit (PATCH), the create drawer with its result
 * step, 0 = unlimited, filter chips, and the confirmed revoke.
 */
const nodes = new Map()

const el = (id) => {
  const existing = nodes.get(id)
  if (existing !== undefined) return existing
  const node = { id, innerHTML: '', textContent: '', hidden: false, disabled: false, value: '', checked: false, options: [], listeners: {}, addEventListener: (type, fn) => { node.listeners[type] = fn }, setAttribute: () => undefined, removeAttribute: () => undefined, getAttribute: () => null }
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
  querySelectorAll: () => [
    { value: 'services:read' },
    { value: 'usage:read' },
    { value: 'conversations:write' },
  ],
}
globalThis.window = globalThis
Object.defineProperty(globalThis, 'location', { value: { search: '' }, configurable: true })
globalThis.HTMLElement = StubElement
const realSetTimeout = globalThis.setTimeout
globalThis.setTimeout = () => 0
globalThis.clearTimeout = () => undefined
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async () => undefined } }, configurable: true })
const storage = new Map()
Object.defineProperty(globalThis, 'sessionStorage', {
  value: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) },
  configurable: true,
})
const confirms = []
globalThis.confirm = (text) => { confirms.push(text); return true }

for (const id of [
  'view-list', 'view-detail', 'view-form', 'new-key', 'keys-refresh', 'keys-count', 'keys-filter', 'keys-list',
  'back-list', 'key-detail-title', 'key-detail-edit', 'key-detail-revoke', 'key-detail-body',
  'key-activity', 'key-activity-body',
  'back-detail', 'key-edit-form', 'key-edit-msg', 'key-name', 'key-services', 'key-quota', 'key-advanced',
  'key-scopes', 'key-rpm', 'key-concurrency', 'key-expires', 'key-edit-cancel', 'key-edit-save',
  'key-editor', 'key-editor-title', 'key-create-form', 'key-create-msg', 'f-key-name', 'f-key-services',
  'f-key-services-empty', 'f-key-services-link', 'f-key-quota', 'f-key-scopes', 'f-key-rpm', 'f-key-concurrency',
  'f-key-expires', 'f-key-warn', 'f-key-cancel', 'f-key-save', 'key-issued', 'key-token-value', 'key-token-copy',
  'key-probe', 'key-probe-result', 'key-handover', 'key-handover-copy', 'key-done', 'key-handover-msg',
]) el(id)

const keyFixture = {
  id: 'b4c36b603b1e', name: 'Billing service', scopes: ['services:read', 'conversations:write'],
  scopeServices: ['support'], serviceLabels: ['Support'], quotaRunsDay: 200, rateLimitRpm: 60,
  maxConcurrency: 4, expiresAt: null, revokedAt: null, lastUsedAt: Date.now() - 3_600_000,
  createdBy: 'admin', createdAt: 1_790_000_000_000, usedToday: 12, active: 1,
}
const reportKey = { ...keyFixture, id: '9f2c1ab7e2d4', name: 'Reporting', scopeServices: ['report'], serviceLabels: ['Reporting'] }

const pagePayload = {
  keys: [keyFixture, reportKey],
  publicApi: { status: 'listening', host: '127.0.0.1', port: 8081, detail: null },
  services: [{ id: 'support', label: 'Support', surfaces: ['conversations'] }, { id: 'report', label: 'Reporting', surfaces: ['tasks'] }],
  access: { baseUrl: 'http://127.0.0.1:8081/v1', quotaTimeZone: 'Asia/Shanghai', quotaResetsAt: 0 },
}

const postBodies = []
globalThis.fetch = async (url, options) => {
  const path = String(url)
  if (path.includes('/api/i18n/')) return { ok: true, json: async () => ({ locale: 'en', dict: { 'keys.detail': 'Details', 'keys.edit': 'Edit', 'keys.revoke': 'Revoke access', 'keys.recordLogs': 'Activity log', 'keys.filterAll': 'All', 'keys.overview': 'Overview', 'keys.serving': 'Services it may enter', 'keys.activity': 'Activity', 'keys.today': 'Today', 'keys.active': 'Active', 'keys.revokeConfirm': 'Revoke "{name}"?' }, locales: [] }) }
  if (path.endsWith('/api/keys') && options?.method === 'POST') {
    postBodies.push({ method: 'POST', path, body: JSON.parse(options?.body ?? '{}') })
    return { ok: true, status: 201, json: async () => ({ token: 'dac_9f2c1ab7e2d4_TESTTOKEN', key: { ...keyFixture, id: '9f2c1ab7e2d4' } }) }
  }
  if (path.endsWith('/api/keys/probe')) {
    postBodies.push({ method: 'POST', path, body: JSON.parse(options?.body ?? '{}') })
    return { ok: true, status: 200, json: async () => ({ ok: true, target: 'http://127.0.0.1:8081', steps: [{ path: 'GET /v1/health', ok: true, status: 200, detail: 'the outward door answers' }], notes: [] }) }
  }
  if (path.endsWith('/revoke')) {
    postBodies.push({ method: 'POST', path })
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  }
  if (options?.method === 'PATCH') {
    postBodies.push({ method: 'PATCH', path, body: JSON.parse(options?.body ?? '{}') })
    return { ok: true, status: 200, json: async () => ({ key: { ...keyFixture, name: JSON.parse(options?.body ?? '{}').name ?? keyFixture.name } }) }
  }
  const detailMatch = /\/api\/keys\/([0-9a-f]{12})$/.exec(path)
  if (detailMatch !== null) {
    return {
      ok: true, status: 200,
      json: async () => ({
        key: { ...keyFixture, id: detailMatch[1] },
        recentCalls: [{ at: 1_790_000_000_000, detail: 'GET /v1/usage → 200' }],
        recentRuns: [{ id: 'r1', state: 'done', trigger: 'api', startedAt: 1_790_000_000_000, endedAt: 1_790_000_001_000, summary: 'ok', costMicroUsd: 123, error: null }],
      }),
    }
  }
  if (path.endsWith('/api/keys')) return { ok: true, status: 200, json: async () => pagePayload }
  return { ok: false, status: 404, json: async () => ({ error: 'not_found' }) }
}

test('keys v2: the list renders node-style rows with the three-dot menu and the service filter narrows them', async () => {
  await import('./keys.js')
  await new Promise((resolve) => realSetTimeout(resolve, 20))
  const hook = globalThis.__DAC_KEYS_TEST__

  const list = nodes.get('keys-list')
  assert.ok(list.innerHTML.includes('Billing service'), 'rows render with the key name')
  assert.ok(list.innerHTML.includes('b4c36b603b1e'), 'the id shows in the row')
  assert.ok(list.innerHTML.includes('Details') && list.innerHTML.includes('Revoke access') && list.innerHTML.includes('Activity log'), 'the three-dot menu carries detail/edit/logs/revoke')
  assert.equal(nodes.get('keys-count').textContent, '2', 'the count sits next to All keys')

  hook.setFilter('support')
  await hook.loadList()
  await new Promise((resolve) => realSetTimeout(resolve, 20))
  assert.ok(nodes.get('keys-list').innerHTML.includes('Billing service'), 'the matching key stays')
  assert.ok(!nodes.get('keys-list').innerHTML.includes('Reporting'), 'another service\'s key is filtered out')
  hook.setFilter(null)
})

test('keys v2: clicking a key opens the full-width detail with the service list and activity', async () => {
  await import('./keys.js')
  const hook = globalThis.__DAC_KEYS_TEST__

  await hook.openKeyDetail('b4c36b603b1e')
  await new Promise((resolve) => realSetTimeout(resolve, 20))

  assert.equal(hook.view(), 'detail', 'the detail view replaces the list')
  const body = nodes.get('key-detail-body')
  assert.ok(body.innerHTML.includes('Support'), 'the service it may enter is listed at the bottom')
  assert.ok(nodes.get('key-activity-body').innerHTML.includes('GET /v1/usage → 200'), 'the activity log carries the outward calls')
  assert.ok(body.innerHTML.includes('12 / 200'), 'the quota reads X / Y')
  assert.ok(nodes.get('key-detail-title').innerHTML.includes('Billing service'), 'the title carries name and id')
})

test('keys v2: the edit view prefills and PATCHes; 0 means unlimited', async () => {
  await import('./keys.js')
  const hook = globalThis.__DAC_KEYS_TEST__

  await hook.openKeyEdit('b4c36b603b1e')
  await new Promise((resolve) => realSetTimeout(resolve, 20))
  assert.equal(hook.view(), 'form', 'editing is a full-width view')
  assert.equal(nodes.get('key-name').value, 'Billing service', 'the form is prefilled from the key')
  assert.equal(nodes.get('key-rpm').value, '60')

  nodes.get('key-name').value = 'Renamed'
  nodes.get('key-quota').value = '0'
  await hook.saveKeyEdit()
  await new Promise((resolve) => realSetTimeout(resolve, 20))

  const patch = postBodies.find((entry) => entry.method === 'PATCH')
  assert.ok(patch !== undefined, 'saving sends a PATCH')
  assert.equal(patch.body.name, 'Renamed')
  assert.equal(patch.body.quotaRunsDay, null, '0 in the field becomes unlimited on the wire')
  assert.equal(hook.view(), 'detail', 'after saving we land back on the detail')
})

test('keys v2: the drawer creates a key with the safe defaults and shows the once-only result step', async () => {
  await import('./keys.js')
  const hook = globalThis.__DAC_KEYS_TEST__

  hook.openCreateDrawer()
  assert.equal(nodes.get('key-editor').hidden, false, 'the drawer opens')
  nodes.get('f-key-name').value = 'acme'
  nodes.get('f-key-services').value = 'support'
  nodes.get('f-key-quota').value = '300'
  await hook.createKey()
  await new Promise((resolve) => realSetTimeout(resolve, 20))

  const create = postBodies.find((entry) => entry.path.endsWith('/api/keys') && entry.method === 'POST')
  assert.equal(create.body.name, 'acme')
  assert.equal(create.body.quotaRunsDay, 300)
  assert.deepEqual(create.body.scopes, ['services:read', 'usage:read', 'conversations:write'], 'the safe default scopes')
  assert.equal(nodes.get('key-issued').hidden, false, 'the result step replaces the form')
  assert.ok(nodes.get('key-token-value').textContent.includes('TESTTOKEN'), 'the plaintext is shown once here')
  assert.ok(nodes.get('key-handover').innerHTML.includes('127.0.0.1:8081'), 'the handover block is ready to copy')
})

test('keys v2: with no service configured the drawer offers only the create-service link', async () => {
  await import('./keys.js')
  const hook = globalThis.__DAC_KEYS_TEST__
  pagePayload.services = []
  pagePayload.keys = []

  await hook.loadList()
  hook.openCreateDrawer()
  assert.equal(nodes.get('f-key-services-empty').hidden, false, 'the create-a-service link shows')
  assert.equal(nodes.get('f-key-services').hidden, true, 'the empty select hides')
  assert.equal(nodes.get('f-key-services-link').hidden, true, 'the small link hides when there is nothing to pick from')

  pagePayload.services = [{ id: 'support', label: 'Support', surfaces: ['conversations'] }]
  pagePayload.keys = [keyFixture]
})

test('keys v2: revoking asks for confirmation and names the key', async () => {
  await import('./keys.js')
  await new Promise((resolve) => realSetTimeout(resolve, 20))

  const target = Object.assign(new StubElement(), { dataset: { keyRevoke: 'b4c36b603b1e', keyRevokeName: 'Billing service' } })
  await docListeners.click({ target })
  await new Promise((resolve) => realSetTimeout(resolve, 20))

  assert.equal(confirms.length, 1)
  assert.ok(confirms[0].includes('Billing service'), 'the confirmation names the key')
  assert.ok(postBodies.some((entry) => entry.path.endsWith('/revoke')), 'after confirmation the revoke fires')
})
