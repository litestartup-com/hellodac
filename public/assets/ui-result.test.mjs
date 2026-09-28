// Debt F6: behaviour tests for the unified Result layer (apiJson in ui.js) -- node:test, part of CI test:web.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { apiJson, showError, bannerHtml } from './ui.js'

/**
 * Fake the global fetch. When the body is a string the response is not JSON (JSON.parse throws).
 * @param {number} status
 * @param {unknown} body
 */
const fakeFetch = (status, body) => {
  const json = async () => {
    if (typeof body === 'string') throw new Error('not json')
    return body
  }
  globalThis.fetch = mock.fn(async () => ({
    status,
    ok: status >= 200 && status < 300,
    clone: () => ({ async json() { return json() } }),
    json,
    async text() { return typeof body === 'string' ? body : JSON.stringify(body) },
  }))
}

const reset = () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  globalThis.document = { cookie: '', getElementById: () => null }
}

test('debt F6: an ok response -> { ok:true, status, data }', async () => {
  try {
    reset()
    fakeFetch(200, { months: ['2026-09'] })
    const r = await apiJson('/api/usage')
    assert.deepEqual(r, { ok: true, status: 200, data: { months: ['2026-09'] } })
  } finally {
    mock.timers.reset()
  }
})

test('debt F6: a non-ok response -> { ok:false, status, error, detail }, with a readable JSON error body', async () => {
  try {
    reset()
    fakeFetch(400, { error: 'bad_month', detail: 'bad month format' })
    const r = await apiJson('/api/usage?month=x')
    assert.deepEqual(r, { ok: false, status: 400, error: 'bad_month', detail: 'bad month format' })
  } finally {
    mock.timers.reset()
  }
})

test('debt F6: a non-JSON error body -> detail falls back to the HTTP status, without throwing', async () => {
  try {
    reset()
    fakeFetch(500, '<html>boom</html>')
    const r = await apiJson('/api/usage')
    assert.deepEqual(r, { ok: false, status: 500, error: 'http_error', detail: 'HTTP 500' })
  } finally {
    mock.timers.reset()
  }
})

test('debt F6: 401 goes into the Result as-is (redirecting to login is the page decision)', async () => {
  try {
    reset()
    fakeFetch(401, { error: 'unauthorized' })
    const r = await apiJson('/api/usage')
    assert.equal(r.ok, false)
    assert.equal(r.status, 401)
  } finally {
    mock.timers.reset()
  }
})

test('debt F6: showError emits the shared banner and escapes detail (no hand-written fallback)', () => {
  const html = showError({ ok: false, status: 500, error: 'x', detail: '<script>alert(1)</script>' }, 'read failed')
  assert.ok(html.includes('read failed'))
  assert.ok(!html.includes('<script>'), 'detail must be escaped')
  assert.ok(html.includes('&lt;script&gt;'))
  const reference = bannerHtml({ level: 'bad', title: 'read failed', body: 'x' })
  assert.ok(html.startsWith(reference.slice(0, reference.indexOf('read failed'))), 'the same skeleton as bannerHtml')
})

test('debt F6: showError on an ok Result returns an empty string (it only renders failures)', () => {
  assert.equal(showError({ ok: true, status: 200, data: null }, 'read failed'), '')
})
