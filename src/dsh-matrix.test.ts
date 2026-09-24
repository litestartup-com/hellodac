import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  COMPAT_DSH_VERSION, GATEWAY_REF, SUPPORTED_DSH,
  defaultDshVersion, resolvePair, pairStatus, isSupportedDsh, dshCompatible,
  _setMatrixForTest, _resetMatrixForTest,
} from './dsh-matrix.js'

test('债务 P3 回归: 默认版本 = 矩阵首行；两行 0.1.2-rc.1 + 0.1.5-rc.2 均已 verified', () => {
  assert.equal(COMPAT_DSH_VERSION, '0.1.2-rc.1')
  assert.equal(defaultDshVersion(), '0.1.2-rc.1')
  assert.deepEqual(SUPPORTED_DSH.map((p) => p.dsh), ['0.1.2-rc.1', '0.1.5-rc.2'])
  assert.equal(SUPPORTED_DSH[0]?.status, 'verified')
  assert.equal(SUPPORTED_DSH[1]?.status, 'verified', 'P3 smoke 全链通过后升级')
  assert.equal(SUPPORTED_DSH[0]?.needsLegacyPeerDeps, undefined, '0.1.2 不需要 --legacy-peer-deps')
  assert.equal(SUPPORTED_DSH[1]?.needsLegacyPeerDeps, true, '0.1.5 安装必须带 --legacy-peer-deps（dsh-facts §12）')
})

test('债务 P3 回归: resolvePair / pairStatus——已知配对回矩阵行，未知回 null', () => {
  assert.deepEqual(resolvePair('0.1.2-rc.1'), { dsh: '0.1.2-rc.1', gateway: GATEWAY_REF, status: 'verified' })
  assert.equal(pairStatus('0.1.5-rc.2'), 'verified')
  assert.equal(pairStatus('0.1.1-rc.2'), null)
  assert.equal(resolvePair('0.9.9'), null)
})

test('债务 P3 回归: dshCompatible 升级为矩阵内判断（v 前缀容忍）', () => {
  assert.equal(dshCompatible('0.1.2-rc.1'), true)
  assert.equal(dshCompatible('0.1.5-rc.2'), true)
  assert.equal(dshCompatible('v0.1.2-rc.1'), true, 'v 前缀容忍')
  assert.equal(dshCompatible('0.1.1-rc.2'), false)
  assert.equal(dshCompatible(null), false)
  assert.equal(isSupportedDsh('0.1.5-rc.2'), true)
})

test('债务 P3: 测试注入缝 _setMatrixForTest 生效且可复位（pending 黄字路径的覆盖来源）', () => {
  _setMatrixForTest([{ dsh: '0.1.6-rc.9', gateway: GATEWAY_REF, status: 'pending' }])
  try {
    assert.equal(pairStatus('0.1.6-rc.9'), 'pending')
    assert.equal(pairStatus('0.1.5-rc.2'), null, '覆盖后真实矩阵行不可见')
    assert.equal(dshCompatible('0.1.6-rc.9'), true, 'pending 仍在矩阵语义内')
  } finally {
    _resetMatrixForTest()
  }
  assert.equal(pairStatus('0.1.5-rc.2'), 'verified', '复位后回真实矩阵')
  assert.equal(pairStatus('0.1.6-rc.9'), null)
})
