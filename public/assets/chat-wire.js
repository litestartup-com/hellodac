// 债务 F1:chat.js 拆分第三步——wire 层(加载/重载/SSE 帧分发)。
//
// 与 render 层对称:全部状态经 refs(getter/setter 盒)注入,帧分发逻辑
// handleFrame 是纯函数(依赖注入),可独立单测(chat-wire.test.mjs)。
// chat.js 只把 refs/deps 接好,自身不再持有加载与流逻辑。

import { esc, icon, apiFetch, uniqueFrames, autoReconnect, t, loadI18n } from './ui.js'

await loadI18n()
import { reduce, build } from './chat-reducer.js'

/**
 * Whether the loaded history already contains this frame.
 *
 * Gateway frames carry `seq`, which is exactly the discriminator needed: the
 * history's own events carry it too, so anything at or below the highest seq in
 * the history is a frame we have just been given a second time.
 *
 * manager's two own frames have no seq. `turn_done` only sets fields and is safe
 * to apply twice. Its `user` echo is compared by text against the newest user
 * block, because the gateway records the message as an event of its own, so the
 * history usually already holds it.
 */
export const alreadyLoaded = (frame, maxSeq, list) => {
  if (typeof frame.seq === 'number') return frame.seq <= maxSeq
  if (frame.kind !== 'user') return false
  const lastUser = [...list].reverse().find((b) => b.role === 'user')
  return lastUser !== undefined && lastUser.text === frame.text
}

/**
 * @param {{
 *   state: { value: any };
 *   pendingUserTexts: { value: any[] };
 *   queuedItems: { value: any[] };
 *   blocks: { value: any[] };
 *   sending: { value: boolean };
 *   turnStartedAt: { value: number | null };
 *   modelChoices: { value: Map<string, any> };
 *   modelCatalogSessionId: { value: string | null };
 *   buffered: { value: any[] };
 *   loading: { value: boolean };
 * }} refs
 * @param {{
 *   chatId: string;
 *   el: Record<string, any>;
 *   render: () => void;
 *   trackAsks: (frame: any) => void;
 *   resetAsks: () => void;
 *   reattachToBottom: () => void;
 *   dropdownState: Map<any, any>;
 *   setDropdownLabel: (button: any, label: string) => void;
 * }} deps
 */
