// 任务页（UI 收尾 A）：全局任务流从 /nodes 迁出，独立成页并升级——
// 工作区/状态筛选 + startedAt 游标分页。15 秒轮询只刷新第一页；用户翻页
// 后停自动刷新（不打断滚动位置），手动「刷新」或改筛选回到第一页。
// 行拼装与查询串在 run-row.js（纯函数层）。
import { $, esc, setHtml, apiJson, poll, t, loadI18n } from './ui.js'

await loadI18n()
import { runRow, runsQuery } from './run-row.js'

let nextCursor = null // 上一页末条 startedAt；null = 没有下一页
let pagesLoaded = 1 // 翻页后停自动刷新
let loading = false

const fAgent = () => $('f-run-agent').value
const fState = () => $('f-run-state').value

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
    // 行里出现的未知 agentId（已从 config 移除的历史任务）补进下拉，
    // 保证仍可筛选；下拉只增不删，改筛选不丢已收集的选项。
    for (const run of runs) {
      if (!agentSeen.has(run.agentId)) agentSeen.set(run.agentId, run.agentName ?? run.agentId)
    }
    fillAgentSelect()
    nextCursor = next ?? null
    $('runs-more').hidden = nextCursor === null
    pagesLoaded = append ? pagesLoaded + 1 : 1
    $('runs-updated').textContent = t('runs.refreshAt', { time: new Date().toLocaleTimeString(undefined, { hour12: false }) })
  } catch {
    // 网络失败时保留上一帧，不刷成错误页。
  } finally {
    loading = false
  }
}

const firstPage = () => {
  pagesLoaded = 1
  void loadPage(false)
}

// 工作区下拉：config agents 真相（/api/status）；任务流里出现的未知
// agentId（已从 config 移除的历史任务）也补进下拉，保证仍可筛选。
const agentSeen = new Map() // id -> 名称
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
