// 债务 F1:chat.js 拆分第二步——渲染层(帧/block → HTML 字符串)。
//
// 全部是纯字符串构造,无 DOM 写入;折叠状态(openTools/openContext)、
// markdown 缓存(mdCache)、会话状态(getState)由调用方注入,所以可以在
// node 里单测(chat-render.test.mjs)。转义纪律与 md.js 一致:escape-first。

import { md } from './md.js'
import { classifyTool, toolBody, toolSummary, toolTitle } from './tool-cards.js'
import { esc, icon, money, t, loadI18n } from './ui.js'

await loadI18n()

// Local for now: a tap is remembered per turn id so the thumbs stay honest
// across reloads. No server API exists yet, so nothing pretends the feedback
// travelled further than this browser.
const FB_KEY = 'manager.chat.feedback'

const readFeedback = () => {
  try {
    const raw = JSON.parse(window.localStorage.getItem(FB_KEY) ?? '{}')
    return raw !== null && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

const setFeedback = (turnId, value) => {
  const fb = readFeedback()
  if (value === null) delete fb[turnId]
  else fb[turnId] = value
  try {
    window.localStorage.setItem(FB_KEY, JSON.stringify(fb))
  } catch {
    // Private-mode storage failures are not worth a visible error: the tap
    // still registers for this page.
  }
}

const feedbackOf = (turnId) => (turnId === null || turnId === '' ? '' : readFeedback()[turnId] ?? '')

/**
 * @param {{
 *   getState: () => { agent: { id: string; name: string; workspacePath?: string }; chat: { title: string | null } } | null;
 *   openTools: Set<number>;
 *   openContext: Set<number>;
 *   mdCache?: Map<string, string>;
 * }} deps
 */
export const makeRenderer = ({ getState, openTools, openContext, mdCache: injectedCache }) => {
  const mdCache = injectedCache ?? new Map()
  const MD_CACHE_MAX = 240

  /**
   * Markdown, parsed once per distinct string.
   *
   * `renderLog` rebuilds the whole transcript on every animation frame, so without
   * this a long chat would re-parse every finished reply dozens of times a second
   * to redraw text that cannot have changed. Only the streaming block misses.
   *
   * Keyed by the text itself, which is what makes it safe: a hit is only possible
   * when the input is identical. Bounded because a long stream produces one key per
   * frame, and an unbounded cache of every intermediate state is a leak.
   */
  const mdOnce = (text) => {
    const hit = mdCache.get(text)
    if (hit !== undefined) return hit
    const html = md(text)
    if (mdCache.size >= MD_CACHE_MAX) {
      // Insertion-ordered, so the oldest key is the first one. Dropping a batch
      // rather than one keeps this from running on nearly every frame.
      for (const key of [...mdCache.keys()].slice(0, MD_CACHE_MAX / 2)) mdCache.delete(key)
    }
    mdCache.set(text, html)
    return html
  }

  /**
   * 公开版精简（DAC v1.0.0）：大盘页已下线，所以 `board/*.json` 不再变成链接
   * ——指向不存在视图的链接比没有链接更糟（UI.md §5），一律纯文本渲染。
   */
  const writeRow = (tool) => {
    const inner = esc(tool.path)
    return `<div class="write-row">
    <span class="pen" aria-hidden="true">✎</span>
    <span>${esc(t('chat.render.updated', { path: inner }))}</span>
  </div>`
  }

  const toolsBlock = (tools, index) => {
    if (tools.length === 0) return ''
    const failed = tools.filter((t) => t.failed).length
    const summary = failed > 0 ? t('chat.tools.summaryFailed', { count: tools.length, failed }) : t('chat.tools.summary', { count: tools.length })
    // DSH web 的工具卡推导（tool-cards.js）：名字→variant 分类、标题、
    // 摘要、正文（code/JSON）、结果文本——与 DSH 的 GenericToolCard 同源规则。
    const rows = tools
      .map((tool) => {
        const variant = classifyTool(tool.name)
        const title = toolTitle(tool.name)
        const head = `<div class="tool-head">
        <span class="tool-variant v-${esc(variant)}">${esc(title)}</span>
        <span class="tool-summary">${esc(toolSummary(tool.name, tool.raw))}</span>
        <span class="tool-state${tool.failed ? ' bad' : tool.done ? '' : ' running'}">${tool.failed ? esc(t('chat.tools.failed')) : tool.done ? esc(t('chat.tools.done')) : '…'}</span>
      </div>`
        const body = toolBody(tool.name, tool.raw)
        const bodyHtml = body === null
          ? ''
          : `<details class="tool-body"><summary>${variant === 'code' ? esc(t('chat.tools.code')) : esc(t('chat.tools.args'))}</summary><pre>${esc(body)}</pre></details>`
        // 失败的调用默认展开结果（这是出错时唯一要紧的东西）；成功的默认折叠。
        const resultHtml = tool.done && tool.resultText !== ''
          ? `<details class="tool-result"${tool.failed ? ' open' : ''}><summary>${esc(t('chat.tools.result'))}</summary><pre>${esc(tool.resultText)}</pre></details>`
          : ''
        return `<div class="tool-call${tool.failed ? ' failed' : ''}" data-variant="${esc(variant)}">${head}${bodyHtml}${resultHtml}</div>`
      })
      .join('')
    return `<details class="tools" data-fold="${index}"${openTools.has(index) ? ' open' : ''}>
    <summary><span class="chev">${icon('chev', 11)}</span>${esc(summary)}</summary>
    ${rows}
  </details>`
  }

  const tokens = (usage) => {
    if (usage === null || usage === undefined) return null
    const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
    return `${k(usage.inputTokens)} in · ${k(usage.outputTokens)} out`
  }

  /**
   * One reply's closing line, shown once per reply (never per tool call): when it
   * ended, how long it took, throughput, cost -- and the three actions. `show` is
   * true only on the last agent block of a run, which is what keeps a multi-step
   * reply from printing this row several times.
   */
  const footer = (block, index, show) => {
    if (block.error !== null) {
      return `<div class="turn-foot failed">${icon('alert', 12)}<span>${esc(block.error)}</span></div>`
    }
    if (!show || block.streaming) return ''

    const run = block.run
    const durationSec =
      run !== undefined && run !== null && run.endedAt !== null
        ? Math.max(1, Math.round((run.endedAt - run.startedAt) / 1000))
        : 0

    const parts = []
    if (run !== undefined && run !== null && run.endedAt !== null) {
      parts.push(new Date(run.endedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }))
    }
    if (durationSec > 0) parts.push(`${durationSec}s`)
    const usage = block.usage
    if (usage !== null && usage !== undefined && usage.outputTokens > 0 && durationSec > 0) {
      parts.push(`${Math.round(usage.outputTokens / durationSec)} tok/s`)
    }
    // 变量名不要用 t：它会遮蔽 ui.js 的翻译函数（2026-09-24 线上事故，
    // 症状是"footer 里 t is not a function"，即回答底部的三个按钮）。
    const tokenText = tokens(usage)
    if (tokenText !== null) parts.push(esc(tokenText))
    if (run !== undefined && run !== null && run.usage !== null && run.usage.costMicroUsd !== null) {
      parts.push(esc(money(run.usage.costMicroUsd)))
    }

    const turnId = run !== undefined && run !== null && run.id !== undefined ? String(run.id) : ''
    const fb = feedbackOf(turnId)
    return `<div class="turn-foot">
    ${parts.length === 0 ? '' : `<span class="turn-meta">${parts.join(' · ')}</span>`}
    <span class="grow"></span>
    <div class="turn-actions">
      <button class="turn-act" type="button" data-act="copy" data-copy="${index}" aria-label="${esc(t('chat.turn.copyAnswer'))}" title="${esc(t('chat.copy'))}">
        ${icon('copy', 14)}
      </button>
      <button class="turn-act${fb === 'up' ? ' on' : ''}" type="button" data-act="up" data-turn="${esc(turnId)}" aria-label="${esc(t('chat.turn.like'))}" title="${esc(t('chat.turn.like'))}">
        ${icon('thumb-up', 14)}
      </button>
      <button class="turn-act${fb === 'down' ? ' on' : ''}" type="button" data-act="down" data-turn="${esc(turnId)}" aria-label="${esc(t('chat.turn.dislike'))}" title="${esc(t('chat.turn.dislike'))}">
        ${icon('thumb-down', 14)}
      </button>
    </div>
  </div>`
  }

  const agentTurn = (block, index, showFoot) => {
    const state = getState()
    const name = state === null ? 'agent' : state.agent.name
    // Streamed text is shown only until the message frame lands, and the two are
    // never concatenated: they are the same content twice.
    const body = block.text !== '' ? block.text : block.streamed
    const writes = block.tools.filter((t) => t.write && t.path !== null)
    return `<div class="turn from-agent">
    <div class="turn-who"><span class="who-avatar" aria-hidden="true">${icon('bot', 14)}</span><span>${esc(name)}</span></div>
    ${body === '' && !block.streaming ? '' : `<div class="bubble prose${block.streaming ? ' streaming' : ''}">${mdOnce(body)}</div>`}
    ${toolsBlock(block.tools, index)}
    ${writes.length === 0 ? '' : `<div class="writes">${writes.map(writeRow).join('')}</div>`}
    ${footer(block, index, showFoot)}
  </div>`
  }

  // The user's own words stay plain text on purpose: rendering their Markdown
  // would show them something other than what they typed, and a stray asterisk is
  // not a formatting request. No name row either -- alignment and the blue bubble
  // are the identity, exactly as DSH renders its user messages.
  const userTurn = (block) => `<div class="turn from-user">
    <div class="bubble">${esc(block.text)}</div>
  </div>`

  /**
   * A run of injected user events, as one collapsed fold.
   *
   * Collapsed by default because this is context the harness gave the agent, not
   * part of the conversation -- one real transcript had 3.6KB of it against 46
   * bytes of actual question. It is shown rather than dropped because it is what
   * the agent was actually told, and a transcript that hides that is a transcript
   * that cannot explain the reply.
   */
  const contextFold = (group, index) => {
    const bodies = group
      .map((block) => {
        // The wrapper adds nothing once the fold is labelled, so it is peeled off
        // to leave the instructions themselves readable.
        const inner = block.text.replace(/^\s*<system-reminder>/, '').replace(/<\/system-reminder>\s*$/, '')
        return `<div class="context-item prose">${mdOnce(inner.trim())}</div>`
      })
      .join('')
    const label = group.length === 1 ? t('chat.injection.one') : t('chat.injection.many', { count: group.length })
    return `<details class="context" data-context="${index}"${openContext.has(index) ? ' open' : ''}>
    <summary><span class="chev">${icon('chev', 11)}</span>${esc(label)}</summary>
    ${bodies}
  </details>`
  }

  // DSH 的 QuestionComposer 选项语义：单选 radiogroup/radio、多选 group/checkbox，
  // 状态经 aria-checked 暴露（选中态仍由 .on 类驱动视觉）。
  const optionRow = (qid, option, multi) => `<button type="button" class="ask-opt" data-q="${esc(qid)}" data-label="${esc(option.label)}" role="${multi ? 'checkbox' : 'radio'}" aria-checked="false">
    <span class="ask-opt-label">${esc(option.label)}</span>
    ${option.description === undefined ? '' : `<span class="ask-opt-desc">${esc(option.description)}</span>`}
  </button>`

  const questionCard = (ask) => {
    const bodies = ask.questions.map((q) => `<div class="ask-q" data-q="${esc(q.id)}">
      ${q.header === undefined ? '' : `<div class="ask-q-head">${esc(q.header)}</div>`}
      <div class="ask-q-text">${esc(q.question)}</div>
      ${q.detail === undefined ? '' : `<div class="ask-q-detail prose">${mdOnce(q.detail)}</div>`}
      ${(q.options ?? []).length === 0 ? '' : `<div class="ask-opts${q.multiSelect === true ? ' multi' : ''}" role="${q.multiSelect === true ? 'group' : 'radiogroup'}">${q.options.map((o) => optionRow(q.id, o, q.multiSelect === true)).join('')}</div>`}
      <input class="ask-custom" data-q="${esc(q.id)}" type="text" placeholder="${esc((q.options ?? []).length === 0 ? t('chat.ask.customPlaceholder') : t('chat.ask.customOrOwn'))}">
    </div>`).join('')
    // DSH's decision-card grammar: amber strip on top, white card, body, and the
    // actions pinned to the bottom-right of the card.
    return `<div class="ask" data-ask="${esc(ask.id)}">
    <div class="ask-strip"><span class="ask-dot" aria-hidden="true"></span>${esc(t('chat.ask.waiting'))}</div>
    <div class="ask-body">${bodies}</div>
    <div class="ask-actions">
      <span class="ask-error"></span>
      <button type="button" class="ask-skip" data-ask="${esc(ask.id)}">${esc(t('chat.ask.skip'))}</button>
      <button type="button" class="ask-send" data-ask="${esc(ask.id)}">${esc(t('chat.ask.answer'))}</button>
    </div>
  </div>`
  }

  const approvalCard = (ask) => {
    const toolName = ask.toolName === '' ? t('chat.ask.tool') : ask.toolName
    return `<div class="ask approval" data-ask="${esc(ask.id)}">
    <div class="ask-strip"><span class="ask-dot" aria-hidden="true"></span>${esc(t('chat.ask.approvalWaiting'))}</div>
    <div class="ask-body">
      <div class="ask-headline">${esc(t('chat.ask.headline', { tool: toolName }))}</div>
      ${ask.reason === null || ask.reason === '' ? '' : `<div class="ask-q-detail">${esc(ask.reason)}</div>`}
    </div>
    <div class="ask-actions">
      <span class="ask-error"></span>
      <button type="button" class="ask-reject" data-ask="${esc(ask.id)}">${esc(t('chat.ask.reject'))}</button>
      <button type="button" class="ask-allow" data-ask="${esc(ask.id)}">${esc(t('chat.ask.allowOnce'))}</button>
    </div>
  </div>`
  }

  return {
    writeRow, toolsBlock, tokens, footer,
    mdOnce, agentTurn, userTurn, contextFold,
    optionRow, questionCard, approvalCard,
    readFeedback, setFeedback, feedbackOf,
  }
}
