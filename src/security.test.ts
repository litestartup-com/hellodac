import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { registerSecurityHeaders } from './security.js'

/**
 * P1-1 regression: security response headers.
 *
 * The situation: the manager sent no security header at all -- no CSP, no X-Content-Type-Options,
 * no Referrer-Policy. The frontend has 52 innerHTML sites that consume model output/workspace files/node logs
 * directly, and the only line of defence was a hand-written escape-first renderer; CSP is the second gate beyond it.
 *
 * Two deployment-shape constraints (do not step on them):
 *  - plain HTTP is a supported deployment too (one of the three nginx modes) -> never send
 *    upgrade-insecure-requests, and never send HSTS without TLS, or the browser upgrades/pins a
 *    working HTTP site into an unreachable HTTPS one.
 *  - inline style attributes are in use in the board/spend rendering -> style-src must allow unsafe-inline,
 *    but script-src must never allow it.
 */

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')

const headersOf = async (secure: boolean): Promise<Record<string, string>> => {
  const app = Fastify()
  await registerSecurityHeaders(app, secure)
  app.get('/', async (_request, reply) => reply.type('text/html').send('<p>ok</p>'))
  const response = await app.inject({ method: 'GET', url: '/' })
  await app.close()
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(response.headers)) {
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value ?? '')
  }
  return out
}

test('P1-1: the CSP forbids inline scripts and carries no directive that would break a plain-HTTP deployment', async () => {
  const headers = await headersOf(false)
  const csp = headers['content-security-policy'] ?? ''
  assert.ok(csp !== '', 'Content-Security-Policy must be sent')
  assert.match(csp, /script-src [^;]*'self'/, "script-src must be limited to 'self'")
  assert.doesNotMatch(csp, /script-src [^;]*'unsafe-inline'/, 'script-src must never allow inline scripts')
  assert.doesNotMatch(csp, /script-src [^;]*'unsafe-eval'/)
  assert.doesNotMatch(csp, /upgrade-insecure-requests/, 'it would break a plain-HTTP deployment')
  assert.match(csp, /default-src 'self'/)
  assert.match(csp, /object-src 'none'/)
  // The frontend uses inline style attributes (board/spend) -- allow styles, but only styles
  assert.match(csp, /style-src [^;]*'unsafe-inline'/)
})

test('P1-1: the basic security headers are all present; HSTS only under TLS', async () => {
  const plain = await headersOf(false)
  assert.equal(plain['x-content-type-options'], 'nosniff')
  assert.ok((plain['referrer-policy'] ?? '') !== '')
  assert.ok((plain['x-frame-options'] ?? '') !== '' || /frame-ancestors/.test(plain['content-security-policy'] ?? ''))
  assert.equal(plain['strict-transport-security'], undefined, 'sending HSTS over plain HTTP pins the site to HTTPS')

  const tls = await headersOf(true)
  assert.match(tls['strict-transport-security'] ?? '', /max-age=\d+/)
})

test('P1-1: the login page must not contain inline scripts (otherwise the CSP blocks logging in)', () => {
  const html = readFileSync(join(publicDir, 'login.html'), 'utf8')
  // only <script> tags that carry a src are allowed
  for (const tag of html.match(/<script\b[^>]*>/g) ?? []) {
    assert.match(tag, /\ssrc=/, `${tag} in login.html must be an external file`)
  }
  assert.ok(html.includes('/assets/login.js'), 'the login logic should live in /assets/login.js')
})
