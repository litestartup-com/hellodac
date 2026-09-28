import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  COMPAT_DSH_VERSION, GATEWAY_REF, SUPPORTED_DSH,
  defaultDshVersion, resolvePair, pairStatus, isSupportedDsh, dshCompatible,
  _setMatrixForTest, _resetMatrixForTest,
} from './dsh-matrix.js'

test('Debt P3 regression: the default version is the matrix first row; both rows 0.1.2-rc.1 + 0.1.5-rc.2 are verified', () => {
  assert.equal(COMPAT_DSH_VERSION, '0.1.2-rc.1')
  assert.equal(defaultDshVersion(), '0.1.2-rc.1')
  assert.deepEqual(SUPPORTED_DSH.map((p) => p.dsh), ['0.1.2-rc.1', '0.1.5-rc.2'])
  assert.equal(SUPPORTED_DSH[0]?.status, 'verified')
  assert.equal(SUPPORTED_DSH[1]?.status, 'verified', 'promoted once the full P3 smoke chain passed')
  assert.equal(SUPPORTED_DSH[0]?.needsLegacyPeerDeps, undefined, '0.1.2 does not need --legacy-peer-deps')
  assert.equal(SUPPORTED_DSH[1]?.needsLegacyPeerDeps, true, 'installing 0.1.5 must carry --legacy-peer-deps (dsh-facts §12)')
})

test('Debt P3 regression: resolvePair / pairStatus -- a known pairing returns its matrix row, an unknown one returns null', () => {
  assert.deepEqual(resolvePair('0.1.2-rc.1'), { dsh: '0.1.2-rc.1', gateway: GATEWAY_REF, status: 'verified' })
  assert.equal(pairStatus('0.1.5-rc.2'), 'verified')
  assert.equal(pairStatus('0.1.1-rc.2'), null)
  assert.equal(resolvePair('0.9.9'), null)
})

test('Debt P3 regression: dshCompatible is now a matrix lookup (tolerating a v prefix)', () => {
  assert.equal(dshCompatible('0.1.2-rc.1'), true)
  assert.equal(dshCompatible('0.1.5-rc.2'), true)
  assert.equal(dshCompatible('v0.1.2-rc.1'), true, 'v prefix tolerated')
  assert.equal(dshCompatible('0.1.1-rc.2'), false)
  assert.equal(dshCompatible(null), false)
  assert.equal(isSupportedDsh('0.1.5-rc.2'), true)
})

test('Debt P3: the test injection seam _setMatrixForTest takes effect and can be reset (it is what covers the pending yellow-text path)', () => {
  _setMatrixForTest([{ dsh: '0.1.6-rc.9', gateway: GATEWAY_REF, status: 'pending' }])
  try {
    assert.equal(pairStatus('0.1.6-rc.9'), 'pending')
    assert.equal(pairStatus('0.1.5-rc.2'), null, 'the real matrix row is invisible while overridden')
    assert.equal(dshCompatible('0.1.6-rc.9'), true, 'a pending row is still inside the matrix semantics')
  } finally {
    _resetMatrixForTest()
  }
  assert.equal(pairStatus('0.1.5-rc.2'), 'verified', 'back to the real matrix after the reset')
  assert.equal(pairStatus('0.1.6-rc.9'), null)
})
