// Task page (UI wrap-up A): the global task stream moved out of /nodes into its own page and grew up --
// workspace/status filters plus startedAt cursor paging. The 15s poll refreshes only the first page; once
// the user pages, auto-refresh stops (so the scroll position is not disturbed), and the manual "refresh"
// button or a filter change returns to page one. Row assembly and query strings live in run-row.js.
import { $, esc, setHtml, apiJson, poll, t, loadI18n } from './ui.js'

await loadI18n()
import { runRow, runsQuery } from './run-row.js'

let nextCursor = null // startedAt of the last row on the previous page; null = no next page
let pagesLoaded = 1 // auto-refresh stops once the user pages
let loading = false

const fAgent = () => $('f-run-agent').value
const fState = () => $('f-run-state').value

/**
 * Finishing the body collapse (UI slimming): rows render with `clamped` first (2 lines, no full-text flash),
 * and after layout the real height is measured here -- no overflow means the class comes off and the expand
 * button stays hidden.
 *
 * Why measure scrollHeight instead of asking `-webkit-line-clamp`: clamping only truncates what is displayed,
 * it does not report whether anything was truncated. Overflow means the full height exceeds the visible
 * height, and one measurement answers that.
 */
const finalizeRunRows = () => {
  for (const body of document.querySelectorAll('#runs-list [data-run-body].clamped')) {
    const overflows = body.scrollHeight - body.clientHeight > 1
    const toggle = body.nextElementSibling
    if (toggle === null || toggle.dataset.runToggle === undefined) continue
    if (overflows) {
      toggle.hidden = false
    } else {
      body.classList.remove('clamped')
      toggle.hidden = true
    }
  }
}

// Expand/collapse: purely frontend, the body is already in the DOM (no need to ask the backend again).
$('runs-list').addEventListener('click', (event) => {
  const toggle = event.target.closest('[data-run-toggle]')
  if (toggle === null) return
  const body = toggle.previousElementSibling
  if (body === null || body.dataset.runBody === undefined) return
  const expanded = body.classList.toggle('expanded')
  body.classList.toggle('clamped', !expanded)
  toggle.textContent = expanded ? t('runs.collapse') : t('runs.expand')
})

const loadPage = async (append) => {
  if (loading) return
  loading = true
  try {
    const q = runsQuery({ agentId: fAgent(), state: fState(), before: append ? nextCursor : null })
    const result = await apiJson(`/api/runs${q === '' ? '' : `?${q}`}`)
    if (!result.ok) return
    const { runs, next } = result.data
    if (append) {
      $('runs-list').insertAdjacentHTML('beforeend', runs.map(runRow).join(''))
    } else {
      setHtml('runs-list', runs.length === 0 ? `<p class="muted small">${esc(t('runs.empty'))}</p>` : runs.map(runRow).join(''))
    }
    // Unknown agentIds appearing in rows (historical tasks whose agent left the config) are added to the
    // dropdown so they remain filterable; the dropdown only ever grows, so changing filters loses no option.
    for (const run of runs) {
      if (!agentSeen.has(run.agentId)) agentSeen.set(run.agentId, run.agentName ?? run.agentId)
    }
    fillAgentSelect()
    nextCursor = next ?? null
    $('runs-more').hidden = nextCursor === null
    pagesLoaded = append ? pagesLoaded + 1 : 1
    $('runs-updated').textContent = t('runs.refreshAt', { time: new Date().toLocaleTimeString(undefined, { hour12: false }) })
    // Decide per row whether to offer "expand" only after layout -- the first frame still measures the unclamped height.
    requestAnimationFrame(finalizeRunRows)
  } catch {
    // On a network failure keep the previous frame instead of painting an error page.
  } finally {
    loading = false
  }
}

const firstPage = () => {
  pagesLoaded = 1
  void loadPage(false)
}

// Workspace dropdown: config agents are the source of truth (/api/status); unknown agentIds appearing in the
// task stream (historical tasks whose agent left the config) are added as well so they remain filterable.
const agentSeen = new Map() // id -> name
const fillAgentSelect = () => {
  const sel = $('f-run-agent')
  const chosen = sel.value
  for (const [id, name] of agentSeen) {
    if (sel.querySelector(`option[value="${CSS.escape(id)}"]`) === null) {
      const opt = document.createElement('option')
      opt.value = id
      opt.textContent = name === id ? id : `${name}（${id}）`
      sel.appendChild(opt)
    }
  }
  if (chosen !== '' && sel.querySelector(`option[value="${CSS.escape(chosen)}"]`) !== null) sel.value = chosen
}

$('f-run-agent').addEventListener('change', firstPage)
$('f-run-state').addEventListener('change', firstPage)
$('runs-refresh').addEventListener('click', firstPage)
$('runs-more').addEventListener('click', () => void loadPage(true))

void apiJson('/api/status')
  .then((result) => {
    if (!result.ok) return
    for (const agent of result.data.agents ?? []) agentSeen.set(agent.id, agent.name)
    fillAgentSelect()
  })
  .catch(() => {})

void loadPage(false)
poll(() => {
  if (pagesLoaded <= 1) void loadPage(false)
}, 15_000)
