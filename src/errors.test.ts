import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GatewayError } from './gateway/client.js'
import { UpstreamError } from './upstream/rpc.js'
import { errorText } from './errors.js'

/** Debt E6 regression: the three-state error text mapping (detail wins / plain Error / unknown value). */

test('GatewayError takes detail, and falls back to message when detail is missing', () => {
  const e = new GatewayError('A', 502, 'session cap reached')
  assert.equal(errorText(e), 'session cap reached')
  const bare = new GatewayError('A', 502, 'gateway exploded')
  assert.equal(errorText(bare), 'gateway exploded')
})

test('UpstreamError takes message; a plain Error takes message; an unknown value is String-ed', () => {
  assert.equal(errorText(new UpstreamError('not_found', 'session gone')), 'session gone')
  assert.equal(errorText(new Error('boom')), 'boom')
  assert.equal(errorText({ code: 1 }), '[object Object]')
  assert.equal(errorText('plain'), 'plain')
})
