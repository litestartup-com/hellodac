// The conversation page.
//
// One reducer builds the transcript, and both the replayed history and the live
// stream go through it. That is deliberate: the two used to be the classic place
// for a UI to disagree with itself, where a turn looks one way while it streams
// and another way after a refresh. Here there is only one way to draw a turn.
//
// The frame contract is the gateway's, relayed verbatim by manager, plus two
// frames manager adds of its own (`user` and `turn_done`). Verified against
// dsh-api-gateway/src/events.ts:
//
//   user        { text }                    (manager's echo; the gateway's own
//                                            copy is dropped server-side so the
//                                            bubble is not drawn twice)
//   turn_start  { turn }
//   chunk       { chunk: { type, text } }   text-delta / reasoning-delta
//   message     { text, reasoning, usage }
//   tool_call   { name, arguments }         arguments is a JSON *string*
//   tool_result { isError, text }
//   turn_end    { turn, reason, detail }
//   turn_done   { runId, state, error }     (manager's)

import { $, esc, icon, apiFetch, t, loadI18n } from './ui.js'

await loadI18n()
// 债务 F1:reducer/render/wire/composer 四层已下沉——chat.js 只编排与持有页面状态。
import { makeRenderer } from './chat-render.js'
import { makeWire } from './chat-wire.js'
import { makeComposer, fullAccessWarning, dropdownState, registerDropdown, setDropdownLabel } from './chat-composer.js'
import { makeAsks } from './chat-state.js'

const el = {
  notices: $('chat-notices'),
  queueDock: $('queue-dock'),
  delegations: $('chat-delegations'),
  log: $('chat-log'),
  composer: $('chat-composer'),
  identity: $('composer-identity'),
  modes: $('composer-modes'),
  agent: $('composer-agent'),
  path: $('composer-path'),
  access: $('composer-access'),
  model: $('composer-model'),
  effort: $('composer-effort'),
  contextWrap: $('composer-context-wrap'),
  context: $('composer-context'),
  contextPopover: $('composer-context-popover'),
  contextSummary: $('composer-context-summary'),
  contextSystem: $('composer-context-system'),
  contextTools: $('composer-context-tools'),
  contextMessages: $('composer-context-messages'),
  contextBreakdown: $('composer-context-breakdown'),
  settings: $('composer-settings'),
  controls: $('composer-controls'),
  input: $('chat-input'),
  send: $('chat-send'),
  stop: $('chat-stop'),
  queue: $('chat-queue'),
  goalBar: $('goal-bar'),
  hint: $('composer-hint'),
  toast: $('chat-toast'),
}

const segments = window.location.pathname.split('/').filter(Boolean)
const chatId = segments[0] === 'chat' && segments[1] !== undefined ? decodeURIComponent(segments[1]) : null

// ---------------------------------------------------------------------------
// 自绘下拉（模型 / 访问模式 / 推理深度）已下沉 chat-composer.js——
// dropdownState/registerDropdown/setDropdownLabel 从那里 re-export 使用。
// ---------------------------------------------------------------------------

/** Everything the last GET told us. Null until it answers. */
let state = null

// 本会话排队/刚发送、可能尚未进入 DSH 历史的消息：reload 重建列表时补画。
// 每页只对应一个 chat（chatId 来自 URL），所以页面级状态即可。
let pendingUserTexts = []
// 本会话正在排队的消息（composer 上方的队列 dock，一行一条）。
// turn_queued 帧入队、turn_start 帧出队；刷新页面即重置。
let queuedItems = []
/** Blocks built by the reducer, in transcript order. */
let blocks = []
/** True while a turn we started is still streaming. */
let sending = false
/**
 * When the live turn began, for the elapsed clock. Null when nothing is running.
 *
 * Read back from the run row on load rather than only set on send, so a refresh
 * mid-turn shows the real elapsed time instead of restarting the count -- a clock
 * that resets on F5 is worse than no clock, because it says the wait just began.
 */
let turnStartedAt = null
let modelChoices = new Map()
let modelCatalogSessionId = null
let effortSignature = null
/**
 * Frames that arrived while a full load was in flight.
 *
 * A reload reads the history server-side, so a frame delivered during the fetch
 * may or may not already be in the response. Dropping them all loses a turn that
 * another tab is streaming right now; applying them all renders the same text
 * twice. They are held here and reconciled against the history instead.
 */
let buffered = []
let loading = false

