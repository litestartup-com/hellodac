// @ts-check
// Helpers shared by every page.
//
// These existed in four copies, one per page script, which had already drifted:
// two spellings of esc(), two of bannerHtml(), two money formatters. One copy is
// also what makes the page scripts modules -- as classic scripts they shared one
// global scope, so a second `const esc` was a hard SyntaxError.
//
// 债务 F7 第一步:本文件开启 @ts-check + JSDoc,由 tsconfig.public.json 在
// CI typecheck 中检查(不引入 esbuild 构建,尊重 ui-redesign §6 口径)。

/** @type {Record<string, string>} */
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/**
 * Escapes everything before it reaches the DOM.
 *
 * The data is written by an agent that reads mail, web pages and dictation, so
 * any field is attacker-influenced text. Unescaped, one crafted note becomes
 * stored XSS on manager's own origin -- the origin holding the session cookie.
 * @param {unknown} value
 * @returns {string}
 */
export const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch)

/** @param {string} id @returns {HTMLElement | null} */
export const $ = (id) => document.getElementById(id)

// ---------------------------------------------------------------------------
// 多语言（DAC v1.0.0）
//
// 静态页面由服务端按语言预渲染；这里的 t() 只服务**动态文案**（表格行、确认框、
// 提示）。字典不内嵌在页面里（CSP `script-src 'self'` 禁内联脚本），启动时从
// /api/i18n/<lang> 取一次——语言标签就在 <html lang> 上，服务端已写好。
// 页面模块用 `await loadI18n()` 保证首屏渲染前字典就位，不要先画键名再补译文。
// ---------------------------------------------------------------------------

/** @type {Record<string, string>} */
let dict = {}
/** @type {string[]} */
let locales = []
let locale = typeof document === 'undefined' ? 'en' : document.documentElement.lang || 'en'
/** @type {null | { name?: string, full?: string, fullName?: string, tagline?: string, repo?: string, repoUrl?: string, site?: string, homepage?: string, supportEmail?: string }} */
let brand = null
/** @type {Promise<void> | null} */
let loading = null

/**
 * 取一次字典与品牌信息（并发调用共享同一个 Promise）。
 * 失败不抛：页面仍能用服务端渲染好的静态文案，动态文案回退键名。
 * @returns {Promise<void>}
 */
export const loadI18n = () => {
  if (loading !== null) return loading
  const target = typeof document === 'undefined' ? 'en' : document.documentElement.lang || 'en'
  loading = fetch(`/api/i18n/${encodeURIComponent(target)}`)
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (data === null) return
      locale = typeof data.locale === 'string' ? data.locale : target
      dict = data.dict ?? {}
      locales = Array.isArray(data.locales) ? data.locales : []
      brand = data.brand ?? null
    })
    .catch(() => {
      // 离线/后端未起：保持空字典，界面用键名或服务端文案，不炸页面。
    })
  return loading
}

/**
 * 品牌信息（/api/i18n 提供；未就绪时给安全缺省，避免调用方到处判空）。
 *
 * 字段名在这里**归一化**：服务端 `src/brand.ts` 是 `repoUrl`/`homepage`/`fullName`
 * （与 pages.ts 占位符同源），而调用方（shell.js 等）历史上一直用 `repo`/`site`/
 * `full`。2026-09-26 实测：不映射的话 `brand.repo` 永远为空 → 「Star on GitHub」
 * 一项**根本不渲染**，用户看到的是整个条目消失，而不是链接坏了。
 */
export const brandInfo = () => {
  if (brand === null) {
    return { name: 'DAC', full: 'Dispatched Agent Cluster', tagline: '', repo: '', site: '', supportEmail: '' }
  }
  return {
    name: typeof brand.name === 'string' ? brand.name : 'DAC',
    full: typeof brand.fullName === 'string' ? brand.fullName : (typeof brand.full === 'string' ? brand.full : ''),
    tagline: typeof brand.tagline === 'string' ? brand.tagline : '',
    repo: typeof brand.repoUrl === 'string' ? brand.repoUrl : (typeof brand.repo === 'string' ? brand.repo : ''),
    site: typeof brand.homepage === 'string' ? brand.homepage : (typeof brand.site === 'string' ? brand.site : ''),
    supportEmail: typeof brand.supportEmail === 'string' ? brand.supportEmail : '',
  }
}

/**
 * 测试注入品牌信息（与 useDictionary 同构；页面运行时走 loadI18n，不经过这里）。
 * @param {null | { name?: string, full?: string, fullName?: string, tagline?: string, repo?: string, repoUrl?: string, site?: string, homepage?: string, supportEmail?: string }} info
 */
