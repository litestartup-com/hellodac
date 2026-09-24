import { test } from 'node:test'
import assert from 'node:assert/strict'
import { captureGuiToken, guiOpenUrl, guiDirectUrl } from './gui-token.js'

test('债务 P1 回归: 0.1.5 token 行捕获(启动行含 ?token=)', () => {
  const logs = [
    'profile seeded into /data/profiles/dac-node (seed 25f00fc3)',
    'dsh web: http://127.0.0.1:3080/?token=BMJaU1Hgo6ZMqG8ak-exj31Hy9i0KPFq3H424qcESyg (LAN: http://172.17.0.2:3080/?token=BMJaU1Hgo6ZMqG8ak-exj31Hy9i0KPFq3H424qcESyg)',
  ].join('\n')
  assert.deepEqual(captureGuiToken(logs), { found: true, token: 'BMJaU1Hgo6ZMqG8ak-exj31Hy9i0KPFq3H424qcESyg', url: 'http://127.0.0.1:3080/' })
})

test('债务 P1 回归: 0.1.2 及以下无 token 行(裸 URL = GUI 已就绪、无需鉴权参数)', () => {
  const logs = 'dsh web: http://127.0.0.1:3080 (LAN: http://172.17.0.2:3080)'
  assert.deepEqual(captureGuiToken(logs), { found: true, token: null, url: 'http://127.0.0.1:3080/' })
})

test('债务 P1 回归: 重启轮换——最后一次出现的 token 是当前态', () => {
  const logs = [
    'dsh web: http://127.0.0.1:3080/?token=old-token',
    'restarted...',
    'dsh web: http://127.0.0.1:3080/?token=new-token-2',
  ].join('\n')
  assert.deepEqual(captureGuiToken(logs), { found: true, token: 'new-token-2', url: 'http://127.0.0.1:3080/' })
})

test('债务 P1 回归: 尚无启动行 = 未捕获(GUI 还在启动)', () => {
  assert.deepEqual(captureGuiToken('random log lines\nno url here'), { found: false, token: null, url: null })
  assert.deepEqual(captureGuiToken(''), { found: false, token: null, url: null })
})

test('体验优化回归: 本机直连 URL 用启动行里的真实端口 + token（隧道 URL 仍用 localPort）', () => {
  const capture = { found: true, token: 'tok-9', url: 'http://127.0.0.1:3081/' }
  assert.equal(guiDirectUrl(capture), 'http://127.0.0.1:3081/?token=tok-9')
  assert.equal(guiOpenUrl(3088, capture), 'http://127.0.0.1:3088/?token=tok-9', '隧道形态不受影响')
  assert.equal(guiDirectUrl({ found: true, token: null, url: 'http://127.0.0.1:3081/' }), 'http://127.0.0.1:3081/')
  assert.equal(guiDirectUrl({ found: false, token: null, url: null }), null)
})