// 债务 F1:wire 层(chat-wire.js)经 refs 盒读写页面状态——本文件其余代码
// 继续用裸变量,盒子的 getter/setter 转发,状态只有一份。
const refs = {
  state: { get value() { return state }, set value(v) { state = v } },
  pendingUserTexts: { get value() { return pendingUserTexts }, set value(v) { pendingUserTexts = v } },
  queuedItems: { get value() { return queuedItems }, set value(v) { queuedItems = v } },
  blocks: { get value() { return blocks }, set value(v) { blocks = v } },
  sending: { get value() { return sending }, set value(v) { sending = v } },
  turnStartedAt: { get value() { return turnStartedAt }, set value(v) { turnStartedAt = v } },
  modelChoices: { get value() { return modelChoices }, set value(v) { modelChoices = v } },
  modelCatalogSessionId: { get value() { return modelCatalogSessionId }, set value(v) { modelCatalogSessionId = v } },
  effortSignature: { get value() { return effortSignature }, set value(v) { effortSignature = v } },
  buffered: { get value() { return buffered }, set value(v) { buffered = v } },
  loading: { get value() { return loading }, set value(v) { loading = v } },
}

const toast = (text) => {
  el.toast.textContent = text
  el.toast.classList.add('on')
  setTimeout(() => el.toast.classList.remove('on'), 2600)
}

// ---------------------------------------------------------------------------
// the reducer（已下沉 chat-reducer.js,本文件只留渲染/连线/编排）
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// rendering（已下沉 chat-render.js,本文件只留注入与编排）
// ---------------------------------------------------------------------------

/**
 * Which tool folds the user opened, by turn index.
 *
 * Held outside the markup because the transcript is re-rendered from data on
 * every frame: without this, a fold you opened would snap shut on the next
 * chunk, which during a long turn is several times a second.
 */
const openTools = new Set()

/**
 * Which injected-context folds the user opened, by block index.
 *
 * Same reason as `openTools`: the transcript is rebuilt from data on every
 * frame, so an open fold has to live outside the markup or it snaps shut.
 */
const openContext = new Set()

// 债务 F1:帧/block → HTML 的构造全部来自 chat-render.js 工厂;折叠状态
// 与会话快照注入,markdown 缓存由工厂持有(renderLog 每帧重建仍吃缓存)。
const {
  writeRow, toolsBlock, footer, agentTurn, userTurn, contextFold,
  questionCard, approvalCard, readFeedback, setFeedback,
} = makeRenderer({
  getState: () => state,
  openTools,
  openContext,
})

const EMPTY_FRESH = `<div class="chat-empty">
    <span class="chat-empty-icon">${icon('chat', 20)}</span>
    <strong>${esc(t('chat.empty.title'))}</strong>
    <p>${esc(t('chat.empty.body'))}</p>
    <p class="small">${esc(t('chat.empty.hint'))}</p>
  </div>`

/**
 * True when the transcript is scrolled to the bottom, within a few pixels.
 *
 * Checked before a redraw and restored after: a stream that always jumped to the
 * end would yank the page away from someone reading further up, and one that
 * never did would leave the text they are waiting for off screen.
 */
const atBottom = () => el.log.scrollHeight - el.log.scrollTop - el.log.clientHeight < 48

// ---------------------------------------------------------------------------
// the waiting indicator
// ---------------------------------------------------------------------------

/**
 * The turn currently being written to, if any.
 */
const liveBlock = () => {
  const last = blocks[blocks.length - 1]
  return last !== undefined && last.role === 'agent' && last.reason === null ? last : null
}

/**
 * Whether this page is waiting on a turn of its own.
 *
 * Deliberately not "is the last block unfinished": a dropped relay leaves a
 * block whose `turn_end` never came, and an indicator that spins forever teaches
 * you to ignore it. `sending` is this tab's own POST; `busyRunId` is the server's
 * account of what is running, and it is checked against this chat's runs so a
 * turn in another thread does not animate here -- the busy notice covers that.
 */
const runningHere = () => {
  if (sending) return true
  if (state === null || state.busyRunId === null) return false
  return state.turns.some((t) => t.id === state.busyRunId)
}

/**
 * What it is doing, from the last frame that said anything.
 *
 * The point is not precision, it is that the words change: a label that moves
 * from 思考 to 正在用 read to 正在回答 is evidence of progress, while one frozen
 * string is indistinguishable from a hang no matter what it says.
 */