export const useBrand = (info) => {
  brand = info
}
/**
 * 直接注入字典（测试与离线预渲染用）。
 *
 * 为什么需要它：单测跑在 Node 里，没有页面、也不该真去 fetch——但断言必须打到
 * **真实译文**上（否则 `t()` 只返回键名，测试等于没测文案）。页面运行时不用这个
 * 入口，走 loadI18n()。
 * @param {string} localeTag
 * @param {Record<string, string>} entries
 */
export const useDictionary = (localeTag, entries) => {
  locale = localeTag
  dict = entries
  loading = Promise.resolve()
}

/** 当前语言与可选语言（语言切换器用）。 */
export const currentLocale = () => locale
export const availableLocales = () => (locales.length > 0 ? locales : [locale])

/**
 * 客户端翻译：`t('nav.nodes')`，`{name}` 插值。缺键返回键名（界面上直接看得见，
 * 配合 CI 的键一致性断言，缺键进不了发布）。
 * @param {string} key
 * @param {Record<string, string | number>} [params]
 * @returns {string}
 */
export const t = (key, params) => {
  const raw = dict[key] ?? key
  if (params === undefined) return raw
  return raw.replace(/\{(\w+)\}/g, (whole, name) => (params[name] === undefined ? whole : String(params[name])))
}

/**
 * process.platform → 可读平台名（未知平台回退原文）。机器行/本机卡共用，
 * 避免 machines 与 topology 各写一份映射漂移。
 * @param {string} os
 * @returns {string}
 */
export const platformLabel = (os) => ({ win32: 'Windows', linux: 'Linux', darwin: 'macOS' }[os] ?? os)

/**
 * @template T
 * @param {T[]} frames
 * @returns {T[]}
 */
