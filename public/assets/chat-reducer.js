// 债务 F1:chat.js 拆分第一步——纯 reducer(转录的唯一画法)。
//
// 帧 → block 列表的折叠逻辑,从 chat.js 原样搬出,无 DOM、无页面状态依赖,
// 可独立单测(chat-reducer.test.mjs)。chat.js 的 live stream 与 load 重建
// 共用它,保证「流式时一个样、刷新后一个样」。
//
// 帧契约见 chat.js 头注释(gateway 帧 + manager 自产 user/turn_done)。

import { t, loadI18n } from './ui.js'

await loadI18n()

/**
 * A fresh agent block. All turn state starts empty; frames fill it in.
 */
export const newAgentBlock = () => ({
  role: 'agent',
  /** Set by `message` frames, which are authoritative. */
  text: '',
  /** Built from `chunk` frames, shown only until a message replaces it. */
  streamed: '',
  streaming: false,
  reasoning: '',
  tools: [],
  usage: null,
  /** turn_end reason, once the turn is over. */
  reason: null,
  error: null,
  runId: null,
  runState: null,
  /**
   * The permission prompt this turn is stopped on, or null.
   *
   * Worth its own field rather than a tool flag: while this is set the turn is
   * not working at all, and the waiting indicator would otherwise keep claiming
   * it is "正在用 write_file" -- the exact reading that makes someone hit refresh
   * on a turn that was never going to move on its own.
   */
  awaiting: null,
})

/**
 * Adds one usage object into another.
 *
 * A turn can emit several `message` frames and each carries its own usage, so
 * the footer has to sum them. `chunk` frames are skipped entirely: their usage
 * is a running total, and counting it would inflate every turn (UI.md §5).
 */
export const addUsage = (into, usage) => {
  if (usage === null || usage === undefined) return into
  const base = into ?? { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 }
  return {
    inputTokens: base.inputTokens + (usage.inputTokens ?? 0),
    outputTokens: base.outputTokens + (usage.outputTokens ?? 0),
    reasoningTokens: base.reasoningTokens + (usage.reasoningTokens ?? 0),
  }
}

/**
 * Pulls a file path out of a tool call's arguments.
 *
 * The tool names come from DSH, not from manager or the gateway -- neither repo
 * declares them -- so this reads the argument shape instead of matching a name
 * list that would silently stop matching after an upstream rename. Several
 * spellings are accepted for the same reason.
 */
const PATH_KEYS = ['path', 'file_path', 'filePath', 'file', 'target', 'filename']

