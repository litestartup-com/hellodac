// @ts-check
// Helpers shared by every page.
//
// These existed in four copies, one per page script, which had already drifted:
// two spellings of esc(), two of bannerHtml(), two money formatters. One copy is
// also what makes the page scripts modules -- as classic scripts they shared one
// global scope, so a second `const esc` was a hard SyntaxError.
//
// Debt F7, step one: this file enables @ts-check + JSDoc, checked by tsconfig.public.json during
// CI typecheck (no esbuild build step; honours ui-redesign §6).

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
// Multi-language (DAC v1.0.0)
//
// Static pages are pre-rendered server-side per language; t() here only serves **dynamic text** (table
// rows, confirmations, hints). The dictionary is not inlined into the page (CSP script-src 'self' bans
// inline scripts), so it is fetched once from /api/i18n/<lang> at startup -- the language tag already
// sits on <html lang>, written by the server.
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
 * Fetch the dictionary and brand info once (concurrent callers share one Promise).
 * Failures do not throw: the page keeps the server-rendered static text and dynamic text falls back to the key name.
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
      // Offline or backend down: keep an empty dictionary, use key names or server text, and never break the page.
    })
  return loading
}

/**
 * Brand info (served by /api/i18n; safe defaults until it is ready, so callers never null-check).
 *
 * Field names are **normalised** here: the server (src/brand.ts) uses `repoUrl`/`homepage`/`fullName`,
 * the same source as the pages.ts placeholders, while callers (shell.js and friends) have always used
 * `repo`/`site`/`full`. Measured on 2026-09-26: without this mapping `brand.repo` stayed empty, so the
 * "Star on GitHub" entry **did not render at all** -- users saw the item vanish, not a broken link.
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
 * Tests inject brand info (same shape as useDictionary; the page runtime goes through loadI18n instead).
 * @param {null | { name?: string, full?: string, fullName?: string, tagline?: string, repo?: string, repoUrl?: string, site?: string, homepage?: string, supportEmail?: string }} info
 */
export const useBrand = (info) => {
  brand = info
}
/**
 * Inject the dictionary directly (tests and offline pre-rendering).
 *
 * Why this exists: unit tests run under Node, with no page and no real fetch -- but assertions must hit
 * **real translations**, otherwise `t()` returns key names and the test checks no text at all. The page
 * runtime does not use this entry point; it uses loadI18n().
 * @param {string} localeTag
 * @param {Record<string, string>} entries
 */
export const useDictionary = (localeTag, entries) => {
  locale = localeTag
  dict = entries
  loading = Promise.resolve()
}

/** Current language and the available ones (used by the language switcher). */
export const currentLocale = () => locale
export const availableLocales = () => (locales.length > 0 ? locales : [locale])

/**
 * Client-side translation: `t('nav.nodes')`, with `{name}` interpolation. A missing key returns the key
 * name, which is visible in the UI; with the CI key-parity assertion, a missing key cannot ship.
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
 * process.platform -> readable platform name (unknown platforms pass through). Shared by machine rows
 * and the local card, so machines.js and topology.js cannot drift into two different mappings.
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
  // viewBox: the sprite draws in a 16-unit coordinate system, and without it a 16-unit icon is squeezed
  // 1:1 into a 12-15px box -- unscaled, with the right side clipped. xlink:href is the only form the old
  // Edge engine (EdgeHTML) understands: without it <use> draws nothing and the button becomes invisible.
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
// Debt F2: money has one implementation site-wide -- `digits` is 2 for compact cards (the cron list)
// and 4 by default for the ledger and turn details; adaptive precision for totals lives in moneyAdaptive.
/**
 * @param {number | null | undefined} micro
 * @param {number} [digits]
 * @returns {string}
 */
export const money = (micro, digits = 4) => (micro === null || micro === undefined ? '—' : `$${(micro / 1e6).toFixed(digits)}`)

