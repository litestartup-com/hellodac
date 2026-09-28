import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { parseTrustProxy } from '../config.js'

/**
 * P0-4 regression: login rate limiting must not be bypassable through X-Forwarded-For.
 *
 * The scene: `trustProxy: true` makes `request.ip` read the forwarded header directly, while
 * @fastify/rate-limit keys on `request.ip` by default -- an attacker who rotates the XFF header on every
 * request has no rate limit at all, and that limit is the only defence against password brute force
 * (no failure lockout, no captcha).
 */

const build = async (trustProxy: boolean | string) => {
  const app = Fastify({ trustProxy })
  await app.register(rateLimit, { global: false })
  app.post('/api/login', { config: { rateLimit: { max: 2, timeWindow: '1 minute' } } }, async () => ({ ok: true }))
  return app
}

const hammer = async (trustProxy: boolean | string): Promise<number[]> => {
  const app = await build(trustProxy)
  const codes: number[] = []
  for (let i = 0; i < 4; i += 1) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/login',
      // A different forwarded header every time: exactly the bypass technique
      headers: { 'x-forwarded-for': `203.0.113.${i}` },
      payload: { username: 'admin', password: 'x' },
    })
    codes.push(response.statusCode)
  }
  await app.close()
  return codes
}

test('P0-4: rotating X-Forwarded-For cannot bypass the login rate limit (default configuration)', async () => {
  const codes = await hammer(parseTrustProxy(undefined))
  assert.deepEqual(codes.slice(0, 2), [200, 200], 'the first two inside the window should be allowed')
  assert.equal(codes[2], 429, 'the third must be rate limited -- the key has to land on the unforgeable direct peer')
  assert.equal(codes[3], 429)
})

test('P0-4: the old trustProxy=true behaviour really can be bypassed (that is the defect that was fixed)', async () => {
  const codes = await hammer(true)
  assert.deepEqual(codes, [200, 200, 200, 200], 'trusting every forwarded header makes the rate limit not exist')
})

test('P0-4: TRUST_PROXY parsing -- untrusted by default, trusted only when configured explicitly', () => {
  assert.equal(parseTrustProxy(undefined), false, 'an unset value must default safely (forwarded headers not trusted)')
  assert.equal(parseTrustProxy(''), false)
  assert.equal(parseTrustProxy('false'), false)
  assert.equal(parseTrustProxy('0'), false)
  assert.equal(parseTrustProxy('true'), true)
  // A plain number (the "hop count" spelling) is not supported: fastify would read '1' as an IP string, and
  // a silent misreading is more dangerous than not supporting it -- so it falls back to untrusted, and
  // loadConfig raises a startup warning
  assert.equal(parseTrustProxy('1'), false)
  assert.equal(parseTrustProxy('2'), false)
  // A concrete address or subnet: trust that hop only
  assert.equal(parseTrustProxy('127.0.0.1'), '127.0.0.1')
  assert.equal(parseTrustProxy('172.16.0.0/12, 127.0.0.1'), '172.16.0.0/12, 127.0.0.1')
})