const waitLabel = (block) => {
  // Checked before anything else, and before the block: these are the states
  // where the turn is stopped rather than slow, and any other label here is a
  // lie the clock keeps telling once a second.
  if (asks.size() > 0) return asks.size() === 1 ? t('chat.status.askingOne') : t('chat.status.askingMany', { count: asks.size() })
  if (block === null) return t('chat.status.waking')
  // No card, but the audit trail says it asked: the prompt went to whoever the
  // deployment answers with, which is not this screen.
  if (block.awaiting !== null) {
    const tool = block.awaiting.toolName === '' ? t('chat.status.aTool') : block.awaiting.toolName
    return t('chat.status.awaitApproval', { tool })
  }
  const tool = [...block.tools].reverse().find((t) => !t.done)
  if (tool !== undefined) return t('chat.status.usingTool', { tool: tool.name === '' ? t('chat.status.aTool') : tool.name })
  if (block.streaming || block.streamed !== '' || block.text !== '') return t('chat.status.answering')
  if (block.reasoning !== '') return t('chat.status.thinking')
  return t('chat.status.drafting')
}

const elapsedText = (ms) => {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return t('chat.status.seconds', { count: total })
  return t('chat.status.minutes', { minutes: Math.floor(total / 60), seconds: String(total % 60).padStart(2, '0') })
}

/* Past this, the wait stops being ordinary and the note about stopping earns its
   place. Long turns are normal here -- an agent that reads twenty files before
   answering is working, not stuck -- so the wording reassures rather than warns. */
const SLOW_AFTER_MS = 45_000

// A persistent node rather than part of the transcript markup: the clock ticks
// every second, and rebuilding the transcript that often would drop any text the
// user had selected while reading back through it.
const waitNode = document.createElement('div')
waitNode.className = 'turn from-agent waiting'
waitNode.innerHTML = `<div class="turn-who"><span class="who-avatar" aria-hidden="true">${icon('bot', 14)}</span></div>
  <div class="wait-row">
    <span class="wait-dots" aria-hidden="true"><i></i><i></i><i></i></span>
    <span class="wait-what" role="status"></span>
    <span class="wait-time" aria-hidden="true"></span>
    <span class="wait-note" aria-hidden="true"></span>
  </div>
  <div class="wait-shimmer" aria-hidden="true"></div>`

const waitParts = {
  who: waitNode.querySelector('.turn-who'),
  what: waitNode.querySelector('.wait-what'),
  time: waitNode.querySelector('.wait-time'),
  note: waitNode.querySelector('.wait-note'),
}

const paintWait = () => {
  const ms = Date.now() - (turnStartedAt ?? Date.now())
  const slow = ms >= SLOW_AFTER_MS
  const block = liveBlock()
  // Named only when it is not already answering: once a bubble is on screen it
  // carries the name, and repeating it would label the same speaker twice.
  const who = block !== null ? '' : state === null ? 'agent' : state.agent.name
  if (waitParts.who.dataset.name !== who) {
    waitParts.who.dataset.name = who
    // innerHTML, not textContent: the mark must survive the name changes.
    waitParts.who.innerHTML =
      who === ''
        ? `<span class="who-avatar" aria-hidden="true">${icon('bot', 14)}</span>`
        : `<span class="who-avatar" aria-hidden="true">${icon('bot', 14)}</span><span>${esc(who)}</span>`
  }
  // Assigned only on change: this runs every second, and rewriting the text of a
  // node inside `role="status"` re-announces it to a screen reader each time.
  const what = waitLabel(block)
  if (waitParts.what.textContent !== what) waitParts.what.textContent = what
  waitParts.time.textContent = elapsedText(ms)
  waitParts.note.textContent = slow ? t('chat.wait.slowNote') : ''
  waitNode.classList.toggle('slow', slow)
}

let waitTimer = null

// ---------------------------------------------------------------------------
// the asks: questions and permission prompts waiting on this person
// ---------------------------------------------------------------------------

/**
 * What the agent is blocked on, by id, in arrival order.
 *
 * Kept outside `blocks` because these are not transcript: they are live state
 * the gateway opens and closes, and the reducer rebuilds `blocks` from scratch
 * on every frame. Cards live in their own persistent node for the same reason
 * the waiting indicator does -- a redraw mid-answer must not swallow the text
 * someone is typing into one.
 */
// 债务 F1:asks 状态机已下沉 chat-state.js(makeAsks/track 纯函数,7 例单测);
// 本文件保留 syncAsks 的 DOM 挂载与 askNode。
const asks = makeAsks()
const trackAsks = asks.track

/** Only rebuild the cards when the set of asks actually changes. */
const asksSignature = () => asks.entries().map(([key]) => key).join('|')
let paintedAsks = null

const askNode = document.createElement('div')
askNode.className = 'asks'

// 债务 F1:卡片构造(optionRow/questionCard/approvalCard)已下沉 chat-render.js。

