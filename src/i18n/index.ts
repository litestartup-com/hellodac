import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * i18n (DAC v1.0.0): English by default, Chinese switchable, adding a language = drop in a JSON file + register one line.
 *
 * Three rules live in the types and the tests rather than in a document:
 * 1. `en.json` is the baseline: every other language must have exactly the same key set (asserted by i18n.test.ts;
 *    a missing or an extra key counts as a release incident -- a half-translated language is worse than none).
 * 2. Page templates and the server both use `t()` from here; the **client** does not reimplement it, it only consumes
 *    the injected dictionary (`dictionaryFor` serialized into the page).
 * 3. A missing key shows the key name in the UI (`nav.nodes` rather than a blank), which together with the assertion
 *    keeps it out of a release; an unknown language tag falls back to the baseline instead of throwing -- browsers send anything.
 */

const here = dirname(fileURLToPath(import.meta.url))

/** Supported languages. To add one: add `locales/<tag>.json`, then add it to this array. */
export const LOCALES = ['en', 'zh-CN'] as const
export type Locale = (typeof LOCALES)[number]

/** Baseline language = fallback language = the source of truth for the key set. */
export const DEFAULT_LOCALE: Locale = 'en'

/** Cookie name for the language preference (changing it = everyone loses their preference, so a test pins it). */
export const LOCALE_COOKIE = 'dac_lang'

export type Dictionary = Record<string, string>

const load = (locale: Locale): Dictionary =>
  JSON.parse(readFileSync(join(here, 'locales', `${locale}.json`), 'utf8')) as Dictionary

const dictionaries = new Map<Locale, Dictionary>(LOCALES.map((locale) => [locale, load(locale)]))

/** The dictionary for one language (used for client injection and by tests). */
export const dictionary = (locale: Locale): Dictionary => dictionaries.get(locale) ?? {}

export const isLocale = (value: unknown): value is Locale =>
  typeof value === 'string' && (LOCALES as readonly string[]).includes(value)

/**
 * Translate. `{name}` style interpolation; a missing parameter keeps the placeholder and never produces "undefined".
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

/** Accept-Language -> a language we support (both zh-Hans-CN and zh;q=0.9 map to zh-CN). */
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
 * Language resolution order: `?lang=` -> cookie -> `Accept-Language` -> default.
 * Invalid values are simply ignored (never echoed back, never an error).
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
