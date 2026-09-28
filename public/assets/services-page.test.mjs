import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * Page-script runtime smoke for the outward-service page: run services.js as a real module against a
 * stub DOM and assert the API payload actually reaches the page.
 *
 * The point is the same one keys-page.test.mjs was written for after the 2026-09-27 incident: every
 * asset answers 200 and the API answers 200, yet the page sits at "Loading…" because the script used
 * the wrong shape. `node --check` and a liveness probe cannot see that; only executing the module can.
 *
 * Constraint: this relies on module top-level side effects, and node --test gives each file its own process.
 */
const nodes = new Map()

const el = (id) => {
  const existing = nodes.get(id)
  if (existing !== undefined) return existing
  const node = { id, innerHTML: '', textContent: '', hidden: false, listeners: {}, addEventListener: (type, fn) => { node.listeners[type] = fn } }
  nodes.set(id, node)
  return node
}

globalThis.document = {
  documentElement: { lang: 'en' },
  cookie: '',
  getElementById: (id) => nodes.get(id) ?? null,
  addEventListener: () => undefined,
}
globalThis.window = globalThis
// poll() arms a 15s timer; polling behaviour is not what this test is about.
const realSetTimeout = globalThis.setTimeout
globalThis.setTimeout = () => 0
globalThis.clearTimeout = () => undefined

for (const id of ['services-list', 'services-refresh', 'services-note']) el(id)

const payload = {
  services: [
    {
      id: 'chat',
      label: 'Support',
      surfaces: ['conversations'],
      declaredCount: 1,
      permission: 'read',
      sessionIdleHours: 24,
      placement: 'pin',
      machines: ['agent-002cf073615f'],
      knowledge: [{ host: '/srv/manual', mount: '/knowledge', readOnly: true }],
      agents: [
        { id: 'svc-chat-1', name: 'Support 1', endpoint: 'svc-chat-1', machine: 'dac-33-11 (agent-002cf073615f)', online: true, sessions: 3, queueDepth: 1, maxSessions: 4, provider: 'deepseek-official', model: 'deepseek-v4-flash', sandboxMode: 'read-only' },
        { id: 'svc-chat-2', name: 'Support 2', endpoint: 'svc-chat-2', machine: 'dac-33-11 (agent-002cf073615f)', online: false, sessions: 0, queueDepth: 0, maxSessions: 4, provider: 'deepseek-official', model: 'deepseek-v4-flash', sandboxMode: 'read-only' },
      ],
      capacity: { maxConcurrent: 8, onlineMaxConcurrent: 4, inUse: 3, queued: 1, onlineAgents: 1, declaredAgents: 2 },
      keys: [
        { id: 'b4c36b603b1e', name: 'Acme support window', usedToday: 12, quotaRunsDay: 200, active: 1, maxConcurrency: 4, revokedAt: null },
      ],
    },
  ],
  keysExist: true,
}

globalThis.fetch = async (url) => {
  const path = String(url)
  if (path.includes('/api/i18n/')) {
    // A dictionary with every key the page uses left empty would print key names; instead answer the
    // real English wording for the handful the assertions look at, and echo the key otherwise (the
    // assertions below only check data, not prose).
    return { ok: true, json: async () => ({ locale: 'en', dict: {}, locales: [] }) }
  }
  if (path.endsWith('/api/services')) return { ok: true, status: 200, json: async () => payload }
  return { ok: false, status: 404, json: async () => ({ error: 'not_found' }) }
}

test('services page script: loading does not throw and the service state lands on the page (guards the "Loading…" incident)', async () => {
  await import('./services.js')
  // load() is a synchronous chain after the top-level await; give it a microtask window to render.
  await new Promise((resolve) => realSetTimeout(resolve, 20))

  const list = nodes.get('services-list')
  assert.ok(list !== undefined, 'services-list must exist')
  const html = list.innerHTML

  assert.ok(html.includes('Support'), `the service must render: ${html.slice(0, 400)}`)
  assert.ok(html.includes('chat'), 'the service id must render')
  assert.ok(html.includes('Support 1') && html.includes('Support 2'), 'every agent of the service must render')
  // The load numbers are the page's whole reason to exist.
  assert.ok(html.includes('3/4'), `the per-agent load must be spelled out (sessions/max): ${html.slice(0, 600)}`)
  assert.ok(html.includes('1/2'), 'agents online vs declared must be spelled out')
  assert.ok(html.includes('3/8'), 'conversations in use vs promised concurrency must be spelled out')
  // The model pin is what the cost ledger depends on, so it belongs on the page.
  assert.ok(html.includes('deepseek-official/deepseek-v4-flash'), 'the pinned model must be visible')
  assert.ok(html.includes('Acme support window'), 'the key serving this service must be listed')
  assert.ok(html.includes('12'), 'the key\'s usage today must be shown')
  assert.ok(html.includes('read-only'), 'the permission tier in force must be visible')
  // The page must never claim to be loading once it has data.
  assert.ok(!html.includes('Loading'), 'the page must not stay at the loading state')
})
