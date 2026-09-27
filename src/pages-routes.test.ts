import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 页面注册与路由注册必须一一对应。
 *
 * 事故（2026-09-27）：`keys` 页在 pages.ts 里定义好了、资源也构建进 dist 了，
 * 但 index.ts 里忘了写 `app.get('/keys', …, page('keys'))`——于是 `/keys` 直接 404
 * （而 `/api/keys` 正常），用户点界面才发现。页面登记是两份手写清单，必须有守卫。
 *
 * 静态检查两侧：pages.ts 的 PAGES 键 ↔ index.ts 的 `page('<key>')` 调用。
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pagesSrc = readFileSync(join(root, 'src/pages.ts'), 'utf8')
const indexSrc = readFileSync(join(root, 'src/index.ts'), 'utf8')

/** PAGES 对象里的顶层键（形如 `  skills: {`）。 */
const declaredPages = (): string[] => {
  const start = pagesSrc.indexOf('const PAGES')
  assert.ok(start >= 0, 'pages.ts 里找不到 PAGES')
  const body = pagesSrc.slice(start, pagesSrc.indexOf('\n}', start))
  return [...body.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*): \{/gm)].map((m) => m[1] ?? '')
}

/** index.ts 里 `page('<name>')` 的调用名。 */
const routedPages = (): string[] => [...indexSrc.matchAll(/page\('([a-zA-Z][a-zA-Z0-9]*)'\)/g)].map((m) => m[1] ?? '')

test('每个页面定义都有对应路由（漏注册 = 页面 404，而 API 正常，最难查）', () => {
  const declared = declaredPages()
  const routed = routedPages()
  assert.ok(declared.length >= 8, `PAGES 解析结果异常（只解析到 ${declared.length} 个）`)

  const missing = declared.filter((name) => !routed.includes(name))
  assert.deepEqual(missing, [], `这些页面有定义但没有路由：${missing.join(', ')}`)
})

test('每条页面路由都指向已定义的页面（笔误 = 404）', () => {
  const declared = declaredPages()
  const unknown = [...new Set(routedPages())].filter((name) => !declared.includes(name))
  assert.deepEqual(unknown, [], `这些路由指向不存在的页面：${unknown.join(', ')}`)
})
