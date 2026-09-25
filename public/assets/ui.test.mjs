import assert from 'node:assert/strict'
import test from 'node:test'
import { brandInfo, csrfToken, money, moneyAdaptive, uniqueFrames, useBrand } from './ui.js'

test('a live snapshot and its buffered copy produce one user frame', () => {
  const user = { kind: 'user', text: '你好', at: 1 }
  assert.deepEqual(uniqueFrames([user, { ...user }]), [user])
})

// 事故回归（2026-09-26 用户报「Star on GitHub 项不见了」）：
// 服务端 BRAND 字段是 repoUrl/fullName/homepage，客户端调用方用 repo/full/site。
// brandInfo() 必须做归一化——不映射的话 brand.repo 恒为空，
// shell.js 里 `brand.repo === ''` 直接跳过整项（整个条目消失，不是链接坏了）。
test('事故回归: brandInfo 把服务端字段名映射到客户端旧字段名', () => {
  useBrand({
    name: 'DAC',
    fullName: 'Dispatched Agent Cluster',
    tagline: 'One Manager. A Fleet of Agents.',
    repoUrl: 'https://github.com/litestartup-com/hellodac',
    homepage: 'https://hellodac.com',
    supportEmail: 'support@hellodac.com',
  })
  const b = brandInfo()
  assert.equal(b.repo, 'https://github.com/litestartup-com/hellodac', 'repoUrl → repo（否则 Star on GitHub 不渲染）')
  assert.equal(b.full, 'Dispatched Agent Cluster', 'fullName → full')
  assert.equal(b.site, 'https://hellodac.com', 'homepage → site')
  assert.equal(b.supportEmail, 'support@hellodac.com')
})

test('品牌注入未就绪时 brandInfo 给安全缺省（repo 为空 → About 不含 GitHub 行）', () => {
  useBrand(null)
  const b = brandInfo()
  assert.equal(b.name, 'DAC')
  assert.equal(b.repo, '')
  assert.equal(b.supportEmail, '')
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
