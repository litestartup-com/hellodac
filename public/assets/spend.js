// Plain fetch + DOM, matching the rest of the front end: no build step.

import { $, esc, moneyAdaptive, apiJson, showError, bannerHtml, t, loadI18n } from './ui.js'

await loadI18n()

// 金额显示走 ui.js 的 moneyAdaptive(债务 F2 收口):$0 / <1 分 4 位 / <$1 3 位 / 其余 2 位。
// 一个回合花费只有几厘,固定 2 位会把一整天的工作显示成 "$0.00"。

const tokens = (n) => {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

/** `"01:00"` UTC rendered in the viewer's own timezone, which is how they schedule. */
const utcToLocal = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number)
  const d = new Date()
  d.setUTCHours(h, m, 0, 0)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

/**
 * The total is a floor whenever some rows had no configured rate.
 *
 * Showing a bare number in that case would be a quiet lie: the runs happened
 * and cost real money, manager just cannot say how much. So the figure gets a
 * `≥` and the models responsible are named, which is also the fix.
 */
const renderTotals = (data) => {
  // 变量名不要用 t：它会遮蔽 ui.js 的翻译函数 t()（2026-09-24 线上事故）。
  const totals = data.totals
  const gap = totals.unpriced > 0

  $('total-cost').textContent = `${gap ? '≥ ' : ''}${moneyAdaptive(totals.costMicroUsd)}`
  $('total-note').textContent = gap
    ? t('spend.unpricedNote', { count: totals.unpriced })
    : totals.runs === 0
      ? t('spend.noRuns')
      : ''

  const share = totals.costMicroUsd > 0 ? Math.round((totals.peakCostMicroUsd / totals.costMicroUsd) * 100) : 0
  $('peak-share').textContent = totals.costMicroUsd > 0 ? `${share}%` : '—'
  const windows = (data.peakWindowsUtc ?? [])
    .map((w) => `${utcToLocal(w.start)}–${utcToLocal(w.end)}`)
    .join('、')
  $('peak-note').textContent =
    windows === ''
      ? t('spend.noWindows')
      : share > 0
        ? t('spend.peakDoubled', { windows })
        : t('spend.allOffPeak', { windows })

  $('total-tokens').textContent = `${tokens(totals.inputTokens)} / ${tokens(totals.outputTokens)}`
  $('runs-note').textContent = t('spend.tokensNote', { runs: totals.runs })
}

const renderChart = (days) => {
  const el = $('chart')
  if (days.length === 0) {
    el.innerHTML = `<span class="chart-empty">${esc(t('spend.noRecords'))}</span>`
    return
  }
  const max = Math.max(...days.map((d) => d.costMicroUsd), 1)
  el.innerHTML = days
    .map((d) => {
      const height = Math.max((d.costMicroUsd / max) * 100, d.costMicroUsd > 0 ? 2 : 0)
      const peakPart = d.costMicroUsd > 0 ? (d.peakCostMicroUsd / d.costMicroUsd) * height : 0
      const offPart = height - peakPart
      const title = [
    `${d.day} · ${moneyAdaptive(d.costMicroUsd)}`,
    d.peakCostMicroUsd > 0 ? t('spend.dayPeak', { cost: moneyAdaptive(d.peakCostMicroUsd) }) : '',
    d.unpriced > 0 ? ` · ${t('spend.dayUnpriced', { count: d.unpriced })}` : '',
  ].join('')
      // An unpriced-only day would otherwise be an invisible gap, as if nothing
      // ran at all. Draw it flat and grey instead.
      const body =
        d.costMicroUsd === 0 && d.unpriced > 0
          ? '<span class="bar-seg none" style="height:3px"></span>'
          : `<span class="bar-seg on" style="height:${peakPart}%"></span><span class="bar-seg off" style="height:${offPart}%"></span>`
      return `<span class="bar" title="${esc(title)}">${body}</span>`
    })
    .join('')
}

const spendRow = (name, sub, entry) => {
  const gap = entry.unpriced > 0
  const figure = gap && entry.costMicroUsd === 0 ? t('spend.unpriced') : `${gap ? '≥ ' : ''}${moneyAdaptive(entry.costMicroUsd)}`
  return `
    <div class="row">
      <div class="spend-row">
        <span class="name">
          <strong>${esc(name)}</strong>
          ${sub === '' ? '' : `<span class="muted small">${esc(sub)}</span>`}
        </span>
        <span class="figure ${gap && entry.costMicroUsd === 0 ? 'unknown' : ''}">${esc(figure)}</span>
      </div>
      <div class="muted small">
        ${esc(t('spend.rowRuns', { runs: entry.runs }))} · ${tokens(entry.inputTokens)} in / ${tokens(entry.outputTokens)} out${
          entry.peakCostMicroUsd > 0 ? ` · ${esc(t('spend.rowPeak', { cost: moneyAdaptive(entry.peakCostMicroUsd) }))}` : ''
        }
      </div>
    </div>`
}

const renderAgents = (rows) => {
  $('by-agent').innerHTML =
    rows.length === 0
      ? `<div class="row muted small">${esc(t('spend.noRuns'))}</div>`
      : rows.map((r) => spendRow(r.name, r.agentId, r)).join('')
}

const renderModels = (rows) => {
  $('by-model').innerHTML =
    rows.length === 0
      ? `<div class="row muted small">${esc(t('spend.noRuns'))}</div>`
      : rows
          .map((r) =>
            spendRow(
              r.model ?? t('spend.unknownModel'),
              r.rateConfigured ? (r.provider ?? '') : t('spend.rateMissing'),
              r,
            ),
          )
          .join('')
}

/**
 * Names the models that need a rate, because that is the actionable part.
 *
 * "Some spend is missing" is not something anyone can fix; "deepseek-v4-pro has
 * no rate in manager.config.yaml" is.
 */
const renderBanners = (data) => {
  const missing = data.byModel.filter((m) => !m.rateConfigured && m.runs > 0)
  // 债务 F6:手写 banner 收敛进 ui.js 的 bannerHtml(body 预转义,可带 <code> 等内联标签)
  $('banners').innerHTML =
    missing.length === 0
      ? ''
      : bannerHtml({
          level: 'warn',
          title: t('spend.missingTitle', { count: missing.length }),
          body: t('spend.missingBody', {
            models: esc(missing.map((m) => m.model ?? t('spend.unknownModel')).join(', ')),
          }),
        })
}

// ---------------------------------------------------------------------------
// load
// ---------------------------------------------------------------------------

const load = async (month) => {
  const query = month === null || month === undefined ? '' : `?month=${encodeURIComponent(month)}`
  // 债务 F6:统一 Result 层——错误 banner 走共享 showError,不再手写样板。
  const r = await apiJson(`/api/usage${query}`, { credentials: 'same-origin' })
  if (r.status === 401) {
    window.location.href = '/login'
    return
  }
  if (!r.ok) {
    $('banners').innerHTML = showError(r, t('spend.readFailed'))
    return
  }
  const data = r.data

  const options = data.months.includes(data.month) ? data.months : [data.month, ...data.months]
  $('month').innerHTML = options
    .map((m) => `<option value="${esc(m)}" ${m === data.month ? 'selected' : ''}>${esc(m)}</option>`)
    .join('')

  renderBanners(data)
  renderTotals(data)
  renderChart(data.byDay)
  renderAgents(data.byAgent)
  renderModels(data.byModel)
}

$('month').addEventListener('change', (event) => {
  void load(event.target.value)
})

void load(null)
