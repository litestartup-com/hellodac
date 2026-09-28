// Debt F1, step three of splitting chat.js: the wire layer (load/reload and SSE frame dispatch).
//
// Symmetric with the render layer: all state is injected through refs (getter/setter boxes) and the
// frame dispatch logic in handleFrame is a pure function (dependency injection), unit-tested on its own
// (chat-wire.test.mjs). chat.js only wires up refs/deps and no longer owns the loading or stream logic.

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
   * Hive P2/P3: the brain's delegation records (delegation frames).
   *
   * A separate block from the transcript: the frame data comes from the run table (source_chat_id), not
   * from the conversation history; interleaving it precisely with the message stream costs a lot and buys
   * little, so the MVP renders it flat above the transcript. Live updates = the delegation_done frame on the
   * relay triggering a refetch.
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
      // A non-brain conversation has no delegations to begin with, and an API hiccup is not worth interrupting the chat for.
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
      // A goal frame is not a transcript frame: it lands in state directly and does not enter blocks.
      if (f.kind === 'goal') state.goal = f.goal ?? null
    }
    refs.blocks.value = pendingFrames.filter((f) => f.kind !== 'turn_queued' && f.kind !== 'goal').reduce((list, frame) => reduce(list, frame), rebuilt)
    // Card state has to match the transcript after a rebuild, so it is cleared and replayed (load is the only source of truth).
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

  /** Tests may inject a fake reload to bypass the real chain (and avoid network); the internal chain is the default. */
  const reloadNow = deps.reload ?? reload
  /** Tests may inject a fake delegation fetch; the internal implementation is the default. */
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
    // Hive P2: the delegation-finished frame is not a transcript frame, so refetching the records is enough.
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

    // Goal frames are queued behind the loading buffer: a goal change that arrives mid-load goes into the
    // buffer and is picked up by pendingFrames when load() finishes (see the 'goal' branch in load).
    // Applying it directly would land on a half-built snapshot, and the GET history cache may not carry it yet.
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
  // Debt F3: the reconnect machinery converged into ui.js autoReconnect (3s -> x2 -> capped at 30s).
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
