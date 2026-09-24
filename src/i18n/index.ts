import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 多语言（DAC v1.0.0）：默认英文，中文可切，加语言 = 丢一个 JSON + 注册一行。
 *
 * 三条纪律写在类型与测试里，而不是文档里：
 * 1. `en.json` 是基准：其它语言的键集合必须与它完全一致（i18n.test.ts 断言，
 *    缺键/多键都当成发布事故——半截语言比没有语言更糟）。
 * 2. 页面模板与服务端都用这里的 `t()`；**客户端**不重复实现，只消费注入的
 *    字典（`dictionaryFor` 序列化进页面）。
 * 3. 缺键在界面上直接显示键名（`nav.nodes` 而不是空白），配合断言它进不了发布；
 *    未知语言标签回退基准语言而不是抛错——浏览器什么标签都可能送来。
 */

const here = dirname(fileURLToPath(import.meta.url))

/** 支持的语言。新增语言时：加 `locales/<tag>.json`，再加到这个数组。 */
export const LOCALES = ['en', 'zh-CN'] as const
export type Locale = (typeof LOCALES)[number]

/** 基准语言 = 兜底语言 = 键集合的真相源。 */
export const DEFAULT_LOCALE: Locale = 'en'

/** 语言偏好的 cookie 名（改它 = 所有人的语言偏好丢失，所以有测试钉住）。 */
export const LOCALE_COOKIE = 'dac_lang'

export type Dictionary = Record<string, string>

const load = (locale: Locale): Dictionary =>
  JSON.parse(readFileSync(join(here, 'locales', `${locale}.json`), 'utf8')) as Dictionary

const dictionaries = new Map<Locale, Dictionary>(LOCALES.map((locale) => [locale, load(locale)]))

/** 某语言的字典（客户端注入与测试用）。 */
export const dictionary = (locale: Locale): Dictionary => dictionaries.get(locale) ?? {}

export const isLocale = (value: unknown): value is Locale =>
  typeof value === 'string' && (LOCALES as readonly string[]).includes(value)

/**
 * 翻译。`{name}` 形式插值；缺参数时保留原文，绝不产生 "undefined"。
 */
export const t = (
  key: string,
  locale: Locale = DEFAULT_LOCALE,
  params?: Record<string, string | number>,
): string => {
  const dict = dictionaries.get(locale)
  const raw = dict?.[key] ?? dictionaries.get(DEFAULT_LOCALE)?.[key] ?? key
  if (params === undefined) return raw
  return raw.replace(/\{(\w+)\}/g, (whole, name: string) =>
    params[name] === undefined ? whole : String(params[name]),
  )
}

/** Accept-Language → 我们支持的语言（zh-Hans-CN / zh;q=0.9 都归到 zh-CN）。 */
const fromAcceptLanguage = (accept: string): Locale | null => {
  for (const part of accept.split(',')) {
    const tag = part.split(';')[0]?.trim().toLowerCase() ?? ''
    if (tag === '') continue
    if (tag === 'zh' || tag.startsWith('zh-')) return 'zh-CN'
    if (tag === 'en' || tag.startsWith('en-')) return 'en'
  }
  return null
}

/**
 * 语言判定优先级：`?lang=` → cookie → `Accept-Language` → 默认。
 * 非法值一律忽略（不回显、不报错）。
 */
export const resolveLocale = (input: {
  query?: unknown
  cookie?: string | undefined
  accept?: string | undefined
}): Locale => {
  if (isLocale(input.query)) return input.query
  if (isLocale(input.cookie)) return input.cookie
  if (typeof input.accept === 'string' && input.accept !== '') {
    const fromHeader = fromAcceptLanguage(input.accept)
    if (fromHeader !== null) return fromHeader
  }
  return DEFAULT_LOCALE
}