/**
 * Attaches the cards, rebuilding them only when the asks changed.
 *
 * The guard is what makes a half-typed answer safe: without it every arriving
 * frame would replace the input the person is using.
 */
const syncAsks = () => {
  if (asks.size() === 0) {
    askNode.remove()
    askNode.innerHTML = ''
    paintedAsks = null
    return
  }
  const signature = asksSignature()
  if (signature !== paintedAsks) {
    askNode.innerHTML = asks.entries().map(([, ask]) => (ask.kind === 'approval' ? approvalCard(ask) : questionCard(ask))).join('')
    paintedAsks = signature
  }
  el.log.append(askNode)
}

/** Collect one card's answers, or the reason it cannot be sent yet. */
const gatherAnswers = (card, ask) => {
  const answers = []
  for (const question of ask.questions) {
    const scope = card.querySelector(`.ask-q[data-q="${CSS.escape(question.id)}"]`)
    if (scope === null) return { error: t('chat.ask.cardGone') }
    const selected = Array.from(scope.querySelectorAll('.ask-opt.on')).map((node) => node.dataset.label)
    const custom = scope.querySelector('.ask-custom').value.trim()
    if (selected.length === 0 && custom === '') {
      return { error: (question.options ?? []).length === 0 ? t('chat.ask.answerFree') : t('chat.ask.answerPick') }
    }
    answers.push({ id: question.id, selected, ...(custom === '' ? {} : { custom }) })
  }
  return { answers }
}

const postAsk = async (card, path, body) => {
  const error = card.querySelector('.ask-error')
  const buttons = Array.from(card.querySelectorAll('button'))
  for (const button of buttons) button.disabled = true
  error.textContent = ''
  try {
    const response = await apiFetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}))
      // Re-enabled rather than removed: the answer was refused, so the card is
      // still the thing that has to be corrected and sent again.
      for (const button of buttons) button.disabled = false
      error.textContent = payload.detail ?? t('chat.send.failedDetail', { status: response.status })
      return
    }
    // The card is removed by the gateway's own `question_resolved` /
    // `approval_resolved` frame, not here: it is the gateway that decides the
    // ask is closed, and it also closes it when someone else answers first.
    card.classList.add('sent')
  } catch (failure) {
    for (const button of buttons) button.disabled = false
    error.textContent = t('chat.send.failed', { message: failure.message })
  }
}

askNode.addEventListener('click', (event) => {
  const target = event.target.closest === undefined ? null : event.target
  if (target === null) return

  const option = target.closest('.ask-opt')
  if (option !== null) {
    const group = option.parentElement
    // Single-select behaves like radios; multi-select toggles. Enforced here as
    // well as in the gateway, so the shape of the card matches what it accepts.
    // aria-checked follows the visual state (DSH QuestionComposer 语义).
    if (!group.classList.contains('multi')) {
      for (const sibling of group.querySelectorAll('.ask-opt.on')) {
        if (sibling !== option) {
          sibling.classList.remove('on')
          sibling.setAttribute('aria-checked', 'false')
        }
      }
    }
    option.classList.toggle('on')
    option.setAttribute('aria-checked', option.classList.contains('on') ? 'true' : 'false')
    return
  }

  const button = target.closest('.ask-send, .ask-skip, .ask-allow, .ask-reject')
  if (button === null) return
  const ask = asks.get(button.dataset.ask)
  const card = button.closest('.ask')
  if (ask === undefined || card === null) return

  if (button.classList.contains('ask-allow') || button.classList.contains('ask-reject')) {
    const outcome = button.classList.contains('ask-allow') ? 'allowed-once' : 'rejected'
    void postAsk(card, `/api/chats/${encodeURIComponent(chatId)}/approvals/${encodeURIComponent(ask.id)}`, {
      outcome,
      approvalId: ask.approvalId ?? undefined,
    })
    return
  }
  if (button.classList.contains('ask-skip')) {
    void postAsk(card, `/api/chats/${encodeURIComponent(chatId)}/questions/${encodeURIComponent(ask.id)}`, { decline: true })
    return
  }
  const gathered = gatherAnswers(card, ask)
  if (gathered.error !== undefined) {
    card.querySelector('.ask-error').textContent = gathered.error
    return
  }
  void postAsk(card, `/api/chats/${encodeURIComponent(chatId)}/questions/${encodeURIComponent(ask.id)}`, { answers: gathered.answers })
})

/**
 * Attaches or detaches the indicator, and runs the clock only while it is shown.
 *
 * Called from `renderLog`, which has just replaced the log's contents, so the
 * node has to be re-attached rather than assumed present.
 */
