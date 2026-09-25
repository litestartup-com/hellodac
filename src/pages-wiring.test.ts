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

/**
 * 图标守卫：menuItemHtml({ icon }) / `<use href="#i-x">` 的图标名必须在图标精灵里有定义。
 *
 * 为什么值得一条断言：图标名写错**不报错**，`<use href="#i-typo">` 只是渲染不出东西，
 * 页面上留一个空白图标位——「菜单看起来没做完」的典型成因，而且只有肉眼能发现。
 * 上次删图标时正是先查了这份清单，才发现 stop/restart/tag 这些名字根本不存在
 * （差点凑出四个错图标），所以把检查固化下来。
 */
test('接线守卫: 代码引用的图标名都在图标精灵里存在', () => {
  const sprite = new Set([...readFileSync(join(publicDir, 'layout.html'), 'utf8').matchAll(/id="i-([a-z0-9-]+)"/g)].map((m) => m[1]))
  assert.ok(sprite.size > 20, `图标精灵解析异常（只拿到 ${sprite.size} 个）`)

  const offenders: string[] = []
  for (const file of ['shell.js', 'node-row.js', 'nodes.js']) {
    const text = readFileSync(join(publicDir, 'assets', file), 'utf8')
    for (const m of text.matchAll(/\bicon:\s*'([^']+)'/g)) {
      if (!sprite.has(m[1] as string)) offenders.push(`${file}: icon '${m[1]}'`)
    }
    for (const m of text.matchAll(/href="#i-([a-z0-9-]+)"/g)) {
      if (!sprite.has(m[1] as string)) offenders.push(`${file}: #i-${m[1]}`)
    }
  }
  assert.deepEqual(offenders, [], `这些图标名不存在（会渲染成空白图标位且不报错）：\n  ${offenders.join('\n  ')}`)
})

/**
 * 品牌副行按语言渲染（2026-09-26）：`brand.sub` 进 i18n 字典后，侧栏那句
 * DISPATCHED AGENT CLUSTER 必须随语言切换——如果 layout 还留着旧的
 * `{{BRAND_SUB}}` 占位符（或字典缺键），这里会以键名/英文出现在中文页。
 */
test('品牌副行按语言渲染（en / zh-CN 各是各的译文）', () => {
  const expected = { en: 'Dispatched Agent Cluster', 'zh-CN': '统一调度的智能体集群' } as const
  for (const locale of LOCALES) {
    const pages = buildPages(publicDir, locale)
    const m = /<span class="brand-sub">([^<]*)<\/span>/.exec(pages.get('nodes') ?? '')
    assert.equal(m?.[1], expected[locale], `${locale} 的侧栏副行`)
  }
})
