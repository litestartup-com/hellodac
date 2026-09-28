// Dictionary injection for the frontend tests (DAC v1.0.0).
//
// Unit tests run under Node: there is no page and no /api/i18n, so loadI18n() in ui.js gets no dictionary and
// t() returns key names -- a test asserting text would then assert nothing at all. This reads the locale files
// under src and injects them, so the assertions hit **the translations a user actually sees**.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { useDictionary } from './ui.js'

const here = dirname(fileURLToPath(import.meta.url))

/** Read a locale file (relative to the manager repository root). */
export const testDictionary = (locale = 'en') =>
  JSON.parse(readFileSync(join(here, '..', '..', 'src', 'i18n', 'locales', `${locale}.json`), 'utf8'))

/** Inject the locale and return the literal dictionary, which makes assertions straightforward. */
export const useTestDictionary = (locale = 'en') => {
  const dict = testDictionary(locale)
  useDictionary(locale, dict)
  return dict
}
