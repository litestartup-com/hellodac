import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_LOCALE, LOCALES, LOCALE_COOKIE, dictionary, resolveLocale, t } from './index.js'

test('i18n: 所有语言与基准语言键集合完全一致（缺键/多键都是发布事故）', () => {
  const base = Object.keys(dictionary(DEFAULT_LOCALE)).sort()
  assert.ok(base.length > 0, '基准语言不能是空字典')
  for (const locale of LOCALES) {
    const keys = Object.keys(dictionary(locale)).sort()
    const missing = base.filter((k) => !keys.includes(k))
    const extra = keys.filter((k) => !base.includes(k))
    assert.deepEqual(missing, [], `${locale} 缺少键`)
    assert.deepEqual(extra, [], `${locale} 多出基准语言没有的键`)
  }
})

test('i18n: 值不得为空，且占位符在各语言间一致', () => {
  const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
  for (const locale of LOCALES) {
    for (const [key, value] of Object.entries(dictionary(locale))) {
      assert.notEqual(value.trim(), '', `${locale}:${key} 是空值`)
      if (locale === DEFAULT_LOCALE) continue
      assert.deepEqual(placeholders(value), placeholders(dictionary(DEFAULT_LOCALE)[key] ?? ''), `${locale}:${key} 占位符与基准不一致`)
    }
  }
})

test('i18n: t() 取值、插值、缺键可见', () => {
  assert.equal(t('nav.nodes', 'en'), 'Nodes')
  assert.equal(t('nav.nodes', 'zh-CN'), '节点')
  assert.equal(t('nav.nodes', 'zh-CN', undefined), '节点')
  // 缺键返回键名：界面上直接看得见，配合上面的键一致性断言，缺键进不了发布。
  assert.equal(t('nope.missing', 'en'), 'nope.missing')
  // 未知语言回退基准语言，而不是抛错（浏览器可能送来任意标签）。
  assert.equal(t('nav.nodes', 'de' as never), 'Nodes')
  // 插值：{name} 形式，缺参数时保留原文（不产生 "undefined"）。
  const interpolated = t('nodes.count', 'en', { live: 3, total: 5 })
  assert.ok(!interpolated.includes('{'), `插值后不应残留占位符：${interpolated}`)
  assert.match(interpolated, /3/)
  assert.match(interpolated, /5/)
})

test('i18n: 语言判定优先级 ?lang → cookie → Accept-Language → 默认', () => {
  assert.equal(resolveLocale({ query: 'zh-CN', cookie: 'en', accept: 'en-US' }), 'zh-CN')
  assert.equal(resolveLocale({ cookie: 'zh-CN', accept: 'en-US' }), 'zh-CN')
  assert.equal(resolveLocale({ accept: 'zh-CN,zh;q=0.9,en;q=0.8' }), 'zh-CN')
  assert.equal(resolveLocale({ accept: 'zh-Hans-CN,zh;q=0.9' }), 'zh-CN')
  assert.equal(resolveLocale({ accept: 'fr-FR,fr;q=0.9' }), DEFAULT_LOCALE)
  assert.equal(resolveLocale({}), DEFAULT_LOCALE)
  // 非法值一律忽略，不能因为 query 里塞了垃圾就抛错。
  assert.equal(resolveLocale({ query: '../../etc/passwd', cookie: 'zh-CN' }), 'zh-CN')
  assert.equal(resolveLocale({ query: ['zh-CN'] }), DEFAULT_LOCALE)
})

test('i18n: 语言 cookie 名稳定（改了就是所有人语言偏好丢失）', () => {
  assert.equal(LOCALE_COOKIE, 'dac_lang')
})