export const uniqueFrames = (frames) => {
  /** @type {Set<string>} */
  const seen = new Set()
  return frames.filter((frame) => {
    const key = JSON.stringify(frame)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** @param {string} name @param {number} [size] @returns {string} */
export const icon = (name, size = 14) =>
  // viewBox：sprite 画在 16 单位坐标系里，没有它 16 单位的图标会按 1:1
  // 塞进 12-15px 的盒子——不缩放、还裁掉右边；xlink:href 是老 Edge 内核
  // （EdgeHTML）唯一认的写法，没有它 <use> 整个不画，按钮成了隐形按钮。
  `<svg width="${size}" height="${size}" viewBox="0 0 16 16" aria-hidden="true"><use href="#i-${name}" xlink:href="#i-${name}" /></svg>`

/**
 * Writes only when the markup actually changed.
 *
 * Most polls change nothing. Rewriting innerHTML anyway would move focus off
 * whatever the user had tabbed to and collapse any open native control, every
 * time the timer fires.
 */
/** @type {Map<string, string>} */
const lastHtml = new Map()
/** @param {string} id @param {string} html @returns {void} */
export const setHtml = (id, html) => {
  if (lastHtml.get(id) === html) return
  lastHtml.set(id, html)
  const node = $(id)
  if (node !== null) node.innerHTML = html
}

/**
 * `body` is pre-escaped by the caller, since some banners embed markup.
 * @param {{ level: string; title: string; body: string }} b
 * @returns {string}
 */
export const bannerHtml = (b) => `<div class="banner ${b.level}">
  ${icon('alert', 15)}
  <div><strong>${esc(b.title)}</strong><div class="body">${b.body}</div></div>
</div>`

/**
 * Same call shape as bannerHtml, for the common case of plain text.
 * @param {string} level
 * @param {string} title
 * @param {unknown} body
 * @returns {string}
 */
export const banner = (level, title, body) => bannerHtml({ level, title, body: esc(body) })

// Cost arrives as integer micro-USD so no float is ever stored server-side.
// 债务 F2:money 全站单一实现——`digits` 供紧凑卡片用 2 位(crons 列表),
// 账本/回合明细默认 4 位;汇总金额的自适应精度见 moneyAdaptive。
/**
 * @param {number | null | undefined} micro
 * @param {number} [digits]
 * @returns {string}
 */
export const money = (micro, digits = 4) => (micro === null || micro === undefined ? '—' : `$${(micro / 1e6).toFixed(digits)}`)

/**
 * 汇总金额的自适应精度(债务 F2:收口自 spend.js 的本地变体)。
 * 一个回合花费只有几厘,固定 2 位会把一整天的工作显示成 "$0.00";
 * 固定 4 位又会把月总计显示成 "$12.3400"。
 * @param {number | null | undefined} micro
 * @returns {string}
 */
export const moneyAdaptive = (micro) => {
  if (micro === null || micro === undefined) return '—'
  const usd = micro / 1e6
  if (usd === 0) return '$0'
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  if (usd < 1) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(2)}`
}

/**
 * A relative timestamp, for lists where the question is "which one did I touch
 * last", not "what time was it".
 *
 * Falls back to an absolute date beyond a week: "37 天前" is a number nobody
 * converts back into a day.
 * @param {number | null | undefined} ms
 * @returns {string}
 */
export const ago = (ms) => {
  if (ms === null || ms === undefined) return ''
  const diff = Date.now() - ms
  // Clock skew, or a row written a moment ago by a server a second ahead.
  if (diff < 60_000) return t('time.justNow')
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return t('time.minutesAgo', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('time.hoursAgo', { count: hours })
  const days = Math.floor(hours / 24)
  if (days < 7) return t('time.daysAgo', { count: days })
  // 超过一周显示日期：按当前语言格式化，不再写死 zh-CN。
  return new Date(ms).toLocaleDateString(locale, { month: '2-digit', day: '2-digit' })
}

/** @param {number | null | undefined} ms @returns {string} */
export const when = (ms) =>
  ms === null || ms === undefined
    ? '—'
    : new Date(ms).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })

// ---- 蜂群2计划 P3：CSRF 双提交 ----

/**
 * 登录时服务端种下的 CSRF cookie（非 httpOnly，前端可读）。
 *
 * B2 更名期这里曾同时读更名前那个 cookie 名（前端按请求读盘、后端在已构建的 dist 里，
 * 两边会不同步）；生产 cutover（2026-09-24 13:30，manager + 3 节点全部跑新代码）后
 * 旧名回退已删除——现在只有 `dac_csrf` 一个口径。会话缺 cookie 时服务端 403 并补发，
 * 前端重试一次（见下面的 apiFetch）。
 * @returns {string}
 */
export const csrfToken = () => {
  const match = document.cookie.match(/(?:^|;\s*)dac_csrf=([^;]+)/)
  return match === null ? '' : decodeURIComponent(match[1])
}

/**
 * 全局 fetch 包装：非 GET 请求自动带上 X-CSRF-Token（与 cookie 一致）。
 * 页面脚本一律走它，服务端对所有非 GET /api/* 校验（登录与主脑内部 API 豁免）。
 * 升级自愈：老会话缺 csrf cookie 时服务端 403 并补发 cookie——带新 cookie 重试一次。
 * @param {string} url
 * @param {RequestInit} [options]
 * @returns {Promise<Response>}
 */
export const apiFetch = async (url, options = {}) => {
  const once = () => {
    const token = csrfToken()
    /** @type {Record<string, string>} */
    const headers = {}
    const src = options.headers
    if (src !== undefined && src !== null) {
      if (src instanceof Headers) {
        src.forEach((value, key) => {
          headers[key] = value
        })
      } else if (Array.isArray(src)) {
        for (const [k, v] of src) headers[k] = v
      } else {
        Object.assign(headers, src)
      }
    }
    const method = (options.method ?? 'GET').toUpperCase()
    if (token !== '' && method !== 'GET' && method !== 'HEAD') headers['x-csrf-token'] = token
    return fetch(url, { ...options, method, headers })
  }
  const response = await once()
  if (response.status === 403) {
    try {
      const body = await response.clone().json()
      if (body.error === 'csrf_token_missing_or_mismatch' && csrfToken() !== '') return await once()
    } catch {
      // 非 JSON 的 403：原样返回
    }
  }
  return response
}

/**
 * 债务 F6:统一 Result 层。JSON API 页面一律走它,不再手写
 * "status 判断 + 读 JSON + 拼 banner" 三段样板。
 *
 * 成功 → `{ ok:true, status, data }`;
 * 失败 → `{ ok:false, status, error, detail }`,detail 已是可展示文案
 * (JSON 错误体优先,非 JSON 或异常回退 `HTTP <status>`)。
 *
 * 401 不做跳转——是否跳 /login 是页面的决定(测试页/内嵌页不需要)。
 *
 * @template T
 * @param {string} url
 * @param {RequestInit} [options]
 * @returns {Promise<{ ok: true; status: number; data: T } | { ok: false; status: number; error: string; detail: string }>}
 */
export const apiJson = async (url, options = {}) => {
  const response = await apiFetch(url, options)
  if (response.ok) {
    const data = await response.json().catch(() => null)
    return { ok: true, status: response.status, data }
  }
  let detail = `HTTP ${response.status}`
  let error = 'http_error'
  try {
    const body = await response.clone().json()
    if (body !== null && typeof body === 'object') {
      error = typeof body.error === 'string' ? body.error : error
      detail = typeof body.detail === 'string' && body.detail !== '' ? body.detail : detail
    }
  } catch {
    // 非 JSON 错误体：保留 HTTP 回退文案
  }
  return { ok: false, status: response.status, error, detail }
}

/**
 * 债务 F6:共享失败 banner。`showError(r, title)` 把 Result 渲染成
 * banner 骨架(bannerHtml 同款,detal 自动转义)——页面只需
 * `if (!r.ok) { $('x').innerHTML = showError(r, '…'); return }`,不再手写样板。
 * ok Result 返回空串(调用方可用 `if (r.ok)` 短路,双保险)。
 *
 * @param {{ ok: boolean; status: number; error?: string; detail?: string }} r
 * @param {string} title
 * @returns {string}
 */
export const showError = (r, title) => {
  if (r.ok) return ''
  const detail =
    r.detail !== undefined && r.detail !== ''
      ? r.detail
      : r.error !== undefined && r.error !== '' && r.error !== 'http_error'
        ? r.error
        : `HTTP ${r.status}`
  return banner('bad', title, detail)
}

/**
 * 债务 F3：SSE 自动重连 helper——原先 board.js 与 chat.js 两份逐字相同的
 * retryTimer/retryDelay 机制收敛到此（3s → ×2 → 30s 封顶）。
 * 公开版精简（DAC v1.0.0）：board 页已下线，当前调用方只剩 chat.js。
 *
 * `open()` 由调用方实现：创建 EventSource、挂 message 监听，返回实例。
 * 纪律（两页注释合并）：
 * - EventSource 自己会重试，但服务端直接关流（manager 重启）后不会——
 *   error 时主动退避重连；
 * - error 处理器只关「自己这一条」：旧实例的 handler 会迟到触发，关当前
 *   实例 = 每断一次漏一条连接。
 * @param {() => EventSource} open
 * @param {{ baseDelay?: number; maxDelay?: number }} [opts]
 * @returns {{ connect: () => void; disconnect: () => void }}
 */
export const autoReconnect = (open, { baseDelay = 3_000, maxDelay = 30_000 } = {}) => {
  /** @type {EventSource | null} */
  let source = null
  /** @type {ReturnType<typeof setTimeout> | null} */
  let retryTimer = null
  let retryDelay = baseDelay

  const connect = () => {
    disconnect()
    const es = open()
    source = es

    es.addEventListener('open', () => {
      retryDelay = baseDelay
    })

    es.addEventListener('error', () => {
      es.close()
      if (es !== source) return
      source = null
      retryTimer = setTimeout(connect, retryDelay)
      retryDelay = Math.min(retryDelay * 2, maxDelay)
    })
  }

  const disconnect = () => {
    if (retryTimer !== null) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
    if (source !== null) {
      source.close()
      source = null
    }
  }

  return { connect, disconnect }
}

/**
 * 债务 F4：轮询统一 helper——nodes/skills/shell 各自 setInterval（无失焦
 * 暂停、无错误退避）收敛到此。
 *
 * - `document.hidden` 时挂起（后台标签不浪费请求），恢复可见后按原间隔继续；
 * - fn 抛错时按 interval 退避（×2，上限 10×interval），成功即复位；
 * - 返回停止函数（页面卸载/抽屉关闭时用）。
 * @param {() => unknown} fn
 * @param {number} ms
 * @returns {() => void}
 */
export const poll = (fn, ms) => {
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null
  let delay = ms

  const tick = () => {
    timer = null
    if (typeof document !== 'undefined' && document.hidden) {
      timer = setTimeout(tick, ms)
      return
    }
    // 页面用法是 `poll(() => void load(), ms)`——同步包装;同步抛错也能
    // 退避。真正返回 Promise 的 fn 走 then 链(浏览器场景,测试用同步 fn)。
    try {
      const result = fn()
      if (result !== null && typeof result === 'object' && 'then' in result) {
        /** @type {Promise<unknown>} */
        const pending = /** @type {Promise<unknown>} */ (result)
        pending
          .then(() => {
            delay = ms
          })
          .catch(() => {
            delay = Math.min(delay * 2, ms * 10)
          })
          .finally(() => {
            timer = setTimeout(tick, delay)
          })
        return
      }
      delay = ms
    } catch {
      delay = Math.min(delay * 2, ms * 10)
    }
    timer = setTimeout(tick, delay)
  }

  timer = setTimeout(tick, ms)
  return () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }
}