const syncWait = () => {
  if (!runningHere()) {
    if (waitTimer !== null) {
      clearInterval(waitTimer)
      waitTimer = null
    }
    waitNode.remove()
    return
  }
  paintWait()
  el.log.append(waitNode)
  if (waitTimer === null) {
    waitTimer = setInterval(() => {
      if (!runningHere()) {
        syncWait()
        return
      }
      // Only the clock's own text changes, so the transcript above it is left
      // exactly as it was -- scroll position, selection and open folds included.
      paintWait()
    }, 1000)
  }
}

// ---------------------------------------------------------------------------
// scroll-to-bottom control
// ---------------------------------------------------------------------------
//
// DSH's ChatView toBottom, adapted: a persistent node (like askNode) because
// renderLog replaces the transcript's innerHTML on every frame. Sticky to the
// log's bottom edge, hidden while the end is already in view.
const toBottomSlot = document.createElement('div')
toBottomSlot.className = 'to-bottom-slot'
toBottomSlot.hidden = true
toBottomSlot.innerHTML = `<button type="button" class="to-bottom" aria-label="${esc(t('chat.toBottom'))}" title="${esc(t('chat.toBottom'))}">${icon('down', 16)}</button>`

const syncToBottom = () => {
  const overflow = el.log.scrollHeight - el.log.clientHeight
  toBottomSlot.hidden = overflow <= 8 || atBottom()
}

/** Re-attach after a rebuild and recompute visibility. */
const reattachToBottom = () => {
  el.log.append(toBottomSlot)
  syncToBottom()
}

toBottomSlot.querySelector('button').addEventListener('click', () => {
  const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  el.log.scrollTo({ top: el.log.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
})

el.log.addEventListener('scroll', syncToBottom)
window.addEventListener('resize', syncToBottom)

const renderLog = () => {
  const pinned = atBottom()
  // A turn can be running before its first frame has arrived, and "还没有消息"
  // under a message you just sent is the exact false impression this whole
  // indicator exists to prevent.
  if (blocks.length === 0 && !runningHere()) {
    el.log.innerHTML = EMPTY_FRESH
    // Still synced: the innerHTML above detached the card node, and a card that
    // is open has to come back even on an otherwise empty screen.
    syncAsks()
    reattachToBottom()
    return
  }
  if (blocks.length === 0) {
    el.log.innerHTML = ''
    syncAsks()
    syncWait()
    el.log.scrollTop = el.log.scrollHeight
    reattachToBottom()
    return
  }

  // Consecutive injected blocks become one fold rather than one each: the
  // harness sends them in runs, and three folds in a row is the same wall of
  // text with more clicks.
  const html = []
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i]
    if (block.role === 'user' && block.injected === true) {
      const group = []
      const start = i
      while (i < blocks.length && blocks[i].role === 'user' && blocks[i].injected === true) {
        group.push(blocks[i])
        i += 1
      }
      i -= 1
      html.push(contextFold(group, start))
      continue
    }
    // The closing line (stats + copy/feedback) belongs to the reply, not to
    // every intermediate agent block of a multi-step run: only the last agent
    // block before a user message -- or the end of the transcript -- gets it.
    const nextIsAgent = i + 1 < blocks.length && blocks[i + 1].role === 'agent'
    html.push(block.role === 'user' ? userTurn(block) : agentTurn(block, i, !nextIsAgent))
  }

  el.log.innerHTML = html.join('')
  // Before the waiting indicator: the card is the thing to act on, the clock
  // below it is only commentary.
  syncAsks()
  syncWait()
  reattachToBottom()
  if (pinned) el.log.scrollTop = el.log.scrollHeight
}

/**
 * Coalesces redraws into one per animation frame.
 *
 * `chunk` frames arrive far faster than the screen refreshes, so rendering each
 * one would rebuild the transcript dozens of times per second to show text the
 * eye cannot follow anyway.
 */
let pending = false
const render = () => {
  if (pending) return
  pending = true
  requestAnimationFrame(() => {
    pending = false
    renderHead()
    renderNotices()
    renderLog()
    renderComposer()
  })
}

// Remembered on toggle, since the next redraw builds the fold from data.
//
// Captured rather than bubbled: `toggle` does not bubble, so a delegated
// listener on the container only ever sees it during the capture phase.
el.log.addEventListener(
  'toggle',
  (event) => {
    const target = event.target
    if (target.closest === undefined) return

    const tools = target.closest('.tools')
    if (tools !== null) {
      const index = Number(tools.dataset.fold)
      if (tools.open) openTools.add(index)
      else openTools.delete(index)
      return
    }

    const context = target.closest('.context')
    if (context !== null) {
      const index = Number(context.dataset.context)
      if (context.open) openContext.add(index)
      else openContext.delete(index)
    }
  },
  { capture: true },
)

