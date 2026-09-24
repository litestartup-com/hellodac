// 债务 F1:chat.js 拆分第四步——composer 层(发送/停止/排队/模型/权限/上下文渲染)
// + 自绘下拉(模型/访问模式/推理深度共用的一套 DOM 面板)。
//
// 纯函数(modelKey/shortPath/accessOptions/sendPolicy)独立单测;
// makeComposer 工厂注入 el/refs/deps,与 render/wire 层对称。

import { esc, icon, apiFetch, t, loadI18n } from './ui.js'

await loadI18n()

// ---------------------------------------------------------------------------
// 自绘下拉（模型 / 访问模式 / 推理深度）——原生 <option> 弹出列表浏览器
// 不给样式，要 DSH web 的选项外观就得自绘：按钮 + body 挂载的选项面板，
// token 同源（surface 卡片 + 悬停行 + 选中勾）。
// DOM 初始化包在 hasDom 守卫里:node 单测导入本模块时无 document。
// ---------------------------------------------------------------------------

const hasDom = typeof document !== 'undefined' && typeof document.createElement === 'function'

const optionsPanel = hasDom ? document.createElement('div') : null
if (optionsPanel !== null) {
  optionsPanel.className = 'composer-options-panel'
  optionsPanel.hidden = true
  document.body.appendChild(optionsPanel)
}

/** button 元素 → { options: [{value,label}], value, onPick }。 */
export const dropdownState = new Map()
let openDropdownBtn = null

export const closeDropdown = () => {
  if (optionsPanel === null) return
  optionsPanel.hidden = true
  if (openDropdownBtn !== null) {
    openDropdownBtn.setAttribute('aria-expanded', 'false')
    openDropdownBtn = null
  }
}

export const setDropdownLabel = (button, label) => {
  const span = button.querySelector('.composer-select-label')
  if (span !== null) span.textContent = label
}

const CHECK_SVG = '<svg class="check" width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'

const openDropdown = (button) => {
  if (optionsPanel === null) return
  const entry = dropdownState.get(button)
  if (entry === undefined || button.disabled) return
  optionsPanel.replaceChildren(...entry.options.map((option) => {
    const row = document.createElement('div')
    const selected = option.value === entry.value
    row.className = `composer-option${selected ? ' selected' : ''}${option.danger === true ? ' danger' : ''}${option.locked === true ? ' locked' : ''}`
    row.setAttribute('role', 'option')
    row.setAttribute('aria-selected', String(selected))
    row.dataset.value = option.value
    if (option.locked === true) row.dataset.locked = '1'
    // 债务 F5:全站唯一未转义的 innerHTML sink——option.label(上游模型目录/
    // 沙箱模式名)原样拼进 innerHTML。改 DOM 构建(textContent 转义);
    // CHECK_SVG 是静态常量,insertAdjacentHTML 安全。
    const labelSpan = document.createElement('span')
    labelSpan.textContent = option.label
    row.append(labelSpan)
    if (selected) row.insertAdjacentHTML('beforeend', CHECK_SVG)
    row.tabIndex = -1
    return row
  }))
  const rect = button.getBoundingClientRect()
  optionsPanel.style.bottom = `${window.innerHeight - rect.top + 6}px`
  optionsPanel.style.left = `${Math.min(Math.max(rect.left, 8), window.innerWidth - 300)}px`
  optionsPanel.hidden = false
  button.setAttribute('aria-expanded', 'true')
  openDropdownBtn = button
  ;(optionsPanel.querySelector('.composer-option.selected') ?? optionsPanel.querySelector('.composer-option'))?.focus()
}

/** 注册一个自绘下拉：button 点击开合；选中回填 value 并回调 onPick。 */
export const registerDropdown = (button, onPick) => {
  dropdownState.set(button, { options: [], value: '', onPick })
  button.addEventListener('click', () => {
    if (optionsPanel !== null && !optionsPanel.hidden && openDropdownBtn === button) closeDropdown()
    else openDropdown(button)
  })
}

if (optionsPanel !== null) {
  optionsPanel.addEventListener('click', (event) => {
    const row = event.target.closest('.composer-option')
    if (row === null || openDropdownBtn === null) return
    if (row.dataset.locked === '1') return
    const entry = dropdownState.get(openDropdownBtn)
    if (entry === undefined) return
    entry.value = row.dataset.value
    entry.onPick(row.dataset.value)
    closeDropdown()
  })

  optionsPanel.addEventListener('keydown', (event) => {
    if (optionsPanel.hidden) return
    const rows = [...optionsPanel.querySelectorAll('.composer-option')]
    const index = rows.indexOf(document.activeElement)
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      rows[(index + 1) % rows.length]?.focus()
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      rows[(index - 1 + rows.length) % rows.length]?.focus()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      if (document.activeElement instanceof HTMLElement) document.activeElement.click()
    } else if (event.key === 'Escape') {
      const button = openDropdownBtn
      closeDropdown()
      button?.focus()
    }
  })

  document.addEventListener('pointerdown', (event) => {
    if (optionsPanel.hidden) return
    if (event.target instanceof Element && (optionsPanel.contains(event.target) || (openDropdownBtn !== null && openDropdownBtn.contains(event.target)))) return
    closeDropdown()
  })
}