export const makeWire = (refs, deps) => {
  const { chatId, el } = deps

  /**
   * Whether the loaded history already contains this frame.
   *
   * Gateway frames carry `seq`, which is exactly the discriminator needed: the
   * history's own events carry it too, so anything at or below the highest seq in
   * the history is a frame we have just been given a second time.
   *
   * manager's two own frames have no seq. `turn_done` only sets fields and is safe
   * to apply twice. Its `user` echo is compared by text against the newest user
   * block, because the gateway records the message as an event of its own, so the
   * history usually already holds it.
   */
  const alreadyLoaded = (frame, maxSeq, list) => {
    if (typeof frame.seq === 'number') return frame.seq <= maxSeq
    if (frame.kind !== 'user') return false
    const lastUser = [...list].reverse().find((b) => b.role === 'user')
    return lastUser !== undefined && lastUser.text === frame.text
  }

  const fatal = (message) => {
    el.log.innerHTML = `<div class="chat-empty"><p>${esc(message)}</p></div>`
    deps.reattachToBottom()
    el.input.disabled = true
    el.send.disabled = true
  }

  /**
   * 蜂群 P2/P3：主脑派工记录（delegation 帧）。
   *
   * 与 transcript 分开的独立区块：帧数据来自 run 表（source_chat_id），不是
   * 会话历史；按时间与消息流精确交错代价高、收益小，MVP 先平铺在转录上方。
   * 实时更新 = relay 上的 delegation_done 帧 → 重新拉取。
   */
  const DELEGATION_ICON = { done: '✓', failed: '✕', running: '…', pending: '…' }
  const DELEGATION_CLASS = { done: 'ok', failed: 'bad', running: 'warn', pending: 'warn' }

  const renderDelegations = (list) => {
    if (el.delegations === null) return
    if (list.length === 0) {
      el.delegations.hidden = true
      el.delegations.innerHTML = ''
      return
    }
    el.delegations.hidden = false
    el.delegations.innerHTML = list
      .map((d) => {
        const glyph = DELEGATION_ICON[d.state] ?? '…'
        const cls = DELEGATION_CLASS[d.state] ?? 'muted'
        const summary = typeof d.summary === 'string' && d.summary !== '' ? d.summary : (typeof d.error === 'string' && d.error !== '' ? d.error : '')
        const detail = summary !== '' ? `<span class="delegation-body">${esc(summary)}</span>` : ''
        return `<div class="delegation ${cls}">
        <span class="delegation-icon" aria-hidden="true">${glyph}</span>
        <span class="delegation-main">
          <span class="delegation-head">${esc(t('chat.delegation', { agent: d.agentName ?? d.agentId, state: d.state }))}</span>
          ${detail}
        </span>
      </div>`
      })
      .join('')
  }

  const loadDelegations = async () => {
    try {
      const response = await apiFetch(`/api/chats/${encodeURIComponent(chatId)}/delegations`)
      if (!response.ok) return
      const body = await response.json()
      renderDelegations(Array.isArray(body.delegations) ? body.delegations : [])
    } catch {
      // 非主脑会话本就没有派工记录；接口异常也不值得打断对话。
    }
  }

  const loadModels = async () => {
    if (el.model === null || refs.state.value === null || refs.state.value.composer?.capabilities?.modelSelection !== true || refs.state.value.chat.dshSessionId === null) return
    if (refs.modelCatalogSessionId.value === refs.state.value.chat.dshSessionId) return
    try {
      const response = await apiFetch(`/api/chats/${encodeURIComponent(chatId)}/models`)
      if (!response.ok) return
      const catalog = (await response.json()).catalog
      const groups = Array.isArray(catalog?.groups) ? catalog.groups : []
      const choices = new Map()
      const options = []
      for (const group of groups) {
        if (typeof group?.id !== 'string' || !Array.isArray(group.models)) continue
        for (const model of group.models) {
          if (typeof model?.id !== 'string' || typeof model?.name !== 'string') continue
          const key = `${group.id}\u0000${model.id}`
          choices.set(key, { provider: group.id, model: model.id, reasoning: model.reasoning })
          options.push({ key, label: `${group.name ?? group.id} · ${model.name}` })
        }
      }
      refs.modelChoices.value = choices
      refs.modelCatalogSessionId.value = refs.state.value.chat.dshSessionId
      const entry = deps.dropdownState.get(el.model)
      if (entry !== undefined) entry.options = options.map((option) => ({ value: option.key, label: option.label }))
      const selected = refs.state.value.composer?.model ?? catalog?.current
      const selectedKey = selected === null || selected === undefined ? '' : `${selected.provider}\u0000${selected.model}`
      if (entry !== undefined) {
        entry.value = selectedKey
        const chosen = options.find((option) => option.key === selectedKey)
        deps.setDropdownLabel(el.model, chosen?.label ?? (selected !== null && selected !== undefined ? `${selected.provider} · ${selected.model}` : t('chat.model.default')))
      }
      deps.render()
    } catch {
      refs.modelCatalogSessionId.value = null
    }
  }

  const load = async () => {
    // Set before the request, so frames delivered during it are buffered rather
    // than applied to a transcript that is about to be replaced.
    refs.loading.value = true
    refs.buffered.value = []
    let response
    try {
      response = await apiFetch(`/api/chats/${encodeURIComponent(chatId)}`, { headers: { accept: 'application/json' } })
    } catch (error) {
      refs.loading.value = false
      fatal(t('chat.wire.connectFailed', { message: error.message }))
      return
    }

    if (response.status === 401) {
      window.location.href = '/login'
      return
    }
    if (!response.ok) {
      refs.loading.value = false
      const body = await response.json().catch(() => ({}))
      // 409 and 502 carry a `detail` written for a person; 404 does not.
      fatal(
        response.status === 404
          ? t('chat.wire.noSession')
          : (body.detail ?? t('chat.wire.serverStatus', { status: response.status })),
      )
      return
    }

    refs.state.value = await response.json()
    const state = refs.state.value
    // The run row is the authority on when the live turn began, and it is the only
    // source that survives a refresh: without this, F5 during a long turn would
    // restart the clock at zero and claim the wait had only just started.
    const runningRun = state.busyRunId === null ? undefined : state.turns.find((t) => t.id === state.busyRunId)
    if (runningRun !== undefined && typeof runningRun.startedAt === 'number') refs.turnStartedAt.value = runningRun.startedAt
    else if (!refs.sending.value) refs.turnStartedAt.value = null
    const maxSeq = state.events.reduce((max, e) => (typeof e.seq === 'number' && e.seq > max ? e.seq : max), -1)
    const rebuilt = build(state.events, state.turns)
    const liveFrames = Array.isArray(state.liveFrames) ? state.liveFrames : []
    // Queued (or just-sent) messages are not in the DSH history yet — draw them
    // locally until the history contains them, the same way DSH keeps a queued
    // bubble visible above the composer.
    const stillPending = []
    for (const p of refs.pendingUserTexts.value) {
      if (rebuilt.some((b) => b.role === 'user' && b.text === p.text)) continue
      rebuilt.push({ role: 'user', text: p.text, injected: false, at: p.at })
      stillPending.push(p)
    }
    refs.pendingUserTexts.value = stillPending
    // Anything that arrived mid-fetch and is not in the history yet still belongs
    // on screen, so it is replayed on top rather than thrown away.
    const pendingFrames = uniqueFrames([...liveFrames, ...refs.buffered.value]).filter((f) => !alreadyLoaded(f, maxSeq, rebuilt))
    for (const f of pendingFrames) {
      if (f.kind === 'turn_queued') refs.queuedItems.value.push({ id: typeof f.id === 'string' ? f.id : '', text: typeof f.text === 'string' ? f.text : '', at: Date.now() })
      if (f.kind === 'turn_start' && refs.queuedItems.value.length > 0) {
        const started = refs.queuedItems.value.shift()
        refs.pendingUserTexts.value.push(started)
      }
      // goal 帧不是转录帧：直接落状态，不进 blocks。
      if (f.kind === 'goal') state.goal = f.goal ?? null
    }
    refs.blocks.value = pendingFrames.filter((f) => f.kind !== 'turn_queued' && f.kind !== 'goal').reduce((list, frame) => reduce(list, frame), rebuilt)
    // 卡片状态在重建后必须与转录一致:清空重放(load 是唯一事实源)。
    deps.resetAsks()
    for (const frame of pendingFrames) deps.trackAsks(frame)
    refs.buffered.value = []
    refs.loading.value = false
    deps.render()
    void loadModels()
    void loadDelegations()
  }

  /**
   * Loads, one at a time.
   *
   * A finished turn triggers a reload from two places at once -- the POST resolving
   * and `turn_done` arriving -- and two overlapping loads would have the second
   * clear the first one's buffer, dropping frames it had already set aside.
   */
  let chain = Promise.resolve()
  const reload = () => {
    chain = chain.then(load, load)
    return chain
  }

  /** 测试可注入假 reload 覆盖真实链(避免触发网络);缺省用内部链。 */
  const reloadNow = deps.reload ?? reload
  /** 测试可注入假派工拉取;缺省用内部实现。 */
  const refreshDelegations = deps.loadDelegations ?? loadDelegations

  /**
   * One live frame, dispatched into refs. Pure w.r.t. DOM: tests drive it with
   * fake refs/deps and assert state transitions without a WebSocket.
   */
  const handleFrame = (frame) => {
    // `hello` only says the relay is open. History came from the GET, and the
    // relay deliberately carries no replay.
    if (frame.kind === 'hello') return
    if (frame.kind === 'composer_state' && refs.state.value !== null) {
      refs.state.value.composer = { ...(refs.state.value.composer ?? {}), ...frame }
      deps.render()
      return
    }
    // 蜂群 P2：派工结束帧——不是转录帧，刷新派工记录即可。
    if (frame.kind === 'delegation_done') {
      void refreshDelegations()
      return
    }

    if (frame.kind === 'turn_queued') {
      if (refs.loading.value) {
        refs.buffered.value.push(frame)
        return
      }
      refs.queuedItems.value.push({ id: typeof frame.id === 'string' ? frame.id : '', text: typeof frame.text === 'string' ? frame.text : '', at: Date.now() })
      deps.render()
      return
    }
    if (refs.loading.value) {
      refs.buffered.value.push(frame)
      return
    }

    // goal 帧放在 loading 缓冲之后：加载中收到的目标变化先进 buffer，
    // load() 完成时经 pendingFrames 拾取（见 load 里的 'goal' 分支）——
    // 直接应用会打在半截的旧快照上，且 GET 的历史缓存可能还没带上它。
    if (frame.kind === 'goal' && refs.state.value !== null) {
      refs.state.value.goal = frame.goal ?? null
      deps.render()
      return
    }

    // The queued message whose turn now starts is no longer queued: it moves
    // from the dock into the log (via the pending bubble, until the history
    // contains it).
    if (frame.kind === 'turn_start' && refs.queuedItems.value.length > 0) {
      const started = refs.queuedItems.value.shift()
      refs.pendingUserTexts.value.push(started)
    }

    refs.blocks.value = reduce(refs.blocks.value, frame)
    deps.trackAsks(frame)

    // A turn another tab started, or one begun before this page opened.
    if (frame.kind === 'turn_start' && refs.turnStartedAt.value === null) refs.turnStartedAt.value = Date.now()

    if (frame.kind === 'turn_done') {
      refs.sending.value = false
      refs.turnStartedAt.value = null
      // Reloaded because the run row is what carries the price and the duration,
      // and because a first turn has just bound a gateway session, which changes
      // sessionState from `fresh` to `live`.
      void reloadNow()
      return
    }
    deps.render()
  }

  // One stream, and only while this page is actually on screen.
  //
  // HTTP/1.1 gives the *whole origin* six connections, and a stream holds one of
  // them for as long as it is open. A page that keeps streaming after you have
  // navigated away -- and Chrome keeps the old document alive in its back/forward
  // cache -- is one connection fewer for everything that comes after, including
  // the navigation itself. Six of those and the site stops answering: every
  // request, even the HTML document, sits queued behind a socket that will never
  // free up. So this is not battery hygiene, it is the difference between working
  // and hanging.
  // 债务 F3：重连机制已收敛进 ui.js 的 autoReconnect（3s → ×2 → 30s 封顶）。
  const { connect, disconnect } = autoReconnect(() => {
    // Never two streams for one page: a second one costs a second connection and
    // delivers every frame twice.
    const es = new EventSource(`/api/chats/${encodeURIComponent(chatId)}/events`)

    es.addEventListener('message', (event) => {
      let frame
      try {
        frame = JSON.parse(event.data)
      } catch {
        return
      }
      if (frame === null || typeof frame !== 'object') return
      handleFrame(frame)
    })

    return es
  })

  return { connect, disconnect, reload, load, loadModels, loadDelegations, handleFrame, renderDelegations, fatal }
}
