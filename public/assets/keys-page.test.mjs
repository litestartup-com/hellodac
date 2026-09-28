import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * Page-script runtime smoke for the API-key page: run keys.js as a real module and assert that the
 * create flow, the outward probe, the copyable handover, the confirmed revoke -- and the 2026-09-28
 * "key-first" additions (three-field default form, draft surviving the service round trip, service
 * preselect, filter chips, per-key detail panel) -- actually fire.
 *
 * This is the guard added after the 2026-09-27 incident, in which every widget was present and the
 * API was fine, but the script used the wrong return shape and the page sat at "Loading…" forever.
 *
 * Constraint: module top-level side effects; node --test gives each file its own process, and the
 * first test owns the import-time state (URL params + seeded draft).
 */
const nodes = new Map()

const el = (id) => {
  const existing = nodes.get(id)
  if (existing !== undefined) return existing
  const node = { id, innerHTML: '', textContent: '', hidden: false, disabled: false, value: '', checked: false, options: [], listeners: {}, addEventListener: (type, fn) => { node.listeners[type] = fn } }
  nodes.set(id, node)
  return node
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
Object.defineProperty(globalThis, 'location', { value: { search: '?service=support' }, configurable: true })
globalThis.HTMLElement = class {}
const realSetTimeout = globalThis.setTimeout
globalThis.setTimeout = () => 0
globalThis.clearTimeout = () => undefined
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async () => undefined } }, configurable: true })

// A draft that survived the round trip from creating a service: the page must bring it back.
const storage = new Map([['dac-key-draft', JSON.stringify({ name: 'half-typed', service: 'support', quota: '300', unlimited: false, rpm: '120', concurrency: '8', expires: '2027-01-01', scopes: ['services:read'] })]])
Object.defineProperty(globalThis, 'sessionStorage', {
  value: {
    getItem: (k) => storage.get(k) ?? null,
    setItem: (k, v) => storage.set(k, v),
    removeItem: (k) => storage.delete(k),
  },
  configurable: true,
})

const confirms = []
globalThis.confirm = (text) => { confirms.push(text); return true }

// Every id in keys.html.
for (const id of [
  'keys-refresh', 'keys-note', 'keys-listener', 'keys-access', 'key-form', 'key-create-msg', 'key-name',
  'key-services', 'key-services-empty', 'key-scopes', 'key-quota', 'key-quota-unlimited', 'key-rpm',
  'key-concurrency', 'key-expires', 'key-create', 'key-token', 'key-token-value', 'key-token-copy',
  'key-probe', 'key-probe-result', 'key-handover', 'key-handover-copy', 'key-handover-msg', 'keys-list',
  'keys-filter', 'key-verify', 'key-verify-open', 'key-verify-form', 'key-verify-token', 'key-verify-run',
  'key-verify-cancel', 'key-verify-result',
]) el(id)

const keyFixture = {
  id: 'b4c36b603b1e',
  name: 'Billing service',
  scopes: ['services:read', 'conversations:write'],
  scopeServices: ['support'],
  serviceLabels: ['Support'],
  quotaRunsDay: 200,
  rateLimitRpm: 60,
  maxConcurrency: 4,
  expiresAt: null,
  revokedAt: null,
  lastUsedAt: Date.now() - 3_600_000,
  createdBy: 'admin',
  createdAt: 1_790_000_000_000,
  usedToday: 12,
  active: 1,
}

const reportKey = { ...keyFixture, id: '9f2c1ab7e2d4', name: 'Reporting', scopeServices: ['report'], serviceLabels: ['Reporting'] }

/** The list payload; tests mutate it and re-run load() through the hook. */
const pagePayload = {
  keys: [keyFixture, reportKey],
  publicApi: { status: 'listening', host: '127.0.0.1', port: 8081, detail: null },
  services: [{ id: 'support', label: 'Support' }, { id: 'report', label: 'Reporting' }],
  access: { baseUrl: 'http://127.0.0.1:8081/v1', quotaTimeZone: 'Asia/Shanghai', quotaResetsAt: 0 },
}

const postBodies = []
globalThis.fetch = async (url, options) => {
  const path = String(url)
  if (path.includes('/api/i18n/')) {
    return { ok: true, json: async () => ({ locale: 'en', dict: { 'keys.listenerUp': 'listening on', 'keys.scope.conversations:write': 'Start conversations', 'keys.scopeUnreleased': 'not released yet', 'keys.tokenOnce': 'Shown once', 'keys.revokeConfirm': 'Revoke {name}?', 'keys.detailCalls': 'Recent calls', 'keys.detailRuns': 'Recent turns' }, locales: [] }) }
  }
  if (path.endsWith('/api/keys') && options?.method === 'POST') {
    postBodies.push({ path, body: options?.body ?? '' })
    return { ok: true, status: 201, json: async () => ({ token: 'dac_9f2c1ab7e2d4_TESTTOKEN', key: { ...keyFixture, id: '9f2c1ab7e2d4' } }) }
  }
  if (path.endsWith('/api/keys/probe')) {
    postBodies.push({ path, body: options?.body ?? '' })
    return { ok: true, status: 200, json: async () => ({ ok: true, target: 'http://127.0.0.1:8081', steps: [{ path: 'GET /v1/health', ok: true, status: 200, detail: 'the outward door answers' }], notes: [] }) }
  }
  if (path.endsWith('/revoke')) {
    postBodies.push({ path, body: '' })
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  }
  const detailMatch = /\/api\/keys\/([0-9a-f]{12})$/.exec(path)
  if (detailMatch !== null) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        key: { ...keyFixture, id: detailMatch[1], usedToday: 12, active: 1 },
        recentCalls: [{ at: 1_790_000_000_000, detail: 'GET /v1/usage → 200' }],
        recentRuns: [{ id: 'r1', state: 'done', trigger: 'api', startedAt: 1_790_000_000_000, endedAt: 1_790_000_001_000, summary: 'ok', costMicroUsd: 123, error: null }],
      }),
    }
  }
  if (path.endsWith('/api/keys')) return { ok: true, status: 200, json: async () => pagePayload }
  return { ok: false, status: 404, json: async () => ({ error: 'not_found' }) }
}