/** provider/model 的合成键(与 wire.loadModels 的 choices 键同一拼法)。 */
export const modelKey = (selection) => `${selection.provider}\u0000${selection.model}`

/**
 * Windows 长路径的中间省略：保留盘符开头与尾部（工作区名），掐掉最无信息量
 * 的中段。完整路径始终在 title 里（hover 可见）。
 */
export const shortPath = (path) => {
  const s = String(path ?? '')
  if (s.length <= 52) return s
  return `${s.slice(0, 16)}…${s.slice(-32)}`
}

/** 第三档选项随节点开锁状态变化：开锁 = 可选；未开锁 = 展示但锁定并说明。 */
export const accessOptions = (caps) =>
  caps.fullAccess === true
    ? [
        { value: 'read-only', label: t('chat.access.readonly') },
        { value: 'workspace-write', label: t('chat.access.workspaceWrite') },
        { value: 'danger-full-access', label: t('chat.access.full'), danger: true },
      ]
    : [
        { value: 'read-only', label: t('chat.access.readonly') },
        { value: 'workspace-write', label: t('chat.access.workspaceWrite') },
        { value: 'danger-full-access', label: t('chat.access.fullLocked'), danger: true, locked: true },
      ]

/**
 * 发送前置判断(纯函数):空文本/发送中/无状态一律不发。
 * @param {{ text: string; sending: boolean; state: unknown }} input
 * @returns {{ kind: 'ok'; text: string } | { kind: 'empty' | 'busy' | 'no_state' }}
 */
export const sendPolicy = ({ text, sending, state }) => {
  if (sending) return { kind: 'busy' }
  if (state === null) return { kind: 'no_state' }
  const trimmed = text.trim()
  if (trimmed === '') return { kind: 'empty' }
  return { kind: 'ok', text: trimmed }
}

// 全量访问的确认文案按部署形态区分（爆炸半径不同，2026-09-11 拍板）。
const FULL_WARNINGS = {
  container: t('chat.access.confirmContainer'),
  'bare-metal': t('chat.access.confirmBare'),
}

/**
 * @param {{
 *   state: { value: any };
 *   queuedItems: { value: any[] };
 *   pendingUserTexts: { value: any[] };
 *   sending: { value: boolean };
 *   turnStartedAt: { value: number | null };
 *   modelChoices: { value: Map<string, any> };
 *   effortSignature: { value: string | null };
 * }} refs
 * @param {{
 *   chatId: string;
 *   el: Record<string, any>;
 *   toast: (text: string) => void;
 *   render: () => void;
 *   reload: () => Promise<any>;
 *   grow: () => void;
 *   dropdownState: Map<any, any>;
 *   setDropdownLabel: (button: any, label: string) => void;
 * }} deps
 */
