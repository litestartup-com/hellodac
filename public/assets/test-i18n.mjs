// 前端测试的字典注入（DAC v1.0.0）。
//
// 单测跑在 Node 里：没有页面、也没有 /api/i18n，ui.js 的 loadI18n() 拿不到字典，
// t() 只会返回键名——那样断言文案的测试等于没测。这里直接把 src 下的语言包读进来
// 注入，测试断言的就是**用户真正看到的译文**。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { useDictionary } from './ui.js'

const here = dirname(fileURLToPath(import.meta.url))

/** 读语言包（相对 manager 仓库根）。 */
export const testDictionary = (locale = 'en') =>
  JSON.parse(readFileSync(join(here, '..', '..', 'src', 'i18n', 'locales', `${locale}.json`), 'utf8'))

/** 注入语言包，返回逐字字典便于断言。 */
export const useTestDictionary = (locale = 'en') => {
  const dict = testDictionary(locale)
  useDictionary(locale, dict)
  return dict
}