export const toolPath = (args) => {
  if (args === null || typeof args !== 'object') return null
  for (const key of PATH_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return null
}

/**
 * Whether a tool call changed the workspace.
 *
 * A name heuristic, and knowingly one: the real tool list lives in DSH. It errs
 * towards showing the row, because a write that is not announced is the failure
 * that matters here -- a read shown as a write is merely noise.
 */
const WRITE_HINT = /write|edit|create|save|append|patch|replace|update|insert|move|rename|mkdir|delete|remove/i

export const isWrite = (name) => WRITE_HINT.test(name)

export const parseArgs = (raw) => {
  if (typeof raw !== 'string' || raw === '') return null
  try {
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    // Arguments arrive as a provider-produced string and can be truncated
    // mid-stream. An unparseable one costs the path, not the row.
    return null
  }
}

/**
 * Whether a `user` event is context DSH injected rather than something typed.
 *
 * Two signals, because one is not enough. Verified against a real transcript
 * (`GET /sessions/:id/history`): of five user events in one session, two were
 * wrapped in `<system-reminder>` -- and a third, "Current runtime context. This
 * snapshot supersedes...", carried no marker at all. Matching the tag alone
 * would have folded two thirds of the noise and left the rest.
 *
 * So the second signal is structural: within a turn the user speaks once, and
 * any further user event before the agent answers came from the harness. That
 * survives an upstream change of wording, which a prefix match would not.
 * manager's own live echo is always the first, so it is never folded.
 *
 * Being wrong here is cheap in one direction only: a folded message is one click
 * away, while an unfolded reminder buries the conversation. Hence erring toward
 * folding.
 */
const WRAPPED_REMINDER = /^\s*<system-reminder>[\s\S]*<\/system-reminder>\s*$/

export const isInjected = (text, previous) => {
  if (WRAPPED_REMINDER.test(text)) return true
  return previous !== undefined && previous.role === 'user'
}

/**
 * Folds one frame into the block list.
 *
 * `open` is the agent block currently being written to. A turn without a
 * `turn_start` still gets one, because the first `chunk` or `message` opens it:
 * the gateway does not promise `turn_start` on a resumed session.
 */
export const reduce = (list, frame) => {
  const last = list[list.length - 1]
  const open = last !== undefined && last.role === 'agent' && last.reason === null ? last : null
  const agent = () => {
    if (open !== null) return open
    const created = newAgentBlock()
    list.push(created)
    return created
  }

  switch (frame.kind) {
    case 'user': {
      const text = typeof frame.text === 'string' ? frame.text : ''
      list.push({
        role: 'user',
        text,
        injected: isInjected(text, last),
        at: frame.at ?? null,
      })
      return list
    }

    case 'turn_start':
      return list

    case 'chunk': {
      const chunk = frame.chunk
      if (chunk === null || typeof chunk !== 'object') return list
      const block = agent()
      const text = typeof chunk.text === 'string' ? chunk.text : ''
      if (chunk.type === 'text-delta') {
        block.streamed += text
        block.streaming = true
      } else if (chunk.type === 'reasoning-delta') {
        block.reasoning += text
      }
      return list
    }

    case 'message': {
      const block = agent()
      const text = typeof frame.text === 'string' ? frame.text : ''
      // The message frame is the authority; the streamed text was a preview of
      // this same content and is dropped rather than appended to.
      if (text !== '') block.text = block.text === '' ? text : `${block.text}${text}`
      block.streamed = ''
      block.streaming = false
      if (typeof frame.reasoning === 'string' && frame.reasoning !== '') block.reasoning = frame.reasoning
      block.usage = addUsage(block.usage, frame.usage)
      return list
    }

    // The turn has stopped on a permission decision nobody can make from here
    // (answering approvals over the API is not built yet). Recorded so the wait
    // says so, instead of looking like slow work.
    case 'approval_asked': {
      const block = agent()
      block.awaiting = {
        toolName: typeof frame.toolName === 'string' ? frame.toolName : '',
        reason: typeof frame.reason === 'string' ? frame.reason : '',
      }
      return list
    }

    // Decided, one way or another -- including the fail-closed 'unavailable' of a
    // deployment with no answerer. Either way the turn is moving again, so the
    // wait goes back to describing work.
    case 'approval_decided': {
      const block = agent()
      block.awaiting = null
      return list
    }

    case 'tool_call': {
      const block = agent()
      const name = typeof frame.name === 'string' ? frame.name : ''
      const args = parseArgs(frame.arguments)
      block.tools.push({
        name,
        args,
        raw: typeof frame.arguments === 'string' ? frame.arguments : '',
        path: toolPath(args),
        write: isWrite(name),
        failed: false,
        done: false,
        resultText: '',
      })
      return list
    }

    case 'tool_result': {
      const block = agent()
      // Results arrive in call order, so the newest unresolved call is this one.
      const pending = [...block.tools].reverse().find((t) => !t.done)
      if (pending !== undefined) {
        pending.done = true
        pending.failed = frame.isError === true
        pending.resultText = typeof frame.text === 'string' ? frame.text : ''
      }
      return list
    }

    case 'turn_end': {
      const block = agent()
      block.reason = typeof frame.reason === 'string' ? frame.reason : 'unknown'
      block.streaming = false
      const detail = frame.detail ?? null
      if (block.reason === 'error') block.error = detail?.message ?? t('chat.reducer.errorEnd')
      if (block.reason === 'aborted') block.error = detail?.cause === 'user_cancelled' ? t('chat.reducer.cancelled') : t('chat.reducer.interrupted')
      return list
    }

    case 'turn_done': {
      // manager's own frame, carrying what the run row will say. It can arrive
      // for a turn that never produced a turn_end (a timeout, a dropped stream),
      // so it opens a block if there is none.
      const block = agent()
      block.runId = frame.runId ?? null
      block.runState = frame.state ?? null
      if (block.reason === null) block.reason = frame.state === 'done' ? 'completed' : 'error'
      block.streaming = false
      if (typeof frame.error === 'string' && frame.error !== '') block.error = frame.error
      return list
    }

    default:
      return list
  }
}

/**
 * Attaches cost and duration from the run rows.
 *
 * Matched by position, and only when the counts agree. A conversation records
 * exactly one run per message, so the Nth agent block is the Nth run -- but a
 * turn that failed before emitting anything leaves a run row with no block, and
 * then every later pairing would be off by one. Attributing one turn's cost to
 * another is worse than leaving the footer without a price, so a mismatch drops
 * the money rather than guessing.
 */
export const attachRuns = (list, turns) => {
  const agentBlocks = list.filter((b) => b.role === 'agent')
  if (turns.length !== agentBlocks.length) return list
  agentBlocks.forEach((block, index) => {
    const run = turns[index]
    block.run = run
    if (block.runId === null) block.runId = run.id
    if (block.runState === null) block.runState = run.state
    if (block.error === null && run.error !== null) block.error = run.error
  })
  return list
}

/** The transcript as the server last described it. */
export const build = (events, turns) => {
  let list = []
  for (const frame of events) list = reduce(list, frame)
  return attachRuns(list, turns)
}