/**
 * Adaptive precision for totals (debt F2: converged from a local variant in spend.js).
 * One turn costs a few tenths of a cent, so a fixed 2 decimals shows a whole day of work as "$0.00";
 * a fixed 4 decimals would turn a monthly total into "$12.3400".
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
 * Falls back to an absolute date beyond a week: "37 days ago" is a number nobody
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
  // Beyond a week show the date, formatted for the current language instead of a hardcoded zh-CN.
  return new Date(ms).toLocaleDateString(locale, { month: '2-digit', day: '2-digit' })
}

/** @param {number | null | undefined} ms @returns {string} */
export const when = (ms) =>
  ms === null || ms === undefined
    ? '—'
    : new Date(ms).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })

// ---- Hive plan P3: CSRF double submit ----

/**
 * The CSRF cookie the server sets at login (not httpOnly, so the frontend can read it).
 *
 * During the B2 rename this file also read the pre-rename cookie name (the frontend reads from disk per
 * request while the backend ran from an already-built dist, so the two could disagree); after the
 * production cutover (2026-09-24 13:30, manager and all three nodes on the new code) that fallback was
 * removed -- there is exactly one `dac_csrf` now. A session missing the cookie gets 403 and a fresh
 * cookie, and the frontend retries once (see apiFetch below).
 * @returns {string}
 */
export const csrfToken = () => {
  const match = document.cookie.match(/(?:^|;\s*)dac_csrf=([^;]+)/)
  return match === null ? '' : decodeURIComponent(match[1])
}

/**
 * Global fetch wrapper: non-GET requests automatically carry X-CSRF-Token (matching the cookie).
 * Every page script goes through it; the server validates all non-GET /api/* (login and the internal
 * brain API are exempt). Upgrade self-healing: a session missing the csrf cookie gets 403 plus a fresh
 * cookie, so retry once with the new cookie.
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
      // 403 that is not JSON: return it as-is
    }
  }
  return response
}

/**
 * Debt F6: one Result layer. JSON API pages all go through it instead of hand-writing the three-step
 * "check status + read JSON + build banner" boilerplate.
 *
 * Success -> `{ ok:true, status, data }`;
 * failure -> `{ ok:false, status, error, detail }`, where detail is already displayable text
 * (the JSON error body wins; non-JSON or a thrown error falls back to `HTTP <status>`).
 *
 * 401 does not redirect -- going to /login is the page's decision (test and embedded pages do not need it).
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
    // non-JSON error body: keep the HTTP fallback text
  }
  return { ok: false, status: response.status, error, detail }
}

/**
 * Debt F6: shared failure banner. `showError(r, title)` renders a Result into the banner skeleton (the
 * same as bannerHtml, with detail escaped automatically) -- a page only needs
 * `if (!r.ok) { $('x').innerHTML = showError(r, '...'); return }` instead of boilerplate.
 * An ok Result returns an empty string, so callers can shortcut on `if (r.ok)` as a second guard.
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
 * Debt F3: SSE reconnection helper -- the byte-identical retryTimer/retryDelay machinery that used to
 * live in both board.js and chat.js converged here (3s -> x2 -> capped at 30s).
 * Public-release slimming (DAC v1.0.0): the board page is gone, so chat.js is the only caller left.
 *
 * `open()` is implemented by the caller: create the EventSource, attach a message listener, return it.
 * Discipline (the two page comments merged):
 * - EventSource retries on its own, but not when the server closes the stream outright (a manager
 *   restart), so back off and reconnect on error;
 * - an error handler closes only **its own** connection: a handler from an old instance fires late, and
 *   closing the current instance would lose one connection per drop.
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
 * Debt F4: one polling helper -- the separate setInterval loops in nodes/skills/shell, which had no
 * pause while hidden and no backoff on error, converged here.
 *
 * - suspended while `document.hidden` (a background tab should not spend requests), resumed at the same
 *   interval once visible again;
 * - when fn throws, back off by the interval (x2, capped at 10x), resetting on success;
 * - returns a stop function, used on page unload and when a drawer closes.
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
    // Pages call it as `poll(() => void load(), ms)` -- a synchronous wrapper, and a synchronous throw
    // still backs off. A fn that really returns a Promise goes down the then chain (browser case; tests use sync fns).
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
