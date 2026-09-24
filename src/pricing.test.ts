import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_PRICING,
  computeCost,
  findPricing,
  isPeak,
  parseUtcTime,
  type PricingTable,
} from './pricing.js'

const MILLION = { inputTokens: 1_000_000, outputTokens: 1_000_000 }

const at = (iso: string): number => Date.parse(iso)

// DeepSeek peak is 01:00-04:00 and 06:00-10:00 UTC.
// 2026-08-28 is a Friday (weekday); 2026-08-29/30 are the weekend.
const OFF_PEAK = at('2026-08-28T12:00:00Z')
const PEAK = at('2026-08-28T02:00:00Z')

test('a million in and a million out is priced at the off-peak card outside peak hours', () => {
  const cost = computeCost(MILLION, 'deepseek-official', 'deepseek-v4-pro', OFF_PEAK)
  // $0.66 input + $1.98 output = $2.64
  assert.deepEqual(cost, { microUsd: 2_640_000, peak: false })
})

test('the same work inside a peak window costs exactly double', () => {
  const off = computeCost(MILLION, 'deepseek-official', 'deepseek-v4-pro', OFF_PEAK)
  const on = computeCost(MILLION, 'deepseek-official', 'deepseek-v4-pro', PEAK)
  assert.ok(off !== null && on !== null)
  assert.equal(on.microUsd, off.microUsd * 2)
  assert.equal(on.peak, true)
})

test('the provider the gateway actually reports still resolves a rate', () => {
  // The gateway says `deepseek-official`, while the rate table is keyed by bare
  // model name. If the fallback ever went away every run would silently become
  // unpriced, so pin the exact string the gateway sends.
  const cost = computeCost(MILLION, 'deepseek-official', 'deepseek-v4-pro', OFF_PEAK)
  assert.ok(cost !== null, 'deepseek-official/deepseek-v4-pro must price')
})

test('peak windows are half-open, so the closing hour is already off-peak', () => {
  assert.equal(isPeak(at('2026-08-30T00:59:59Z'), DEFAULT_PRICING.peakWindows), false)
  assert.equal(isPeak(at('2026-08-30T01:00:00Z'), DEFAULT_PRICING.peakWindows), true)
  assert.equal(isPeak(at('2026-08-30T03:59:59Z'), DEFAULT_PRICING.peakWindows), true)
  assert.equal(isPeak(at('2026-08-30T04:00:00Z'), DEFAULT_PRICING.peakWindows), false)
  assert.equal(isPeak(at('2026-08-30T06:00:00Z'), DEFAULT_PRICING.peakWindows), true)
  assert.equal(isPeak(at('2026-08-30T10:00:00Z'), DEFAULT_PRICING.peakWindows), false)
})

test('a window that crosses midnight covers both sides of it', () => {
  const windows = [{ startMinuteUtc: parseUtcTime('22:00'), endMinuteUtc: parseUtcTime('02:00') }]
  assert.equal(isPeak(at('2026-08-30T23:30:00Z'), windows), true)
  assert.equal(isPeak(at('2026-08-30T01:30:00Z'), windows), true)
  assert.equal(isPeak(at('2026-08-30T12:00:00Z'), windows), false)
})

test('cached input is priced at the cache rate, not the input rate', () => {
  const cost = computeCost(
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 },
    'deepseek-official',
    'deepseek-v4-pro',
    OFF_PEAK,
  )
  // $0.022, not the $0.66 input rate -- a 30x difference if this regresses.
  assert.deepEqual(cost, { microUsd: 22_000, peak: false })
})

test('an unknown model yields null rather than a confident zero', () => {
  assert.equal(computeCost(MILLION, 'deepseek-official', 'some-unreleased-model', OFF_PEAK), null)
  assert.equal(computeCost(MILLION, null, null, OFF_PEAK), null)
})

test('a model with no peak card is never billed as peak', () => {
  const flat: PricingTable = {
    rates: { 'flat-model': { offPeak: { input: 1, output: 1 } } },
    peakWindows: DEFAULT_PRICING.peakWindows,
  }
  const cost = computeCost(MILLION, null, 'flat-model', PEAK, flat)
  assert.deepEqual(cost, { microUsd: 2_000_000, peak: false })
})

test('an exact provider/model key wins over the bare model fallback', () => {
  const table: Record<string, { offPeak: { input: number; output: number } }> = {
    'acme/m': { offPeak: { input: 9, output: 9 } },
    m: { offPeak: { input: 1, output: 1 } },
  }
  assert.equal(findPricing('acme', 'm', table)?.offPeak.input, 9)
  assert.equal(findPricing('other', 'm', table)?.offPeak.input, 1)
})

test('a malformed peak window is rejected at load rather than mispricing silently', () => {
  assert.throws(() => parseUtcTime('25:00'), /invalid UTC time/)
  assert.throws(() => parseUtcTime('1:00'), /invalid UTC time/)
  assert.throws(() => parseUtcTime('01:60'), /invalid UTC time/)
  assert.equal(parseUtcTime('00:00'), 0)
  assert.equal(parseUtcTime('23:59'), 23 * 60 + 59)
})

test('2026-09-05 rule: weekends bill off-peak all day, even inside peak windows', () => {
  // 周六/周日 09:00 北京（= 01:00 UTC，落在峰值窗口内）→ 低谷价
  const sat = computeCost(MILLION, 'deepseek-official', 'deepseek-v4-pro', at('2026-08-29T01:00:00Z'))
  assert.deepEqual(sat, { microUsd: 2_640_000, peak: false })
  const sun = computeCost(MILLION, 'deepseek-official', 'deepseek-v4-pro', at('2026-08-30T02:00:00Z'))
  assert.equal(sun?.peak, false)
  // 周一 09:00 北京（= 01:00 UTC）→ 峰值恢复
  const mon = computeCost(MILLION, 'deepseek-official', 'deepseek-v4-pro', at('2026-08-31T01:00:00Z'))
  assert.equal(mon?.peak, true)
  assert.equal(mon?.microUsd, 5_280_000)
})

test('a custom table without the weekend flag keeps billing peak on weekends', () => {
  const legacy: PricingTable = {
    rates: DEFAULT_PRICING.rates,
    peakWindows: DEFAULT_PRICING.peakWindows,
  }
  const sat = computeCost(MILLION, 'deepseek-official', 'deepseek-v4-pro', at('2026-08-29T01:00:00Z'), legacy)
  assert.equal(sat?.peak, true)
})
