import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * Page-script runtime smoke: run keys.js as a real module and assert it does not throw and that it
 * rendered the data into the matching nodes. This is the hindsight guard added for the 2026-09-27 incident --
 * every widget on the page was there and the API was fine, but the script called `.json()` on the `apiJson`
 * return as if it were a `Response`, so the page sat at "Loading…"; `node --check` and "asset 200" miss it.
 *
 * Constraint: this test relies on module top-level side effects, and node --test gives each file its own process ✓.
 */
const nodes = new Map()

const el = (id) => {
  const existing = nodes.get(id)
  if (existing !== undefined) return existing
  const node = { id, innerHTML: '', textContent: '', hidden: false, disabled: false, value: '', options: [], listeners: {}, addEventListener: (type, fn) => { node.listeners[type] = fn } }
  nodes.set(id, node)
  return node
}

globalThis.document = {
  documentElement: { lang: 'en' },
  cookie: '',
  hidden: false,
  getElementById: (id) => nodes.get(id) ?? null,
  addEventListener: () => undefined,
  querySelectorAll: () => [
    { value: 'services:read' },
    { value: 'usage:read' },
  ],
}
globalThis.window = globalThis
globalThis.HTMLElement = class {}
// poll() arms a 15s timer: the test does not let it actually tick (polling behaviour is not what this test is about).
const realSetTimeout = globalThis.setTimeout
globalThis.setTimeout = () => 0
globalThis.clearTimeout = () => undefined

// Pre-create the page nodes (the full set of ids in keys.html)
for (const id of ['keys-listener', 'key-services', 'key-scopes', 'key-create', 'key-create-msg', 'keys-list', 'keys-refresh', 'key-name', 'key-quota', 'key-token', 'key-form']) el(id)

const keyFixture = {
  id: 'b4c36b603b1e',
  name: 'Billing service',
  scopes: ['services:read', 'tasks:write'],
  scopeServices: ['support'],
  quotaRunsDay: 200,
  rateLimitRpm: 60,
  maxConcurrency: 4,
  expiresAt: null,
  revokedAt: null,
  lastUsedAt: null,
  createdAt: 1_790_000_000_000,
}

globalThis.fetch = async (url, options) => {
  const path = String(url)
  if (path.includes('/api/i18n/')) return { ok: true, json: async () => ({ locale: 'en', dict: { 'keys.listenerUp': 'listening on' }, locales: [] }) }
  if (path.endsWith('/api/keys') && options?.method === 'POST') {
    postBodies.push(options?.body ?? '')
    return { ok: true, status: 201, json: async () => ({ token: 'dac_9f2c1ab7e2d4_TESTTOKEN', key: { id: '9f2c1ab7e2d4' } }) }
  }
  if (path.endsWith('/api/keys')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        keys: [keyFixture],
        publicApi: { status: 'listening', host: '127.0.0.1', port: 8081, detail: null },
        services: [{ id: 'support', label: 'Support' }],
      }),
    }
  }
  return { ok: false, status: 404, json: async () => ({ error: 'not_found' }) }
}
const postBodies = []

test('keys page script: loading does not throw, and the data lands in the matching nodes (guards the "Loading…" incident)', async () => {
  await import('./keys.js')

  // load() is a synchronous chain after the top-level await; give it a microtask window to finish rendering.
  await new Promise((resolve) => realSetTimeout(resolve, 20))

  const listener = nodes.get('keys-listener')
  assert.ok(listener !== undefined && listener.innerHTML.includes('127.0.0.1:8081'), `the facade state did not render: ${listener?.innerHTML}`)

  const list = nodes.get('keys-list')
  assert.ok(list !== undefined && list.innerHTML.includes('Billing service'), `the key list did not render: ${list?.innerHTML}`)
  assert.ok(list !== undefined && list.innerHTML.includes('b4c36b603b1e'), 'the list must show the keyId')

  const services = nodes.get('key-services')
  assert.ok(services !== undefined && services.innerHTML.includes('support'), 'the service dropdown must be filled')

  const msg = nodes.get('key-create-msg')
  assert.ok(msg !== undefined && msg.textContent === '', 'with a service configured the "no services" notice must not show')
})

test('keys form: submit -> issue -> the plaintext is shown once (drives the real form handler)', async () => {
  await import('./keys.js')
  await new Promise((resolve) => realSetTimeout(resolve, 20))

  const form = nodes.get('key-form')
  assert.ok(form !== undefined && typeof form.listeners?.submit === 'function', 'the form must register a submit handler')

  const nameEl = nodes.get('key-name')
  const serviceEl = nodes.get('key-services')
  nameEl.value = 'acceptance key'
  serviceEl.value = 'support'

  await form.listeners.submit({ preventDefault: () => undefined })
  await new Promise((resolve) => realSetTimeout(resolve, 20))

  const body = postBodies[0]
  assert.ok(body !== undefined, 'a submit must send POST /api/keys')
  const parsed = JSON.parse(body)
  assert.equal(parsed.name, 'acceptance key')
  assert.deepEqual(parsed.services, ['support'])
  assert.deepEqual(parsed.scopes, ['services:read', 'usage:read'], 'default read-only scopes (the checked boxes)')

  const reveal = nodes.get('key-token')
  assert.ok(reveal !== undefined && reveal.hidden === false, 'after a successful issue the plaintext area must be shown')
  assert.ok(reveal !== undefined && reveal.innerHTML.includes('TESTTOKEN'), 'the plaintext area must contain the token')
})
