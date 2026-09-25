import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPages, buildStandalonePage, PAGES } from './pages.js'
import { LOCALES } from './i18n/index.js'

/**
 * 接线守卫：页面脚本里 $(...) / getElementById(...) 引用的 id，必须在**真正下发到
 * 浏览器的页面**里存在。
 *
 * 为什么必须校验构建产物，而不是扫 pages/*.html 的模板文本（2026-09-25 实测踩坑）：
 *   `buildPages()` 在**启动时**把片段拼进页面缓存，而 `/assets/*` 是每请求读盘。
 *   于是「改了片段但没重启 manager」会让浏览器拿到**新 JS + 旧标记**——新脚本去绑
 *   一个旧页面里不存在的元素：
 *       Uncaught TypeError: Cannot read properties of null (reading 'addEventListener')
 *   只扫模板文本的守卫对这种情况是绿的（模板里明明有），等于放行。
 *   这里直接把 buildPages 的产物拉出来校验，同一类问题就在单测阶段被拦下。
 *
 * 补充：这条断言校验的是「产物自洽」。产物本身的新鲜度仍取决于重启——
 * 部署纪律见 docs/RELEASE.md（改 pages/*.html 必须重启，改 assets/* 不必）。
 */
const here = dirname(fileURLToPath(import.meta.url))
const publicDir = join(here, '..', 'public')

/**
 * 由 JS 自己拼出来的 id：不在页面里，显式登记。
 * 写死而不是宽泛放行——新增动态 id 时必须有人想一下它归哪一类。
 */
const DYNAMIC = [
  /^node-menu-/, // node-row.js：每个节点一个主菜单浮层
  /^node-version-menu-/, // node-row.js：版本子菜单浮层
  /^node-more-/, // node-row.js：⋮ 触发器
  /^machines-revoked/, // nodes.js：已吊销机器折叠区
  /^dac-/, // 通用前缀
  /^nodes-link$/, // shell.js 侧栏导航项（来自 PRIMARY_NAV）
  /^nodes-hint$/,
  /^spend-hint$/,
  /^archive-hint$/,
  /^logout$/, // shell.js：溢出菜单里的登出按钮
]

/** 侧栏脚本：每一页都会加载，所以它的引用要在每一页里都能找到。 */
const SHELL_SCRIPTS = ['shell.js']

const idsReferencedBy = (file: string): Set<string> => {
  const text = readFileSync(join(publicDir, 'assets', file), 'utf8')
  const ids = new Set<string>()
  for (const m of text.matchAll(/\$\(\s*'([A-Za-z0-9_-]+)'\s*\)/g)) ids.add(m[1] as string)
  for (const m of text.matchAll(/getElementById\(\s*'([A-Za-z0-9_-]+)'\s*\)/g)) ids.add(m[1] as string)
  return ids
}

test('接线守卫: 每页脚本引用的 DOM id 都出现在该页的构建产物里', () => {
  const pages = buildPages(publicDir, LOCALES[0])
  const isDynamic = (id: string): boolean => DYNAMIC.some((re) => re.test(id))
  const missing: string[] = []

  for (const [name, def] of Object.entries(PAGES)) {
    const html = pages.get(name)
    assert.ok(html !== undefined, `页面 ${name} 没构建出来`)
    const declared = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]))
    assert.ok(declared.size > 40, `页面 ${name} 的 id 解析异常（只拿到 ${declared.size} 个）`)

    // 这一页自己加载的脚本 + 每页都有的 shell 脚本。
    const scripts = [...SHELL_SCRIPTS, ...(def.script === null ? [] : [def.script])]
    for (const file of scripts) {
      for (const id of idsReferencedBy(file)) {
        if (!declared.has(id) && !isDynamic(id)) missing.push(`${name} ← ${file}: #${id}`)
      }
    }
  }

  const unique = [...new Set(missing)]
  assert.deepEqual(unique, [], `这些 id 在页面里不存在（浏览器里点到才会炸）：\n  ${unique.join('\n  ')}`)
})

test('接线守卫: 登录页(独立页)引用的 DOM id 也存在', () => {
  const html = buildStandalonePage(publicDir, 'login.html', LOCALES[0])
  const declared = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]))
  const missing = [...idsReferencedBy('login.js')].filter((id) => !declared.has(id) && !DYNAMIC.some((re) => re.test(id)))
  assert.deepEqual(missing, [], `login.js 引用了登录页里不存在的 id：${missing.join(', ')}`)
})
