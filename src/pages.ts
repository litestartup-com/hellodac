import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BRAND } from './brand.js'
import { DEFAULT_LOCALE, t as translate, type Locale } from './i18n/index.js'

/**
 * Splices each page's body into one shared frame at boot.
 *
 * Every page used to carry its own copy of the `<head>`, the icon sprite and a
 * 返回 button, and only the dashboard had the sidebar -- so navigating anywhere
 * threw the frame away and handed back a bare document. The frame is the
 * application; the page is the part that differs.
 *
 * Done on the server rather than by injecting the sidebar from JavaScript: the
 * frame is then present in the first byte of HTML, so it cannot flash in after
 * paint, and it stays ordinary markup in an ordinary file instead of a string
 * inside a script.
 *
 * Deliberately *not* a single-page app swapping `<main>` over fetch. The board
 * holds an EventSource and the dashboard two intervals; client-side routing
 * would make tearing those down on every navigation a correctness requirement,
 * and leaking one is invisible until the tab has been open an hour. A full
 * document load costs milliseconds here and has no such failure mode.
 */

export interface PageDef {
  /** Fragment filename under `public/pages`. */
  file: string
  title: string
  /** Page-specific stylesheets, in addition to the shared `style.css`. */
  css: string[]
  /** Page-specific module, if the page needs one beyond the shell. */
  script: string | null
  /**
   * Extra class on `<main class="content">`.
   *
   * The board sets `content-flush` because it supplies its own full-bleed
   * padding and a sticky header, which the standard content padding would
   * inset and break.
   */
  contentClass: string
}

export const PAGES: Record<string, PageDef> = {
  // 页面标题里的产品名来自 src/brand.ts（改品牌/域名只改一处）。
  // `wide` buys these a roomier column than the old home page's reading width:
  // a month of daily bars needs it.
  spend: { file: 'spend.html', title: `{{t:spend.title}} · ${BRAND.name}`, css: ['spend.css'], script: 'spend.js', contentClass: 'wide' },
  // 公开版精简（DAC v1.0.0）：定时任务页已下线——引擎与 /api/crons 保留
  // （内部 API 与未来的调度 UI 可回归），但不再是对外页面。
  // The other half of archiving: without a place to see what was archived, a
  // soft delete is indistinguishable from a real one.
  archive: {
    file: 'archive.html',
    title: `{{t:archive.title}} · ${BRAND.name}`,
    css: [],
    script: 'archive.js',
    contentClass: 'wide',
  },
  // 公开版精简（DAC v1.0.0）：大盘页已下线（UI 删除，后端 src/board/* 与
  // /api/board/*、/api/internal/agents/:id/board 保留——主脑按大盘文件产出）。
  // `content-flush`：the composer is pinned to the bottom of the column, so the
  // page owns its full height and cannot be inset by the standard content padding.
  chat: {
    file: 'chat.html',
    title: `{{t:topbar.chat}} · ${BRAND.name}`,
    // dsw-theme.css 先于 chat.css：DSH web 的整套主题 token（对齐基准）。
    css: ['dsw-theme.css', 'chat.css'],
    script: 'chat.js',
    contentClass: 'content-flush',
  },
  // 蜂群 Q4：节点（fleet）总览——侧栏只留汇总与异常，完整列表在这里。
  nodes: {
    file: 'nodes.html',
    title: `{{t:nodes.title}} · ${BRAND.name}`,
    css: [],
    script: 'nodes.js',
    contentClass: 'wide',
  },
  // UI 收尾 A：全局任务流独立成页（从 /nodes 的「最近任务」迁出并升级为
  // 筛选 + 分页）；主脑派活在这里留痕。
  runs: {
    file: 'runs.html',
    title: `{{t:runs.title}} · ${BRAND.name}`,
    css: [],
    script: 'runs.js',
    contentClass: 'wide',
  },
  // 蜂群 P5.2：技能清单（v1 只读——文件即真相 + 版本对照）。
  skills: {
    file: 'skills.html',
    title: `{{t:skills.title}} · ${BRAND.name}`,
    css: [],
    script: 'skills.js',
    contentClass: 'wide',
  },
  // 蜂群2计划 P3：首登强制改密 + 审计流水
  password: {
    file: 'password.html',
    title: `{{t:password.title}} · ${BRAND.name}`,
    css: [],
    script: 'password.js',
    contentClass: '',
  },
  audit: {
    file: 'audit.html',
    title: `{{t:audit.title}} · ${BRAND.name}`,
    css: [],
    script: 'audit.js',
    contentClass: 'wide',
  },
}

