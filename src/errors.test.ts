import { test } from 'node:test'
import assert from 'node:assert/strict'
import { UpstreamError } from './upstream/rpc.js'
import { errorText } from './errors.js'

/** Debt E6 regression: the error-to-text mapping (UpstreamError / plain Error / unknown value). */

test('UpstreamError takes message; a plain Error takes message; an unknown value is String-ed', () => {
  assert.equal(errorText(new UpstreamError('not_found', 'session gone')), 'session gone')
  assert.equal(errorText(new Error('boom')), 'boom')
  assert.equal(errorText({ code: 1 }), '[object Object]')
  assert.equal(errorText('plain'), 'plain')
})