// Reply actions (copy / up / down), delegated: the transcript is rebuilt from
// data on every frame, so a listener on a per-turn control would be attached to
// a node that no longer exists.
el.log.addEventListener('click', (event) => {
  // Code block copy (DSH CodeBlock banner button). Delegated: the transcript is
  // rebuilt from data on every frame, so a listener per block would be attached
  // to a node that no longer exists.
  const copy = event.target.closest('.md-copy')
  if (copy !== null) {
    const code = copy.closest('.md-code-block')?.querySelector('pre code')
    const text = code === null || code === undefined ? '' : code.textContent
    if (text !== '') {
      void navigator.clipboard.writeText(text).then(() => {
        copy.textContent = t('chat.copied')
        setTimeout(() => { copy.textContent = t('chat.copy') }, 1500)
      }).catch(() => {})
    }
    return
  }

  const act = event.target.closest('.turn-act')
  if (act === null) return

  if (act.dataset.act === 'copy') {
    const block = blocks[Number(act.dataset.copy)]
    const text = block === undefined ? '' : block.text !== '' ? block.text : block.streamed
    if (text !== '') {
      void navigator.clipboard
        ?.writeText(text)
        .then(() => toast(t('chat.copied')))
        .catch(() => toast(t('chat.copyFailed')))
    }
    return
  }

  const turnId = act.dataset.turn ?? ''
  if (turnId === '') return
  const kind = act.dataset.act
  const next = readFeedback()[turnId] === kind ? null : kind
  setFeedback(turnId, next)
  toast(next === null ? t('chat.feedback.undone') : kind === 'up' ? t('chat.feedback.up') : t('chat.feedback.down'))
  render()
})

// ---------------------------------------------------------------------------
// header, notices, composer
// ---------------------------------------------------------------------------

const chatTitle = () => {
  if (state === null) return t('chat.defaultTitle')
  // 变量名不要用 t：它会遮蔽 ui.js 的翻译函数（2026-09-24 线上事故）。
  const title = state.chat.title
  return title === null || title === '' ? t('side.newChat') : title
}

const renderHead = () => {
  if (state === null) return
  // No header element on this page any more (DSH's own view leads with the
  // transcript); the title still belongs in the tab and in the narrow-screen
  // app bar, which is the only place a title appears there.
  const title = chatTitle()
  document.title = `${title} · ${state.agent.name} · DAC`
  window.dispatchEvent(new CustomEvent('shell:title', { detail: title }))
}

const strip = (level, html) => `<div class="state-strip ${level}">${icon('alert', 13)}<span>${html}</span></div>`

/**
 * The queued-turn dock above the composer (DSH-style): one row per queued
 * message, single-line ellipsis, newest at the bottom of the list.
 */
const renderQueueDock = () => {
  if (queuedItems.length === 0) {
    el.queueDock.hidden = true
    el.queueDock.innerHTML = ''
    return
  }
  el.queueDock.hidden = false
  el.queueDock.innerHTML = queuedItems
    .map(
      (item) =>
        `<div class="queue-row" data-id="${esc(item.id)}">` +
        `<span class="queue-badge">${esc(t('chat.queue.badge'))}</span>` +
        `<span class="queue-text" title="${esc(item.text)}">${esc(item.text)}</span>` +
        `<button type="button" class="queue-act" data-action="edit" title="${esc(t('chat.queue.edit'))}">${icon('pencil', 13)}</button>` +
        `<button type="button" class="queue-act" data-action="delete" title="${esc(t('chat.queue.delete'))}">${icon('trash', 13)}</button>` +
        `</div>`,
    )
    .join('')
}

/**
 * Edit pulls the queued text back into the composer (undo); delete drops it.
 * Both call the same idempotent cancel endpoint and remove the row locally.
 * (实现已下沉 chat-composer.js)
 */

const renderNotices = () => {
  if (state === null) return
  const out = []

  // `cold` is deliberately NOT a strip any more: it is a normal state that
  // costs the reader nothing until they are about to type. It lives in the
  // composer's hint line instead -- the place the action actually happens.
  if (state.sessionState === 'lost') {
    out.push(strip('bad', t('chat.dead')))
  }

  el.notices.innerHTML = out.join('')
  renderQueueDock()
  renderGoalBar()
}

// ---------------------------------------------------------------------------
// Ongoing Goal 条（DSH web 同款：读宿主 goal 投影，仅显示不操作）
// ---------------------------------------------------------------------------