/**
 * 布局里**必须**出现的占位符（buildPages 启动期校验；测试据此拼夹具布局）。
 * 只是「可替换」的占位符（{{TAGLINE}}/{{BRAND_FULL}}）不在此列：它们由页面片段
 * 或独立页按需使用，布局不引用时不该逼着布局保留空位。
 *
 * {{REPO_URL}}/{{HOMEPAGE}} 已移出本清单（2026-09-25）：侧栏底部那个 GitHub 图标
 * 被删除、仓库入口收进 ⋮ → About 之后，布局里再也没有它们的使用者——继续要求
 * 布局保留一个没人用的占位符，只会逼着后来者把一个死标记放回去。
 */
export const PLACEHOLDERS = [
  '{{TITLE}}',
  '{{HEAD}}',
  '{{CONTENT_CLASS}}',
  '{{CONTENT}}',
  '{{SCRIPT}}',
  '{{BRAND}}',
  '{{BRAND_MARK}}',
  '{{BRAND_SUB}}',
  '{{LOCALE}}',
] as const

/**
 * Content hash for every `/assets/...` URL in a page.
 *
 * Without it a stylesheet change is invisible until the browser decides to ask
 * again, and "I changed the CSS but the page did not" is indistinguishable from
 * "my CSS is wrong" -- which cost a real debugging session. Hashing the contents
 * rather than stamping the boot time means the URL only moves when the file
 * actually did, so an unchanged asset stays cached across restarts.
 *
 * This rewrites the whole rendered page, so the layout's own hardcoded
 * `style.css` and `shell.js` are covered by the same pass as the per-page ones.
 * What it cannot reach is one module importing another (`shell.js` importing
 * `./ui.js`), which is why /assets is also served must-revalidate.
 */
const ASSET_URL = /\/assets\/([A-Za-z0-9._-]+\.(?:css|js))/g

const stampAssets = (html: string, publicDir: string): string => {
  const versions = new Map<string, string>()
  return html.replace(ASSET_URL, (whole, file: string) => {
    let version = versions.get(file)
    if (version === undefined) {
      try {
        version = createHash('sha1').update(readFileSync(join(publicDir, 'assets', file))).digest('hex').slice(0, 8)
      } catch {
        // A reference to a file that is not there is a broken page either way;
        // leaving it unversioned keeps the error about the 404, not about this.
        version = ''
      }
      versions.set(file, version)
    }
    return version === '' ? whole : `${whole}?v=${version}`
  })
}

/**
 * Sent with every /assets response.
 *
 * Lives here rather than inline at the registration because that inline version
 * called `res.setHeader` -- @fastify/static hands `setHeaders` a FastifyReply,
 * not a raw ServerResponse, so the server crashed on the first stylesheet
 * request. Nothing caught it: no test had ever fetched an asset. Now this is a
 * named function a test can call.
 *
 * `no-cache` is "keep it, but ask before using it", not "do not keep it": the
 * answer is a 304, not a re-download.
 */
export const assetCacheHeaders = (reply: { header: (name: string, value: string) => unknown }): void => {
  reply.header('cache-control', 'no-cache')
}

/** 模板里的翻译占位符：`{{t:nav.nodes}}`。 */
const TRANSLATION_TOKEN = /\{\{t:([A-Za-z0-9_.-]+)\}\}/g

/**
 * 把 `{{t:key}}` 换成译文。缺键直接抛错——启动期炸掉比在页面上显示键名好，
 * 也比"英文页面里混一句中文"好：布局是每页共用的，一次漏翻影响全站。
 */
const translateTokens = (text: string, locale: Locale): string =>
  text.replace(TRANSLATION_TOKEN, (_whole, key: string) => {
    const value = translate(key, locale)
    if (value === key) throw new Error(`missing i18n key "${key}" (locale ${locale})`)
    return value
  })

