import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GatewayError } from './gateway/client.js'
import { UpstreamError } from './upstream/rpc.js'
import { errorText } from './errors.js'

/** 债务 E6 回归:错误文本映射三态(detail 兜底/普通 Error/未知值)。 */

test('GatewayError 取 detail,缺 detail 兜底 message', () => {
  const e = new GatewayError('A', 502, 'session cap reached')
  assert.equal(errorText(e), 'session cap reached')
  const bare = new GatewayError('A', 502, 'gateway exploded')
  assert.equal(errorText(bare), 'gateway exploded')
})

test('UpstreamError 取 message;普通 Error 取 message;未知值 String 化', () => {
  assert.equal(errorText(new UpstreamError('not_found', 'session gone')), 'session gone')
  assert.equal(errorText(new Error('boom')), 'boom')
  assert.equal(errorText({ code: 1 }), '[object Object]')
  assert.equal(errorText('plain'), 'plain')
})