const GOAL_PHASES = {
  active: t('chat.goal.active'),
  paused: t('chat.goal.paused'),
  blocked: t('chat.goal.blocked'),
}

const renderGoalBar = () => {
  if (el.goalBar === null) return
  const goal = state?.goal ?? null
  // 无目标、目标已完成（或投影形状不符）都不占地方——与 DSH web 一致。
  if (goal === null || goal === undefined || goal.phase === 'complete' || typeof goal.objective !== 'string') {
    el.goalBar.hidden = true
    el.goalBar.innerHTML = ''
    return
  }
  const label = GOAL_PHASES[goal.phase] ?? t('chat.goal.generic')
  const blocked = goal.phase === 'blocked' && typeof goal.blockedReason === 'string' && goal.blockedReason !== ''
    ? goal.blockedReason
    : null
  el.goalBar.hidden = false
  el.goalBar.innerHTML =
    `<span class="goal-glyph">${icon('spark', 14)}</span>` +
    `<span class="goal-label"${blocked === null ? '' : ` title="${esc(blocked)}"`}>${esc(label)}</span>` +
    `<span class="goal-objective" title="${esc(goal.objective)}">${esc(goal.objective)}</span>`
}

// ---------------------------------------------------------------------------
// composer（渲染/发送/模型/权限/上下文,已下沉 chat-composer.js,本文件接线）
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// loading + live stream（已下沉 chat-wire.js,本文件只接线）
// ---------------------------------------------------------------------------

// 债务 F1:wire 层——加载/重载/SSE 帧分发全部在 chat-wire.js,状态经 refs
// 盒读写,渲染与卡片回调注入。chat.js 只持有 { connect, disconnect, reload }。
// 注意顺序:reload 要先于 makeComposer 初始化(composer 的 send 依赖它),否则
// 模块求值期就会踩 TDZ(Uncaught ReferenceError: Cannot access 'reload')。
const { connect, disconnect, reload } = makeWire(refs, {
  chatId,
  el,
  render,
  trackAsks,
  resetAsks: () => asks.clear(),
  reattachToBottom,
  dropdownState,
  setDropdownLabel,
})

const grow = () => {
  el.input.style.height = 'auto'
  el.input.style.height = `${el.input.scrollHeight}px`
}

// 债务 F1:composer 层——renderComposer/send/cancel/selectModel/cancelQueued/
// syncAccessOptions 全部在 chat-composer.js;纯函数 modelKey/shortPath 同源。
const composer = makeComposer(refs, {
  chatId,
  el,
  toast,
  render,
  reload,
  grow,
  dropdownState,
  setDropdownLabel,
})
const { renderComposer, syncAccessOptions, send, cancel, selectModel, cancelQueued } = composer

// ---- remaining header/notices helpers ----

// ---------------------------------------------------------------------------
// sending（send/cancel/selectModel 已下沉 chat-composer.js,本文件只绑事件）
// ---------------------------------------------------------------------------

el.composer.addEventListener('submit', (event) => {
  event.preventDefault()
  void send()
})

if (el.access !== null) {
  registerDropdown(el.access, (mode) => {
    if (mode !== 'read-only' && mode !== 'workspace-write' && mode !== 'danger-full-access') return
    if (mode === 'danger-full-access') {
      const form = state?.composer?.capabilities?.fullAccessForm ?? 'bare-metal'
      if (!window.confirm(fullAccessWarning(form))) return
    }
    void (async () => {
      el.access.disabled = true
      try {
        const response = await apiFetch(`/api/chats/${encodeURIComponent(chatId)}/sandbox-mode`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode }),
        })
        const body = await response.json().catch(() => ({}))
        if (!response.ok) {
          toast(body.detail ?? t('chat.access.switchFailed', { status: response.status }))
          render()
          return
        }
        state.composer = { ...(state.composer ?? {}), accessMode: body.accessMode }
        toast(body.deferred === true ? t('chat.access.deferred') : t('chat.access.updated'))
      } catch (error) {
        toast(t('chat.access.switchFailedMsg', { message: error.message }))
      }
      render()
    })()
  })
  const accEntry = dropdownState.get(el.access)
  if (accEntry !== undefined) {
    syncAccessOptions()
    accEntry.value = 'read-only'
  }
}

if (el.model !== null) {
  registerDropdown(el.model, (key) => {
    const choice = modelChoices.get(key)
    if (choice === undefined) return
    void selectModel({ provider: choice.provider, model: choice.model })
  })
}