const render = (layout: string, def: PageDef, fragment: string, locale: Locale): string => {
  const head = def.css.map((href) => `<link rel="stylesheet" href="/assets/${href}" />`).join('\n    ')
  const script = def.script === null ? '' : `<script src="/assets/${def.script}" type="module"></script>`
  // 翻译先做：片段与布局里的 {{t:...}} 都在这一步收敛，后面只剩框架占位符。
  const localizedLayout = translateTokens(layout, locale)
  const localizedFragment = translateTokens(fragment, locale)
  // 客户端字典（本语言全量，几 KB）：由 /api/i18n/<locale> 提供给 shell.js
  // 与 login.js（CSP 禁内联脚本，不能内嵌到页面里），保证服务端渲染与客户端
  // 动态文案用的是同一份译文。
  return localizedLayout
    // replaceAll：品牌占位符在一个页面里可能出现多次（标题、侧栏、注入脚本），
    // 用 replace 只会换掉第一处——2026-09-24 实测踩到（spend 页残留 {{BRAND}}）。
    .replaceAll('{{TITLE}}', translateTokens(def.title, locale))
    .replaceAll('{{HEAD}}', head)
    .replaceAll('{{CONTENT_CLASS}}', def.contentClass)
    // 品牌占位符（DAC v1.0.0）：产品名/仓库/站点来自 src/brand.ts，页面里
    // 不散写 URL（改域名只改一处）。
    .replaceAll('{{BRAND}}', BRAND.name)
    .replaceAll('{{BRAND_MARK}}', BRAND.mark)
    .replaceAll('{{BRAND_SUB}}', BRAND.sub)
    .replaceAll('{{BRAND_FULL}}', BRAND.fullName)
    .replaceAll('{{TAGLINE}}', BRAND.tagline)
    .replaceAll('{{LOCALE}}', locale)
    // Last, and via a function: a fragment containing `$&` or `$1` would
    // otherwise be interpreted as a replacement pattern and silently mangled.
    .replace('{{CONTENT}}', () => localizedFragment)
    .replaceAll('{{SCRIPT}}', script)
}

/**
 * Builds every page once, for one locale.
 *
 * Rendering at boot rather than per request means a missing fragment, a renamed
 * placeholder or a missing i18n key fails at startup with a clear message,
 * instead of serving a broken page to whoever happens to open it first.
 *
 * 语言维度也在这里展开（每种语言一套 HTML）：页面是纯静态字符串，按语言预渲染
 * 比每请求模板替换便宜，也不会把「服务端渲染 + 客户端字典」两份译文弄不一致。
 */
export const buildPages = (publicDir: string, locale: Locale = DEFAULT_LOCALE): Map<string, string> => {
  const layout = readFileSync(join(publicDir, 'layout.html'), 'utf8')
  for (const token of PLACEHOLDERS) {
    if (!layout.includes(token)) throw new Error(`layout.html is missing the ${token} placeholder`)
  }

  const out = new Map<string, string>()
  for (const [name, def] of Object.entries(PAGES)) {
    const fragment = readFileSync(join(publicDir, 'pages', def.file), 'utf8')
    const html = stampAssets(render(layout, def, fragment, locale), publicDir)
    // Catches a typo'd placeholder that would otherwise reach the browser as
    // literal braces on the page.
    const leftover = html.match(/\{\{[A-Z_]+\}\}/)
    if (leftover !== null) throw new Error(`page "${name}" still contains ${leftover[0]} after rendering`)
    out.set(name, html)
  }
  return out
}

/** 每种语言一套页面（memo：启动期算一次）。 */
export const buildAllPages = (publicDir: string, locales: readonly Locale[]): Map<Locale, Map<string, string>> => {
  const out = new Map<Locale, Map<string, string>>()
  for (const locale of locales) out.set(locale, buildPages(publicDir, locale))
  return out
}

/**
 * 布局之外的独立页（登录页）也按语言预渲染。
 *
 * 登录页故意不套 layout 的壳：侧栏画的是 agent 数据，而登录时还没有会话可查。
 * 它需要的是同一套译文与品牌占位符，而不是整套框架。
 */
export const buildStandalonePage = (publicDir: string, file: string, locale: Locale): string => {
  const raw = readFileSync(join(publicDir, file), 'utf8')
  const html = translateTokens(raw, locale)
    .replaceAll('{{BRAND}}', BRAND.name)
    .replaceAll('{{BRAND_SUB}}', BRAND.sub)
    .replaceAll('{{BRAND_FULL}}', BRAND.fullName)
    .replaceAll('{{TAGLINE}}', BRAND.tagline)
    .replaceAll('{{LOCALE}}', locale)
  const leftover = html.match(/\{\{[A-Z_]+\}\}/)
  if (leftover !== null) throw new Error(`${file} still contains ${leftover[0]} after rendering (${locale})`)
  return stampAssets(html, publicDir)
}
