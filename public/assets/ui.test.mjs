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

// B2 更名过渡：cookie 名 `ohdsh_csrf` → `dac_csrf`。前端静态资源按请求从磁盘读，
// 后端却在已构建的 dist 里，两边不同步会让写操作全 403——所以新旧都读、新名优先。
// 旧名是过渡期字符串，已进 scripts/rename-to-dac.mjs 保护表，勿手改。
test('B2 过渡回归: csrfToken 新名优先, 旧名可回退, 都没有则空串', () => {
  const withCookie = (cookie) => {
    globalThis.document = { cookie }
    return csrfToken()
  }
  assert.equal(withCookie('dac_csrf=new-token'), 'new-token', '新名必须命中')
  assert.equal(withCookie('ohdsh_csrf=old-token'), 'old-token', '旧后端只种旧名 → 回退命中')
  assert.equal(
    withCookie('ohdsh_csrf=old-token; dac_csrf=new-token'),
    'new-token',
    '两个都在时必须用新名（否则新后端校验不通过）',
  )
  assert.equal(
    withCookie('mgr_sid=abc; dac_csrf=new-token; theme=dark'),
    'new-token',
    'cookie 串中间也要能取到',
  )
  assert.equal(withCookie('mgr_sid=abc'), '', '都没有则空串（服务端 403 自愈补发）')
  delete globalThis.document
})
