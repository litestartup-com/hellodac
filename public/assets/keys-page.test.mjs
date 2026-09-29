import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * Page-script runtime smoke for the v2 API-key page (three views + drawer): run keys.js as a real
 * module against a stub DOM and drive the real functions through the __DAC_TEST__ hook. This is the
 * guard added after the 2026-09-27 "Loading…" incident: only executing the module catches a wrong
 * payload shape. The v2.1 assertions pin the fixes too: the shared form (drawer + edit), no row-click
 * navigation (the menu is the only way in), the detail icon links, 0 = unlimited, and the confirm.
 */
const nodes = new Map()

const el = (id) => {
  const existing = nodes.get(id)
  if (existing !== undefined) return existing
  const node = { id, innerHTML: '', textContent: '', hidden: false, disabled: false, value: '', checked: false, options: [], listeners: {}, attrs: {}, addEventListener: (type, fn) => { node.listeners[type] = fn }, setAttribute: (k, v) => { node.attrs[k] = v }, removeAttribute: () => undefined, getAttribute: (k) => node.attrs[k] ?? null }
  nodes.set(id, node)
  return node
}

class StubElement {
  constructor() { this.dataset = {} }
  // The production handlers resolve actions via closest('[data-...]'); mirror that: a selector
  // naming one of this stub's dataset keys matches itself.
  closest(selector) {
    const match = /^\[data-([a-zA-Z-]+)\]$/.exec(selector)
    if (match === null) return null
    const key = match[1].replace(/-([a-z])/g, (_all, letter) => letter.toUpperCase())
    return this.dataset[key] !== undefined ? this : null
  }
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
globalThis.Element = StubElement
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
  'key-activity', 'key-activity-body', 'back-detail', 'edit-form-slot',
  'key-editor', 'key-editor-title', 'key-form-slot',
  'key-form', 'kf-msg', 'kf-name', 'kf-services', 'kf-services-empty', 'kf-services-link', 'kf-quota',
  'kf-scopes', 'kf-rpm', 'kf-concurrency', 'kf-expires', 'kf-cancel', 'kf-save',
  'key-issued', 'key-token-value', 'key-token-copy', 'key-probe', 'key-probe-result',
  'key-handover', 'key-handover-copy', 'key-done', 'key-handover-msg',
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
  if (path.includes('/api/i18n/')) return { ok: true, json: async () => ({ locale: 'en', dict: { 'keys.detail': 'Details', 'keys.edit': 'Edit', 'keys.revoke': 'Revoke access', 'keys.recordLogs': 'Activity log', 'keys.filterAll': 'All', 'keys.overview': 'Overview', 'keys.serving': 'Services', 'keys.activity': 'Activity', 'keys.today': 'Today', 'keys.active': 'Active', 'keys.revokeConfirm': 'Revoke "{name}"?', 'keys.newServiceLink': 'New service' }, locales: [] }) }
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
    const patched = { ...keyFixture, name: JSON.parse(options?.body ?? '{}').name ?? keyFixture.name }
    return { ok: true, status: 200, json: async () => ({ key: patched }) }
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
  assert.ok(list.innerHTML.includes('Details') && list.innerHTML.includes('Revoke access') && list.innerHTML.includes('Activity log'), 'the three-dot menu carries detail/edit/logs/revoke')
  assert.equal(nodes.get('keys-count').textContent, '2', 'the count sits next to All keys')

  hook.setFilter('support')
  await hook.loadList()
  await new Promise((resolve) => realSetTimeout(resolve, 20))
  assert.ok(nodes.get('keys-list').innerHTML.includes('Billing service'), 'the matching key stays')
  assert.ok(!nodes.get('keys-list').innerHTML.includes('Reporting'), 'another service\'s key is filtered out')
  hook.setFilter(null)
})

test('keys v2: the detail view renders the overview, the services (with icon links, not row jumps) and the activity', async () => {
  await import('./keys.js')
  const hook = globalThis.__DAC_KEYS_TEST__

  await hook.openKeyDetail('b4c36b603b1e')
  await new Promise((resolve) => realSetTimeout(resolve, 20))

  assert.equal(hook.view(), 'detail', 'the detail view replaces the list')
  const body = nodes.get('key-detail-body')
  assert.ok(body.innerHTML.includes('Support'), 'the service it may enter is listed')
  assert.ok(body.innerHTML.includes('/services?service=support'), 'the service row ends in an explicit detail link')
  assert.ok(nodes.get('key-activity-body').innerHTML.includes('GET /v1/usage → 200'), 'the activity log carries the outward calls')
  assert.ok(nodes.get('key-detail-title').innerHTML.includes('Billing service'), 'the title carries name and id')
})

test('keys v2: the edit view prefills and PATCHes; 0 means unlimited', async () => {
  await import('./keys.js')
  const hook = globalThis.__DAC_KEYS_TEST__

  await hook.openKeyEdit('b4c36b603b1e')
  await new Promise((resolve) => realSetTimeout(resolve, 20))
  assert.equal(hook.view(), 'form', 'editing is a full-width view')
  assert.equal(nodes.get('kf-name').value, 'Billing service', 'the form is prefilled from the key')
  assert.equal(nodes.get('kf-rpm').value, '60')

  nodes.get('kf-name').value = 'Renamed'
  nodes.get('kf-quota').value = '0'
  await hook.submitForm()
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
  nodes.get('kf-name').value = 'acme'
  nodes.get('kf-services').value = 'support'
  nodes.get('kf-quota').value = '300'
  await hook.submitForm()
  await new Promise((resolve) => realSetTimeout(resolve, 20))

  const create = postBodies.find((entry) => entry.path.endsWith('/api/keys') && entry.method === 'POST')
  assert.equal(create.body.name, 'acme')
  assert.equal(create.body.quotaRunsDay, 300)
  assert.deepEqual(create.body.scopes, ['services:read', 'usage:read', 'conversations:write'], 'the safe default scopes')
  assert.equal(nodes.get('key-issued').hidden, false, 'the result step replaces the form')
  assert.ok(nodes.get('key-token-value').textContent.includes('TESTTOKEN'), 'the plaintext is shown once here')
})

test('keys v2: with no service configured the drawer offers only the create-service link', async () => {
  await import('./keys.js')
  const hook = globalThis.__DAC_KEYS_TEST__
  pagePayload.services = []
  pagePayload.keys = []

  await hook.loadList()
  hook.openCreateDrawer()
  assert.equal(nodes.get('kf-services-empty').hidden, false, 'the create-a-service link shows')
  assert.equal(nodes.get('kf-services').hidden, true, 'the empty select hides')
  assert.equal(nodes.get('kf-services-link').hidden, true, 'the small link hides when there is nothing to pick from')

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
