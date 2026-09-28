import { test } from 'node:test'
import assert from 'node:assert/strict'
import { captureGuiToken, guiOpenUrl, guiDirectUrl } from './gui-token.js'

test('Debt P1 regression: a 0.1.5 token line is captured (the startup line carries ?token=)', () => {
  const logs = [
    'profile seeded into /data/profiles/dac-node (seed 25f00fc3)',
    'dsh web: http://127.0.0.1:3080/?token=BMJaU1Hgo6ZMqG8ak-exj31Hy9i0KPFq3H424qcESyg (LAN: http://172.17.0.2:3080/?token=BMJaU1Hgo6ZMqG8ak-exj31Hy9i0KPFq3H424qcESyg)',
  ].join('\n')
  assert.deepEqual(captureGuiToken(logs), { found: true, token: 'BMJaU1Hgo6ZMqG8ak-exj31Hy9i0KPFq3H424qcESyg', url: 'http://127.0.0.1:3080/' })
})

test('Debt P1 regression: 0.1.2 and below have no token line (a bare URL means the GUI is ready, no auth parameter needed)', () => {
  const logs = 'dsh web: http://127.0.0.1:3080 (LAN: http://172.17.0.2:3080)'
  assert.deepEqual(captureGuiToken(logs), { found: true, token: null, url: 'http://127.0.0.1:3080/' })
})

test('Debt P1 regression: rotation on restart -- the last token to appear is the current one', () => {
  const logs = [
    'dsh web: http://127.0.0.1:3080/?token=old-token',
    'restarted...',
    'dsh web: http://127.0.0.1:3080/?token=new-token-2',
  ].join('\n')
  assert.deepEqual(captureGuiToken(logs), { found: true, token: 'new-token-2', url: 'http://127.0.0.1:3080/' })
})

test('Debt P1 regression: no startup line yet = not captured (the GUI is still starting)', () => {
  assert.deepEqual(captureGuiToken('random log lines\nno url here'), { found: false, token: null, url: null })
  assert.deepEqual(captureGuiToken(''), { found: false, token: null, url: null })
})

test('UX regression: the local direct URL uses the real port plus token from the startup line (a tunnel URL still uses localPort)', () => {
  const capture = { found: true, token: 'tok-9', url: 'http://127.0.0.1:3081/' }
  assert.equal(guiDirectUrl(capture), 'http://127.0.0.1:3081/?token=tok-9')
  assert.equal(guiOpenUrl(3088, capture), 'http://127.0.0.1:3088/?token=tok-9', 'the tunnel form is unaffected')
  assert.equal(guiDirectUrl({ found: true, token: null, url: 'http://127.0.0.1:3081/' }), 'http://127.0.0.1:3081/')
  assert.equal(guiDirectUrl({ found: false, token: null, url: null }), null)
})