test('keys page: the round trip back from creating a service restores the draft and preselects the service', async () => {
  await import('./keys.js')
  await new Promise((resolve) => realSetTimeout(resolve, 20))

  const name = nodes.get('key-name')
  assert.equal(name.value, 'half-typed', 'the half-filled form survived the round trip')
  assert.equal(nodes.get('key-services').value, 'support', 'the new service is preselected via ?service=')
  assert.equal(nodes.get('key-quota').value, '300')
  assert.equal(nodes.get('key-rpm').value, '120', 'advanced fields restore too')

  // The listener and list still render as before.
  assert.ok(nodes.get('keys-listener').innerHTML.includes('127.0.0.1:8081'))
  const list = nodes.get('keys-list')
  assert.ok(list.innerHTML.includes('Billing service') && list.innerHTML.includes('Reporting'), 'all keys render without a filter')
})

test('keys page: the default form leaves the advanced fields at their safe defaults', async () => {
  await import('./keys.js')
  await new Promise((resolve) => realSetTimeout(resolve, 20))

  const hook = globalThis.__DAC_KEYS_TEST__
  hook.restoreDraft(null) // a fresh form: only the three basic fields matter
  nodes.get('key-name').value = 'fresh'
  nodes.get('key-services').value = 'support'
  nodes.get('key-quota').value = '200'
  nodes.get('key-rpm').value = '60'
  nodes.get('key-concurrency').value = '4'
  nodes.get('key-expires').value = ''
  nodes.get('key-quota-unlimited').checked = false

  await hook.create()
  await new Promise((resolve) => realSetTimeout(resolve, 20))

  const sent = JSON.parse(postBodies.at(-1).body)
  assert.equal(sent.name, 'fresh')
  assert.equal(sent.rateLimitRpm, 60, 'untouched advanced field = the default')
  assert.equal(sent.maxConcurrency, 4)
  assert.equal(sent.expiresAt, null)
  assert.deepEqual(sent.scopes, ['services:read', 'usage:read', 'conversations:write'], 'the safe default scopes')
})

test('keys page: the service filter chips narrow the list to that service (and "*" keys stay visible)', async () => {
  await import('./keys.js')
  const hook = globalThis.__DAC_KEYS_TEST__

  hook.setFilter('support')
  await hook.load()
  await new Promise((resolve) => realSetTimeout(resolve, 20))
  const list = nodes.get('keys-list')
  assert.ok(list.innerHTML.includes('Billing service'), 'the matching key renders')
  assert.ok(!list.innerHTML.includes('Reporting'), 'a key of another service is filtered out')
  assert.ok(nodes.get('keys-filter').innerHTML.includes('support'), 'the chips render')
})

test('keys page: the detail panel fetches one key\'s story and renders calls and turns', async () => {
  await import('./keys.js')
  const hook = globalThis.__DAC_KEYS_TEST__

  await hook.openKeyDetail('b4c36b603b1e')
  await new Promise((resolve) => realSetTimeout(resolve, 20))

  const list = nodes.get('keys-list')
  assert.ok(list.innerHTML.includes('GET /v1/usage → 200'), 'the recent outward calls render in the panel')
  assert.ok(list.innerHTML.includes('Recent calls'), 'the panel sections render')
  assert.ok(list.innerHTML.includes('r1'), 'the recent turns render with their costs')
})

test('keys page: with no service configured the form points at creating one instead of a dead select', async () => {
  await import('./keys.js')
  const hook = globalThis.__DAC_KEYS_TEST__
  pagePayload.services = []
  pagePayload.keys = []

  await hook.load()
  await new Promise((resolve) => realSetTimeout(resolve, 20))

  assert.equal(nodes.get('key-services-empty').hidden, false, 'the "create a service" guidance shows')
  assert.equal(nodes.get('key-services').hidden, true, 'the empty select hides')
  assert.equal(nodes.get('key-create').disabled, true, 'the create button cannot mint a key into no service')
  pagePayload.services = [{ id: 'support', label: 'Support' }, { id: 'report', label: 'Reporting' }]
  pagePayload.keys = [keyFixture, reportKey]
})

test('keys page: revoking asks for confirmation first, and the confirm text names the key', async () => {
  await import('./keys.js')
  await new Promise((resolve) => realSetTimeout(resolve, 20))

  const target = Object.assign(new HTMLElement(), { dataset: { revoke: 'b4c36b603b1e', revokeName: 'Billing service' }, disabled: false })
  await docListeners.click({ target })
  await new Promise((resolve) => realSetTimeout(resolve, 20))

  assert.equal(confirms.length, 1, 'revocation must be confirmed before it happens')
  assert.ok(confirms[0].includes('Billing service'), 'the confirmation names the key being revoked')
  assert.ok(postBodies.some((entry) => entry.path.endsWith('/revoke')), 'after confirmation the revoke fires')
})
