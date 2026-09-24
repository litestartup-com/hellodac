import assert from 'node:assert/strict'
import test from 'node:test'
import { csrfToken, money, moneyAdaptive, uniqueFrames } from './ui.js'

test('a live snapshot and its buffered copy produce one user frame', () => {
  const user = { kind: 'user', text: '你好', at: 1 }
  assert.deepEqual(uniqueFrames([user, { ...user }]), [user])
})

// 债务 F8:前端测试补课——money 全站单一实现(债务 F2)的精度行为直测。
test('债务 F2 回归: money 默认 4 位小数,digits 参数给紧凑卡片', () => {
  assert.equal(money(12_340_000), '$12.3400')
  assert.equal(money(12_340_000, 2), '$12.34')
  assert.equal(money(null), '—')
})

test('债务 F2 回归: moneyAdaptive 按量级自适应精度(几分钱不显示成 $0.00)', () => {
  assert.equal(moneyAdaptive(0), '$0')
  assert.equal(moneyAdaptive(5_000), '$0.0050')
  assert.equal(moneyAdaptive(500_000), '$0.500')
  assert.equal(moneyAdaptive(12_340_000), '$12.34')
  assert.equal(moneyAdaptive(null), '—')
})

// B2 更名后 cookie 名统一为 `dac_csrf`：过渡期的双读回退已随生产 cutover（2026-09-24）
// 删除。这里守的是「只认这一个名字」——用一个无关名字验证其余一律不认。
// 注意：**故意不在测试里写更名前那个名字**——仓库里不允许再出现旧品牌串
// （release:check 的「旧品牌名已清零」是硬门禁），而实现只做单名匹配，不需要旧名样本。
test('csrfToken 只认 dac_csrf；其余 cookie 名一律不认', () => {
  const withCookie = (cookie) => {
    globalThis.document = { cookie }
    return csrfToken()
  }
  assert.equal(withCookie('dac_csrf=new-token'), 'new-token', '新名必须命中')
  assert.equal(
    withCookie('mgr_sid=abc; dac_csrf=new-token; theme=dark'),
    'new-token',
    'cookie 串中间也要能取到',
  )
  assert.equal(withCookie('other_csrf=stale-token'), '', '别的名字不认（无双读回退）')
  assert.equal(withCookie('mgr_sid=abc'), '', '都没有则空串（服务端 403 自愈补发）')
  delete globalThis.document
})
