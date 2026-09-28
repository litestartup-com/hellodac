import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_LOCALE, LOCALES, LOCALE_COOKIE, dictionary, resolveLocale, t } from './index.js'

test('i18n: every language has exactly the base language key set (a missing or extra key is a release accident)', () => {
  const base = Object.keys(dictionary(DEFAULT_LOCALE)).sort()
  assert.ok(base.length > 0, 'the base language cannot be an empty dictionary')
  for (const locale of LOCALES) {
    const keys = Object.keys(dictionary(locale)).sort()
    const missing = base.filter((k) => !keys.includes(k))
    const extra = keys.filter((k) => !base.includes(k))
    assert.deepEqual(missing, [], `${locale} is missing keys`)
    assert.deepEqual(extra, [], `${locale} has keys the base language lacks`)
  }
})

test('i18n: no value may be empty, and placeholders match across languages', () => {
  const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
  for (const locale of LOCALES) {
    for (const [key, value] of Object.entries(dictionary(locale))) {
      assert.notEqual(value.trim(), '', `${locale}:${key} is empty`)
      if (locale === DEFAULT_LOCALE) continue
      assert.deepEqual(placeholders(value), placeholders(dictionary(DEFAULT_LOCALE)[key] ?? ''), `${locale}:${key} placeholders differ from the base language`)
    }
  }
})

test('i18n: t() looks up, interpolates, and makes a missing key visible', () => {
  assert.equal(t('nav.nodes', 'en'), 'Nodes')
  assert.equal(t('nav.nodes', 'zh-CN'), '节点')
  assert.equal(t('nav.nodes', 'zh-CN', undefined), '节点')
  // A missing key returns the key name, visible right in the UI; with the key-set assertion above, it cannot ship.
  assert.equal(t('nope.missing', 'en'), 'nope.missing')
  // An unknown language falls back to the base language instead of throwing (a browser can send any tag).
  assert.equal(t('nav.nodes', 'de' as never), 'Nodes')
  // Interpolation: the {name} form; with the argument missing the text stays as is (never 'undefined').
  const interpolated = t('nodes.count', 'en', { live: 3, total: 5 })
  assert.ok(!interpolated.includes('{'), `no placeholder may survive interpolation: ${interpolated}`)
  assert.match(interpolated, /3/)
  assert.match(interpolated, /5/)
})

test('i18n: language resolution order ?lang -> cookie -> Accept-Language -> default', () => {
  assert.equal(resolveLocale({ query: 'zh-CN', cookie: 'en', accept: 'en-US' }), 'zh-CN')
  assert.equal(resolveLocale({ cookie: 'zh-CN', accept: 'en-US' }), 'zh-CN')
  assert.equal(resolveLocale({ accept: 'zh-CN,zh;q=0.9,en;q=0.8' }), 'zh-CN')
  assert.equal(resolveLocale({ accept: 'zh-Hans-CN,zh;q=0.9' }), 'zh-CN')
  assert.equal(resolveLocale({ accept: 'fr-FR,fr;q=0.9' }), DEFAULT_LOCALE)
  assert.equal(resolveLocale({}), DEFAULT_LOCALE)
  // An invalid value is always ignored; garbage in the query must not throw.
  assert.equal(resolveLocale({ query: '../../etc/passwd', cookie: 'zh-CN' }), 'zh-CN')
  assert.equal(resolveLocale({ query: ['zh-CN'] }), DEFAULT_LOCALE)
})

test('i18n: the language cookie name is stable (changing it loses everyone\'s preference)', () => {
  assert.equal(LOCALE_COOKIE, 'dac_lang')
})