export const makeComposer = (refs, deps) => {
  const { chatId, el } = deps

  const syncEffort = () => {
    if (el.effort === null) return
    const selection = refs.state.value?.composer?.model
    const choice = selection === null || selection === undefined ? undefined : refs.modelChoices.value.get(modelKey(selection))
    const reasoning = choice?.reasoning
    const efforts = Array.isArray(reasoning?.efforts) ? reasoning.efforts : []
    const value = selection?.reasoningEffort ?? reasoning?.defaultEffort ?? ''
    const signature = JSON.stringify([modelKey(selection ?? { provider: '', model: '' }), value, efforts])
    if (signature === refs.effortSignature.value) return
    refs.effortSignature.value = signature
    if (efforts.length === 0) {
      el.effort.hidden = true
      return
    }
    el.effort.hidden = false
    const options = [
      { value: '', label: t('chat.reasoning.default') },
      ...efforts.filter((effort) => typeof effort?.id === 'string' && typeof effort?.name === 'string').map((effort) => ({ value: effort.id, label: effort.name })),
    ]
    const entry = deps.dropdownState.get(el.effort)
    if (entry !== undefined) {
      entry.options = options
      entry.value = value
      deps.setDropdownLabel(el.effort, (options.find((o) => o.value === value) ?? options[0]).label)
    }
  }

  const renderContext = (context) => {
    if (el.contextWrap === null || el.context === null) return
    el.contextWrap.hidden = context === null
    if (context === null) {
      if (el.contextPopover !== null) el.contextPopover.hidden = true
      return
    }
    el.context.textContent = `${context.percent}%`
    el.context.style.setProperty('--context-ratio', String(context.percent / 100))
    el.context.title = t('chat.context.usageTitle', { used: context.usedTokens.toLocaleString(), total: context.contextWindow.toLocaleString() })
    el.context.setAttribute('aria-label', el.context.title)
    if (el.contextSummary !== null) el.contextSummary.textContent = t('chat.context.usageSummary', { used: context.usedTokens.toLocaleString(), total: context.contextWindow.toLocaleString() })
    const breakdown = context.breakdown
    if (el.contextBreakdown !== null) {
      el.contextBreakdown.hidden = breakdown === null || breakdown === undefined
      if (breakdown !== null && breakdown !== undefined) {
        el.contextBreakdown.textContent = t('chat.context.breakdown', { system: breakdown.systemTokens.toLocaleString(), tools: breakdown.toolsTokens.toLocaleString(), messages: breakdown.messageTokens.toLocaleString() })
      }
    }
    const total = breakdown === null || breakdown === undefined ? 0 : breakdown.systemTokens + breakdown.toolsTokens + breakdown.messageTokens
    const widths = total > 0
      ? [breakdown.systemTokens, breakdown.toolsTokens, breakdown.messageTokens].map((value) => `${context.percent * value / total}%`)
      : [`${context.percent}%`, '0%', '0%']
    for (const [node, width] of [[el.contextSystem, widths[0]], [el.contextTools, widths[1]], [el.contextMessages, widths[2]]]) {
      if (node !== null) node.style.width = width
    }
  }

  const syncAccessOptions = () => {
    if (el.access === null) return
    const entry = deps.dropdownState.get(el.access)
    if (entry === undefined) return
    const caps = refs.state.value?.composer?.capabilities ?? {}
    entry.options = accessOptions(caps)
  }

  const renderComposer = () => {
    if (refs.state.value === null) return
    const state = refs.state.value
    // The agent pill carries the name; the full path is one hover away.
    el.agent.textContent = state.agent.name
    el.agent.title = state.agent.workspacePath ?? ''
    el.path.textContent = shortPath(state.agent.workspacePath)
    el.path.title = state.agent.workspacePath ?? ''

    const composer = state.composer ?? { capabilities: {}, model: null, context: null, accessMode: null }
    const capabilities = composer.capabilities ?? {}
    const lost = state.sessionState === 'lost'
    // 会话尚未绑定（还没发过第一条消息）：切权限/选模型服务端必然 409 no_session，
    // 控件直接禁用并说明原因，而不是「点了弹个 409」。
    const fresh = state.sessionState === 'fresh'
    // 蜂群 P5.4：跨会话不再互锁，composer 永不因别的会话而禁用；同会话的
    // 新消息在上一回合跑完前由服务端排队，dock 可见可删。
    const locked = lost || refs.sending.value
    const turnRunning = state.turns.some((t) => t.state === 'running')

    el.input.disabled = lost
    if (el.modes !== null) el.modes.hidden = capabilities.accessMode !== true
    if (el.settings !== null) {
      el.settings.hidden = capabilities.accessMode !== true && capabilities.modelSelection !== true && composer.context === null
    }
    if (el.access !== null) {
      el.access.disabled = lost || fresh || refs.sending.value || turnRunning || capabilities.accessMode !== true
      el.access.title = fresh ? t('chat.hint.afterFirst') : turnRunning ? t('chat.hint.afterTurn') : ''
      syncAccessOptions()
      if (composer.accessMode !== null) {
        const entry = deps.dropdownState.get(el.access)
        if (entry !== undefined) {
          entry.value = composer.accessMode
          deps.setDropdownLabel(el.access, composer.accessMode === 'workspace-write' ? t('chat.access.workspaceWrite') : composer.accessMode === 'danger-full-access' ? t('chat.access.full') : t('chat.access.readonly'))
        }
      }
    }
    if (el.model !== null) {
      if (el.model.parentElement !== null) el.model.parentElement.hidden = capabilities.modelSelection !== true
      el.model.disabled = lost || fresh || refs.sending.value || turnRunning || capabilities.modelSelection !== true || refs.modelChoices.value.size === 0
      el.model.title = fresh ? t('chat.hint.afterFirst') : turnRunning ? t('chat.hint.afterTurn') : ''
    }
    if (el.effort !== null) el.effort.disabled = lost || refs.sending.value || turnRunning || capabilities.modelSelection !== true
    syncEffort()
    renderContext(composer.context)
    el.send.disabled = locked || el.input.value.trim() === ''
    // 方案 C（2026-09-11）：发送/停止同槽变身——busy 时槽里只有停止方块，
    // 空闲时只有发送箭头，主 CTA 位置永不跳动。排队发送是回合运行中输入非空
    // 才浮现的 ghost 小按钮（P5.4 排队能力保留）。
    const busy = refs.sending.value || turnRunning
    el.send.hidden = busy
    el.stop.hidden = !busy
    el.queue.hidden = !(turnRunning && !lost && el.input.value.trim() !== '')

    el.input.placeholder = lost
      ? t('chat.dead')
      : turnRunning && !refs.sending.value
        ? t('chat.composer.nextTurn')
        : refs.sending.value
          ? t('chat.composer.awaiting')
          : t('chat.composer.placeholder')

    // The hint only names the available interruption gesture beside the input.
    el.hint.textContent = refs.sending.value ? t('chat.composer.escHint') : ''
  }

  const send = async () => {
    const policy = sendPolicy({ text: el.input.value, sending: refs.sending.value, state: refs.state.value })
    if (policy.kind !== 'ok') return
    const text = policy.text

    // Cleared before the request, not after: leaving the text in the box while a
    // turn runs invites a second send, and a second send is a 409.
    el.input.value = ''
    deps.grow()
    refs.sending.value = true
    // Set here rather than on `turn_start`: the gateway can take seconds to send
    // that frame, and those seconds are precisely the ones that feel like a hang.
    refs.turnStartedAt.value = Date.now()
    deps.render()

    try {
      const response = await apiFetch(`/api/chats/${encodeURIComponent(chatId)}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      })

      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        refs.sending.value = false
        // The text goes back in the box: it was never delivered, and retyping it
        // is the last thing anyone wants after being told the agent was busy.
        el.input.value = text
        deps.grow()
        deps.toast(body.detail ?? t('chat.send.failedStatus', { status: response.status }))
        void deps.reload()
        return
      }

      // Read the result first: an accepted turn may need the local bubble (its
      // message can still be missing from the history on the reload below), while
      // a queued one must NOT appear in the log yet — it lives in the dock until
      // its turn actually starts.
      const result = await response.json().catch(() => ({}))
      if (result.queued !== true) refs.pendingUserTexts.value.push({ text, at: Date.now() })
      refs.sending.value = false
      // The turn's own frames drove the transcript; this reload is for the run row
      // and for a title the server may have derived. It is also the fallback when
      // the relay dropped and `turn_done` never arrived.
      await deps.reload()
      if (result.queued === true) {
        deps.toast(t('chat.queue.queued', { position: result.position }))
      }
    } catch (error) {
      refs.sending.value = false
      el.input.value = text
      deps.grow()
      deps.toast(t('chat.queue.failed', { message: error.message }))
      deps.render()
    }
  }

  const cancel = async () => {
    try {
      const response = await apiFetch(`/api/chats/${encodeURIComponent(chatId)}/cancel`, { method: 'POST' })
      const body = await response.json().catch(() => ({}))
      deps.toast(response.ok ? t('chat.stop.requested') : (body.detail ?? t('chat.stop.failed')))
    } catch (error) {
      deps.toast(t('chat.stop.failedMsg', { message: error.message }))
    }
  }

  const selectModel = async (selection) => {
    if (el.model !== null) el.model.disabled = true
    if (el.effort !== null) el.effort.disabled = true
    try {
      const response = await apiFetch(`/api/chats/${encodeURIComponent(chatId)}/model`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(selection),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) {
        deps.toast(body.detail ?? t('chat.model.switchFailed', { status: response.status }))
        return
      }
      refs.state.value.composer = { ...(refs.state.value.composer ?? {}), model: body.model }
      refs.effortSignature.value = null
      deps.toast(t('chat.model.updated'))
    } catch (error) {
      deps.toast(t('chat.model.switchFailedMsg', { message: error.message }))
    }
    deps.render()
  }

  const cancelQueued = async (row, action) => {
    const id = row.dataset.id
    const item = refs.queuedItems.value.find((q) => q.id === id)
    if (item === undefined) return
    const index = refs.queuedItems.value.indexOf(item)
    try {
      await apiFetch(`/api/chats/${encodeURIComponent(chatId)}/queued/${encodeURIComponent(id)}/cancel`, { method: 'POST' })
    } catch {
      // The row stays if the server cannot be reached; the user can try again.
      return
    }
    refs.queuedItems.value.splice(index, 1)
    if (action === 'edit') {
      el.input.value = item.text
      deps.grow()
      el.input.focus()
      deps.toast(t('chat.queue.undone'))
    }
    deps.render()
  }

  return { renderComposer, syncAccessOptions, send, cancel, selectModel, cancelQueued, syncEffort, renderContext, FULL_WARNINGS }
}

export const fullAccessWarning = (form) => FULL_WARNINGS[form] ?? FULL_WARNINGS['bare-metal']
