import type { TokenUsage } from './gateway/stream.js'

/**
 * Token cost, recorded at run time.
 *
 * Cost is stored as an integer number of **micro-USD** (1e-6 USD) so no float
 * ever reaches the database and sums stay exact. Formatting back to a currency
 * string is the reporting layer's job.
 *
 * Rates are per million tokens, and are recorded per run rather than computed
 * at report time: a provider can change its prices, and history should keep the
 * cost that was actually incurred.
 *
 * An unknown model yields null rather than a confidently wrong zero. A gap in
 * the ledger is visible and fixable; a fabricated zero is neither.
 *
 * ## Time of day is part of the price
 *
 * DeepSeek bills V4 at two rates: peak is exactly double off-peak on every line,
 * and peak covers 7 of 24 hours. Pricing is therefore a function of *when* a
 * request was made, which has two consequences the callers must respect:
 *
 * - a turn is priced per response, at the moment that response arrived, not
 *   once at the end -- a long turn can straddle a boundary and be billed at
 *   both rates
 * - scheduling matters: the same work costs half as much off-peak
 */

export interface Rate {
  /** USD per million uncached input tokens. */
  input: number
  /** USD per million output tokens. */
  output: number
  /** USD per million tokens read from cache. Usually far cheaper than input. */
  cacheRead?: number
  /** USD per million tokens written to cache. Defaults to the input rate. */
  cacheWrite?: number
}

export interface ModelPricing {
  /** Applies outside every peak window. */
  offPeak: Rate
  /** Omitted when the model is billed at one flat rate around the clock. */
  peak?: Rate
}

/** Half-open `[start, end)` in minutes from UTC midnight. Wraps when start > end. */
export interface PeakWindow {
  startMinuteUtc: number
  endMinuteUtc: number
}

export interface PricingTable {
  /** Keyed by `provider/model`, then by bare model as a fallback. */
  rates: Record<string, ModelPricing>
  /** Empty means everything is off-peak. */
  peakWindows: PeakWindow[]
  /**
   * 2026-09-05：周六周日全天按低谷计价（DeepSeek V4 规则）——峰值窗口只在
   * 工作日生效。缺省 false 保持老行为，DEFAULT_PRICING 显式开启。
   */
  weekendsOffPeak?: boolean
  /** 判定「周末」所用的时区（峰值窗口是 UTC 的，星期几属于人的日历）。 */
  pricingTimeZone?: string
}

/** 星期几按哪个时区的日历算——默认北京（与峰值窗口=北京工作时段一致）。 */
const PRICING_TIME_ZONE = 'Asia/Shanghai'

/**
 * `at` 在给定时区里是否落在周六/周日。时区无效时按工作日处理——宁可照常
 * 计峰值，也不静默少记一笔钱。
 */
export const isWeekend = (at: number, timeZone: string): boolean => {
  try {
    const day = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(new Date(at))
    return day === 'Sat' || day === 'Sun'
  } catch {
    return false
  }
}

/** Parses `"01:00"` into minutes from midnight. Throws on anything else. */
export const parseUtcTime = (value: string): number => {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value)
  if (match === null) throw new Error(`invalid UTC time "${value}", expected HH:MM`)
  return Number(match[1]) * 60 + Number(match[2])
}

/**
 * DeepSeek V4, verified 2026-08-30 against published rates (effective
 * 2026-08-16 16:00 UTC). Peak is 01:00-04:00 and 06:00-10:00 UTC, which is
 * 09:00-12:00 and 14:00-18:00 Beijing time -- the working day.
 *
 * The gateway reports the provider as `deepseek-official`, not `deepseek`, so
 * these are keyed by bare model name and reached through the fallback. Keying
 * them by `provider/model` alone would silently never match.
 */
export const DEFAULT_PRICING: PricingTable = {
  rates: {
    'deepseek-v4-pro': {
      offPeak: { input: 0.66, output: 1.98, cacheRead: 0.022 },
      peak: { input: 1.32, output: 3.96, cacheRead: 0.044 },
    },
    'deepseek-v4-flash': {
      offPeak: { input: 0.22, output: 0.66, cacheRead: 0.007 },
      peak: { input: 0.44, output: 1.32, cacheRead: 0.014 },
    },
  },
  peakWindows: [
    { startMinuteUtc: parseUtcTime('01:00'), endMinuteUtc: parseUtcTime('04:00') },
    { startMinuteUtc: parseUtcTime('06:00'), endMinuteUtc: parseUtcTime('10:00') },
  ],
  weekendsOffPeak: true,
  pricingTimeZone: PRICING_TIME_ZONE,
}

export const findPricing = (
  provider: string | null,
  model: string | null,
  rates: Record<string, ModelPricing>,
): ModelPricing | null => {
  if (model === null || model === '') return null
  if (provider !== null && provider !== '') {
    const exact = rates[`${provider}/${model}`]
    if (exact !== undefined) return exact
  }
  return rates[model] ?? null
}

/** True when `at` falls inside a peak window. */
export const isPeak = (at: number, windows: PeakWindow[]): boolean => {
  const d = new Date(at)
  const minute = d.getUTCHours() * 60 + d.getUTCMinutes()
  return windows.some(({ startMinuteUtc, endMinuteUtc }) =>
    startMinuteUtc <= endMinuteUtc
      ? minute >= startMinuteUtc && minute < endMinuteUtc
      : minute >= startMinuteUtc || minute < endMinuteUtc,
  )
}

const MICRO = 1_000_000
const PER_MILLION = 1_000_000

export interface CostBreakdown {
  microUsd: number
  /** Which side of the clock this was billed at, for reporting the split. */
  peak: boolean
}

/**
 * Prices one response, at the instant it arrived.
 *
 * Returns null when the model has no configured rate -- an honest gap in the
 * ledger beats a fabricated zero.
 *
 * The counters are disjoint (see events.ts: `inputTokens` excludes cached
 * input), so they are priced separately and never double-counted.
 */
export const computeCost = (
  usage: TokenUsage | null,
  provider: string | null,
  model: string | null,
  at: number,
  table: PricingTable = DEFAULT_PRICING,
): CostBreakdown | null => {
  if (usage === null) return null
  const pricing = findPricing(provider, model, table.rates)
  if (pricing === null) return null

  const inWindow = isPeak(at, table.peakWindows)
  // 2026-09-05：周末全天低谷——峰值窗口只在工作日生效。
  const weekend = table.weekendsOffPeak === true && isWeekend(at, table.pricingTimeZone ?? PRICING_TIME_ZONE)
  const peak = pricing.peak !== undefined && inWindow && !weekend
  const rate = peak && pricing.peak !== undefined ? pricing.peak : pricing.offPeak

  const usd =
    (usage.inputTokens * rate.input) / PER_MILLION +
    (usage.outputTokens * rate.output) / PER_MILLION +
    ((usage.cacheReadTokens ?? 0) * (rate.cacheRead ?? rate.input)) / PER_MILLION +
    ((usage.cacheWriteTokens ?? 0) * (rate.cacheWrite ?? rate.input)) / PER_MILLION

  return { microUsd: Math.round(usd * MICRO), peak }
}

/** Formats micro-USD for display, e.g. 12345 -> "$0.0123". */
export const formatMicroUsd = (micro: number | null): string => {
  if (micro === null) return '—'
  return `$${(micro / MICRO).toFixed(4)}`
}