if (el.effort !== null) {
  registerDropdown(el.effort, (reasoningEffort) => {
    const selection = state?.composer?.model
    if (selection === null || selection === undefined) return
    void selectModel({
      provider: selection.provider,
      model: selection.model,
      ...(reasoningEffort === '' ? {} : { reasoningEffort }),
    })
  })
}

if (el.settings !== null && el.identity !== null) {
  const closeSettings = () => {
    el.identity.classList.remove('settings-open')
    el.settings.setAttribute('aria-expanded', 'false')
  }
  el.settings.addEventListener('click', () => {
    const open = !el.identity.classList.contains('settings-open')
    el.identity.classList.toggle('settings-open', open)
    el.settings.setAttribute('aria-expanded', String(open))
  })
  document.addEventListener('pointerdown', (event) => {
    if (!el.identity.classList.contains('settings-open') || event.target instanceof Node && el.identity.contains(event.target)) return
    closeSettings()
  })
}

if (el.context !== null && el.contextPopover !== null && el.contextWrap !== null) {
  el.context.addEventListener('click', () => {
    const open = el.contextPopover.hidden
    el.contextPopover.hidden = !open
    el.context.setAttribute('aria-expanded', String(open))
  })
  document.addEventListener('pointerdown', (event) => {
    if (el.contextPopover.hidden || event.target instanceof Node && el.contextWrap.contains(event.target)) return
    el.contextPopover.hidden = true
    el.context.setAttribute('aria-expanded', 'false')
  })
}

el.input.addEventListener('input', () => {
  grow()
  el.send.disabled = el.input.value.trim() === '' || sending
  // 排队按钮：回合运行中输入非空时浮现（方案 C，2026-09-11）。
  const turnRunning = state?.turns.some((t) => t.state === 'running') ?? false
  el.queue.hidden = !(turnRunning && !sending && el.input.value.trim() !== '')
})

el.input.addEventListener('keydown', (event) => {
  // Enter sends, Shift+Enter breaks the line -- the convention every chat client
  // shares, including DSH.
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    void send()
  }
})

el.stop.addEventListener('click', () => void cancel())

// 排队发送：回合运行中主槽被停止方块占用，这个 ghost 箭头补上「再发一条」。
el.queue.addEventListener('click', () => void send())

// Queued-turn dock actions: edit (undo into the composer) and delete.
el.queueDock.addEventListener('click', (event) => {
  const button = event.target.closest('.queue-act')
  if (button === null) return
  const row = button.closest('.queue-row')
  if (row === null) return
  void cancelQueued(row, button.dataset.action)
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && el.identity !== null && el.identity.classList.contains('settings-open')) {
    el.identity.classList.remove('settings-open')
    el.settings?.setAttribute('aria-expanded', 'false')
    return
  }
  if (event.key === 'Escape' && el.contextPopover !== null && !el.contextPopover.hidden) {
    el.contextPopover.hidden = true
    el.context?.setAttribute('aria-expanded', 'false')
    return
  }
  // Esc = 停止生成：与主槽停止方块的可见窗口一致（发送中 + 整个回合运行期）。
  const turnRunning = state?.turns.some((t) => t.state === 'running') ?? false
  if (event.key === 'Escape' && (sending || turnRunning)) void cancel()
})

// ---------------------------------------------------------------------------
// thread actions
// ---------------------------------------------------------------------------
//
// Rename and archive used to live in the page header. That header is gone (the
// page now leads with the transcript, like DSH), and both actions already
// exist on the sidebar's row menu -- shell.js owns them, so this page keeps no
// copy. Deleting the handlers here must stay deleted: their buttons no longer
// exist in the DOM.

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

// A phone that has been in a pocket comes back with a dead socket and a stale
// transcript. Reload on return rather than waiting for the next frame -- and give
// the connection back while away, since a hidden page has nothing to draw with
// it.
document.addEventListener('visibilitychange', () => {
  if (chatId === null) return
  if (document.visibilityState === 'visible') {
    void reload()
    connect()
  } else {
    disconnect()
  }
})

// Leaving the page. `pagehide` rather than `unload`, which disqualifies the page
// from the back/forward cache and is exactly the event that does not fire when a
// page is frozen into it.
window.addEventListener('pagehide', disconnect)

if (chatId === null) {
  // `/chat` with no id. The sidebar is the chat list, so this only has to say so
  // rather than build a second one.
  el.identity.hidden = true
  el.composer.hidden = true
  el.log.innerHTML = `<div class="chat-empty">
      <p>${esc(t('chat.pickSession'))}</p>
    </div>`
  reattachToBottom()
} else {
  void reload()
  connect()
}
