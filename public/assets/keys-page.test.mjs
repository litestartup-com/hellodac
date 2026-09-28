import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * Page-script runtime smoke for the API-key page: run keys.js as a real module and assert that the
 * create flow, the outward probe, the copyable handover and the confirmed revoke actually fire --
 * the guard added after the 2026-09-27 incident, in which every widget was present and the API was
 * fine, but the script used the wrong return shape and the page sat at "Loading…" forever.
 *
 * Constraint: this test relies on module top-level side effects, and node --test gives each file its own process.
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
globalThis.HTMLElement = class {}
const realSetTimeout = globalThis.setTimeout
globalThis.setTimeout = () => 0
globalThis.clearTimeout = () => undefined
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async () => undefined } }, configurable: true })
const confirms = []
globalThis.confirm = (text) => { confirms.push(text); return true }

// Every id in keys.html.
for (const id of [
  'keys-refresh', 'keys-note', 'keys-listener', 'keys-access', 'key-form', 'key-create-msg', 'key-name',
  'key-services', 'key-scopes', 'key-quota', 'key-quota-unlimited', 'key-rpm', 'key-concurrency',
  'key-expires', 'key-create', 'key-token', 'key-token-value', 'key-token-copy', 'key-probe',
  'key-probe-result', 'key-handover', 'key-handover-copy', 'key-handover-msg', 'keys-list',
  'key-verify', 'key-verify-open', 'key-verify-form', 'key-verify-token', 'key-verify-run', 'key-verify-cancel',
  'key-verify-result',
]) el(id)

const keyFixture = {
  id: 'b4c36b603b1e',
  name: 'Billing service',
  scopes: ['services:read', 'tasks:write'],
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

const postBodies = []
globalThis.fetch = async (url, options) => {
  const path = String(url)
  if (path.includes('/api/i18n/')) {
    return { ok: true, json: async () => ({ locale: 'en', dict: { 'keys.listenerUp': 'listening on', 'keys.scope.conversations:write': 'Start conversations', 'keys.scopeUnreleased': 'not released yet', 'keys.tokenOnce': 'Shown once', 'keys.revokeConfirm': 'Revoke {name}?' }, locales: [] }) }
  }
  if (path.endsWith('/api/keys') && options?.method === 'POST') {
    postBodies.push({ path, body: options?.body ?? '' })
    return { ok: true, status: 201, json: async () => ({ token: 'dac_9f2c1ab7e2d4_TESTTOKEN', key: { ...keyFixture, id: '9f2c1ab7e2d4' } }) }
  }
  if (path.endsWith('/api/keys/probe')) {
    postBodies.push({ path, body: options?.body ?? '' })
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        target: 'http://127.0.0.1:8081',
        steps: [{ path: 'GET /v1/health', ok: true, status: 200, detail: 'the outward door answers' }],
        notes: [],
      }),
    }
  }
  if (path.endsWith('/revoke')) {
    postBodies.push({ path, body: '' })
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  }
  if (path.endsWith('/api/keys')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        keys: [keyFixture],
        publicApi: { status: 'listening', host: '127.0.0.1', port: 8081, detail: null },
        services: [{ id: 'support', label: 'Support' }],
        access: { baseUrl: 'http://127.0.0.1:8081/v1', quotaTimeZone: 'Asia/Shanghai', quotaResetsAt: 0 },
      }),
    }
  }
  return { ok: false, status: 404, json: async () => ({ error: 'not_found' }) }
}

test('keys page: loading renders the listener, the explained scope checklist and the key list', async () => {
  await import('./keys.js')
  await new Promise((resolve) => realSetTimeout(resolve, 20))

  const listener = nodes.get('keys-listener')
  assert.ok(listener !== undefined && listener.innerHTML.includes('127.0.0.1:8081'), `the outward address did not render: ${listener?.innerHTML}`)

  const scopes = nodes.get('key-scopes')
  assert.ok(scopes !== undefined && scopes.innerHTML.includes('Start conversations'), 'scopes are rendered in human terms')
  assert.ok(scopes !== undefined && scopes.innerHTML.includes('conversations:write'), 'the real scope id stays visible in small print')
  assert.ok(scopes !== undefined && scopes.innerHTML.includes('not released yet'), 'unreleased scopes are flagged instead of silently grantable')

  const list = nodes.get('keys-list')
  assert.ok(list !== undefined && list.innerHTML.includes('Billing service'), `the key list did not render: ${list?.innerHTML}`)
  assert.ok(list !== undefined && list.innerHTML.includes('12/200'), 'today usage vs quota is spelled out')
})

test('keys form: submit sends the extended fields and reveals the token once', async () => {
  await import('./keys.js')
  await new Promise((resolve) => realSetTimeout(resolve, 20))

  const form = nodes.get('key-form')
  nodes.get('key-name').value = 'acceptance key'
  nodes.get('key-services').value = 'support'
  nodes.get('key-quota').value = '300'
  nodes.get('key-rpm').value = '120'
  nodes.get('key-concurrency').value = '8'
  nodes.get('key-expires').value = '2027-01-01'

  await form.listeners.submit({ preventDefault: () => undefined })
  await new Promise((resolve) => realSetTimeout(resolve, 20))

  const sent = JSON.parse(postBodies[0].body)
  assert.equal(sent.name, 'acceptance key')
  assert.deepEqual(sent.services, ['support'])
  assert.deepEqual(sent.scopes, ['services:read', 'usage:read', 'conversations:write'], 'default read-only scopes')
  assert.equal(sent.rateLimitRpm, 120, 'the per-minute cap is now part of the form')
  assert.equal(sent.maxConcurrency, 8, 'the in-flight cap is now part of the form')
  assert.equal(sent.quotaRunsDay, 300)
  assert.ok(sent.expiresAt > Date.now(), 'an expiry date becomes an epoch')

  const reveal = nodes.get('key-token')
  assert.equal(reveal.hidden, false, 'after a successful issue the plaintext area is shown')
  assert.ok(nodes.get('key-token-value').textContent.includes('TESTTOKEN'), 'the plaintext area contains the token')
  assert.ok(nodes.get('key-handover').innerHTML.includes('127.0.0.1:8081'), 'the handover block carries the outward address')
})

test('keys page: the probe button tests the fresh token against the real outward door', async () => {
  await import('./keys.js')
  await new Promise((resolve) => realSetTimeout(resolve, 20))

  await nodes.get('key-form').listeners.submit({ preventDefault: () => undefined })
  await new Promise((resolve) => realSetTimeout(resolve, 20))
  await nodes.get('key-probe').listeners.click({})
  await new Promise((resolve) => realSetTimeout(resolve, 20))

  const probe = postBodies.find((entry) => entry.path.endsWith('/api/keys/probe'))
  assert.ok(probe !== undefined, 'the test button must fire the probe')
  assert.equal(JSON.parse(probe.body).token, 'dac_9f2c1ab7e2d4_TESTTOKEN', 'the probe uses the plaintext the page just received')
  assert.ok(nodes.get('key-probe-result').innerHTML.includes('/v1/health'), 'the probe steps render')
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
