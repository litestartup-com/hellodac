import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  COMPAT_DSH_VERSION, GATEWAY_REF, GATEWAY_REF_020, SUPPORTED_DSH,
  defaultDshVersion, resolvePair, pairStatus, isSupportedDsh, dshCompatible, isLegacyDshLine,
  _setMatrixForTest, _resetMatrixForTest,
} from './dsh-matrix.js'

test('Debt P3 regression: the default version is the matrix first row; the 0.1.x rows are verified and 0.2.0-rc.2 enters as pending', () => {
  assert.equal(COMPAT_DSH_VERSION, '0.1.2-rc.1')
  assert.equal(defaultDshVersion(), '0.1.2-rc.1')
  assert.deepEqual(SUPPORTED_DSH.map((p) => p.dsh), ['0.1.2-rc.1', '0.1.5-rc.2', '0.2.0-rc.2'])
  assert.equal(SUPPORTED_DSH[0]?.status, 'verified')
  assert.equal(SUPPORTED_DSH[1]?.status, 'verified', 'promoted once the full P3 smoke chain passed')
  assert.equal(SUPPORTED_DSH[2]?.status, 'pending', 'promoted to verified only after the manager-side full-chain smoke passes (dsh-matrix.ts header contract)')
  assert.equal(SUPPORTED_DSH[0]?.needsLegacyPeerDeps, undefined, '0.1.2 does not need --legacy-peer-deps')
  assert.equal(SUPPORTED_DSH[1]?.needsLegacyPeerDeps, true, 'installing 0.1.5 must carry --legacy-peer-deps (dsh-facts §12)')
  assert.equal(SUPPORTED_DSH[2]?.needsLegacyPeerDeps, true, 'npm strict prerelease peer resolution rejects the 0.2.0 line too (the gateway README pairs it with 0.1.5; dsh-facts §18.9)')
})

test('Debt P3 regression: resolvePair / pairStatus -- a known pairing returns its matrix row, an unknown one returns null', () => {
  assert.deepEqual(resolvePair('0.1.2-rc.1'), { dsh: '0.1.2-rc.1', gateway: GATEWAY_REF, status: 'verified' })
  assert.deepEqual(resolvePair('0.2.0-rc.2'), { dsh: '0.2.0-rc.2', gateway: GATEWAY_REF_020, status: 'pending', needsLegacyPeerDeps: true })
  assert.equal(pairStatus('0.1.5-rc.2'), 'verified')
  assert.equal(pairStatus('0.1.1-rc.2'), null)
  assert.equal(resolvePair('0.9.9'), null)
})

test('0.2.0 corridor: the facade ref is per-row -- legacy lines stay on b592b4f, the 0.2.0 line pins 398ea94 (facade v0.2.5)', () => {
  // A pre-corridor facade on a 0.2.0 host kills the answerer pump silently (3-arg wireStream.open,
  // dsh-facts §18.2): question/approval cards hang forever. 0.2.0 hosts require facade >= 0.2.4;
  // v0.2.5 is pinned because it also restores the assistant/chunk typewriter (§18.13).
  assert.equal(GATEWAY_REF, 'github:litestartup-com/dsh-api-gateway#b592b4f')
  assert.equal(GATEWAY_REF_020, 'github:litestartup-com/dsh-api-gateway#398ea94')
  assert.equal(resolvePair('0.1.2-rc.1')?.gateway, GATEWAY_REF)
  assert.equal(resolvePair('0.1.5-rc.2')?.gateway, GATEWAY_REF)
  assert.equal(resolvePair('0.2.0-rc.2')?.gateway, GATEWAY_REF_020)
})

test('0.2.0 corridor: isLegacyDshLine gates the settings.yaml/patchReload era -- the prerelease dash must match (dsh-facts §18.10)', () => {
  // The §18.10 crash-loop: a `0.1.5.*`-style pattern silently misses "0.1.5-rc.2" (DASH after the
  // patch number), dropping patchReload and boot-crashing the legacy line. The gate must accept
  // both the dash and the dot spelling.
  assert.equal(isLegacyDshLine('0.1.2-rc.1'), true)
  assert.equal(isLegacyDshLine('0.1.5-rc.2'), true)
  assert.equal(isLegacyDshLine('0.1.5'), true, 'a hypothetical dot-spelling release of the same line')
  assert.equal(isLegacyDshLine('0.2.0-rc.2'), false)
  assert.equal(isLegacyDshLine('0.1.7-rc.1'), false, 'the corridor starts at 0.1.7 -- new manifest contract, no patchReload (J1-15)')
  assert.equal(isLegacyDshLine('0.1.55'), false, 'no prefix-collision with the 0.1.5 line')
  assert.equal(isLegacyDshLine('v0.1.5-rc.2'), true, 'v prefix tolerated like resolvePair')
})

test('Debt P3 regression: dshCompatible is now a matrix lookup (tolerating a v prefix)', () => {
  assert.equal(dshCompatible('0.1.2-rc.1'), true)
  assert.equal(dshCompatible('0.1.5-rc.2'), true)
  assert.equal(dshCompatible('0.2.0-rc.2'), true)
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
