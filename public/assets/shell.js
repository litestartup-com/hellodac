// The sidebar, on every page.
//
// Split out of the (since-deleted) home page script when the frame stopped
// being the dashboard's private property; every page owns the shell equally.

import { $, ago, banner, esc, icon, setHtml, when, apiFetch, poll, t, loadI18n, brandInfo, availableLocales, currentLocale } from './ui.js'

/**
 * 多语言与品牌：先取字典再画侧栏（顶层 await——首屏不该先显示键名再补译文）。
 * 品牌来自 /api/i18n（唯一真相源是服务端 src/brand.ts），客户端不散写 URL。
 */
await loadI18n()
const brand = brandInfo()

/** An agent is only as healthy as the endpoint it runs on. */
const agentHealth = (agent, endpoints) => {
  const ep = endpoints.find((e) => e.id === agent.endpoint)
  if (ep === undefined || !ep.reachable) return 'bad'
  if (ep.apiKeySet === false || ep.enabled === false) return 'warn'
  return 'ok'
}

const HEALTH_TITLE = { ok: t('side.healthOk'), warn: t('side.healthWarn'), bad: t('side.healthBad') }

/** Endpoint health, independent of any agent. Same rule as agentHealth. */
const endpointHealth = (ep) => {
  if (!ep.reachable) return 'bad'
  if (ep.apiKeySet === false || ep.enabled === false) return 'warn'
  return 'ok'
}

/**
 * The quiet line at the foot of the sidebar: one row per endpoint, saying how
 * it is doing. These are standing facts, shown everywhere rather than on one
 * page somebody has to remember to open.
 */
const renderEndpointLines = (status) => {
  const box = $('side-endpoints')
  if (box === null) return
  if (status.endpoints.length === 0) {
    box.hidden = true
    return
  }
  box.hidden = false
  setHtml(
    'side-endpoints',
    status.endpoints
      .map((ep) => {
        const health = endpointHealth(ep)
        // apiproxy 端点没有会话数来源（gateway 老 /health 才有）——未知就
        // 不显示，不拿 0 冒充真数（2026-09-11）。
        const reach = ep.reachable ? (typeof ep.sessions === 'number' ? t('side.sessionsCount', { count: ep.sessions }) : '') : t('side.unreachable')
        const label = `${ep.id}${reach}${ep.apiKeySet === false ? t('side.keyUnverified') : ''}`
        const detail = ep.reachable ? '' : ` — ${ep.error ?? t('side.unknownError')}`
        return `<span class="endpoint-line" title="${esc(ep.url)}${esc(detail)}">
          <span class="dot ${health}"></span>${esc(label)}
        </span>`
      })
      .join(''),
  )
}

/**
 * 蜂群 P3：主脑入口。config 里有 brain agent 才渲染——没有主脑就没有这个
 * 块，界面不撒谎。
 *
 * 方案 A：主按钮 = 打开最近一次会话（没有才新建）；右侧 chevron = 展开/
 * 收起主脑会话列表（折叠偏好与树同池）；「＋」= 显式新会话。列表行复用
 * 树的会话行与 ⋯ 菜单（改名/归档）——主脑会话有列表、可选、可管控，
 * 不再是没有入口的「二等公民」。主脑仍不进 AGENTS 树。
 */
// 主脑列表最多 3 条，其余与 agent 树一样折叠在 Show more 后面。
const BRAIN_CHATS_SHOWN = 3

// 头部两个 ghost 钮的图标直接内联 path，不经过 <use>：曾经只有这两个
// 按钮的图标画不出来（与 sprite 引用无关的浏览器差异），内联是零依赖
// 的最稳写法——任何能画 svg path 的内核都能画。
const CHEV_SVG =
  '<svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">' +
  '<path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const ADD_SVG =
  '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">' +
  '<path d="M8 3.5v9M3.5 8h9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'

const renderBrain = (status) => {
  const box = $('side-brain')
  if (box === null) return
  const brain = status.agents.find((a) => a.id === 'brain')
  if (brain === undefined) {
    box.hidden = true
    box.innerHTML = ''
    return
  }
  box.hidden = false
  const chats = chatsByAgent.get('brain') ?? []
  const busy = busyByAgent.get('brain') ?? null
  const open = expandedSet().has('brain')
  const unfolded = chatsMoreSet().has('brain')
  const shown = open ? (unfolded ? chats : chats.slice(0, BRAIN_CHATS_SHOWN)) : []
  const rest = chats.length - shown.length
  const latest = chats[0]
  const latestTitle =
    latest === undefined || latest.title === null || latest.title === '' ? t('side.newChat') : latest.title
  const openTitle = latest === undefined ? t('side.brain.firstChat') : t('side.brain.lastChat', { title: latestTitle })
  setHtml(
    'side-brain',
    `<div class="side-brain-card${open ? ' open' : ''}">
      <div class="side-brain-head">
        <button class="side-brain-btn" type="button" data-brain-open title="${esc(openTitle)}">
          <span class="side-brain-icon" aria-hidden="true">${icon('hive', 15)}</span>
          <span class="side-brain-main">
            <span class="side-brain-name">${esc(t('side.brain.name'))}${
              busy !== null
                ? `<span class="brain-busy" title="${esc(t('side.brain.busyTitle', { count: activeByAgent.get('brain') ?? 1 }))}">${esc(t('side.brain.busy'))}</span>`
                : ''
            }</span>
            <span class="side-brain-sub">${esc(t('side.brain.sub'))}</span>
          </span>
        </button>
        <button class="side-brain-ghost" type="button" data-brain-toggle aria-expanded="${open}"
                title="${esc(open ? t('side.brain.collapse') : t('side.brain.expand'))}" aria-label="${esc(open ? t('side.brain.collapse') : t('side.brain.expand'))}">
          ${CHEV_SVG}
        </button>
        <span class="side-brain-div" aria-hidden="true"></span>
        <button class="side-brain-ghost" type="button" data-brain-new title="${esc(t('side.brain.newChat'))}" aria-label="${esc(t('side.brain.newChat'))}">
          ${ADD_SVG}
        </button>
      </div>
      ${
        open
          ? `<div class="brain-chats">
            ${
              chats.length === 0
                ? `<p class="muted small brain-empty">${esc(t('side.brain.empty'))}</p>`
                : shown.map(chatRow).join('') +
                  (rest > 0 ? `<button class="tree-child more" type="button" data-chat-more="brain">Show ${rest} more sessions</button>` : '') +
                  (unfolded && chats.length > BRAIN_CHATS_SHOWN
                    ? `<button class="tree-child more" type="button" data-chat-more="brain" data-less="1">Show less</button>`
                    : '')
            }
          </div>`
          : ''
      }
    </div>`,
  )
}

/** 打开主脑会话：fresh=1 强制新建，否则跳到最近一次、没有才新建。 */
const openBrainChat = async (fresh) => {
  if (!fresh) {
    const latest = (chatsByAgent.get('brain') ?? [])[0]
    if (latest !== undefined) {
      window.location.href = `/chat/${encodeURIComponent(latest.id)}`
      return
    }
  }
  try {
    const response = await apiFetch('/api/chats', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'brain' }),
    })
    if (!response.ok) {
      banner(t('side.brain.createFailed'), 'warn')
      return
    }
    const { chat } = await response.json()
    window.location.href = `/chat/${encodeURIComponent(chat.id)}`
  } catch (error) {
    banner(t('side.brain.unavailable', { message: error.message }), 'warn')
  }
}

// 主脑块内的行操作与树完全一致：⋯ 菜单（改名/归档）、Show more 折叠。
$('side-brain')?.addEventListener('click', async (event) => {
  const more = event.target.closest('.row-more')
  if (more !== null) {
    if (menuChatId === more.dataset.more) closeMenu()
    else openMenu(more, more.dataset.more)
    return
  }

  const chatMore = event.target.closest('[data-chat-more]')
  if (chatMore !== null) {
    setChatsMore(chatMore.dataset.chatMore, chatMore.dataset.less !== '1')
    if (lastStatus !== null) renderBrain(lastStatus)
    return
  }

  const toggle = event.target.closest('[data-brain-toggle]')
  if (toggle !== null) {
    setExpanded('brain', toggle.getAttribute('aria-expanded') !== 'true')
    if (lastStatus !== null) renderBrain(lastStatus)
    return
  }

  if (event.target.closest('[data-brain-new]') !== null) {
    await openBrainChat(true)
    return
  }
  if (event.target.closest('[data-brain-open]') !== null) {
    await openBrainChat(false)
  }
})

/** 蜂群 P3：节点区。托管节点读监督器状态机，未托管读探活结果。
 *
 * 侧栏对节点的全部表达 = 「节点 N/N」计数（未全活时用警示色，悬停列
 * 出未就绪的节点名）。启动中的 cold/starting 是常态而非异常，不该像
 * 故障一样张嘴；真故障的细节在 /nodes 页，栏底永远安静。
 */
const renderNodes = (nodesData) => {
  const box = $('side-endpoints')
  const link = $('nodes-link')
  const hint = $('nodes-hint')
  if (box === null || link === null || hint === null) return
  const rows = Array.isArray(nodesData.nodes) ? nodesData.nodes : []
  if (rows.length === 0) {
    link.hidden = true
    box.hidden = true
    return
  }
  link.hidden = false
  box.hidden = true
  const live = rows.filter((n) => n.state === 'live').length
  const abnormal = rows.filter((n) => n.state !== 'live')
  hint.textContent = `${live}/${rows.length}`
  hint.classList.toggle('warn', abnormal.length > 0)
  link.title =
    abnormal.length === 0 ? t('side.nodesOverview') : t('side.nodesNotReady', { ids: abnormal.map((n) => n.id).join(', ') })
}

const segments = window.location.pathname.split('/').filter(Boolean)
const pathId = (prefix) => (window.location.pathname.startsWith(`/${prefix}/`) ? decodeURIComponent(segments[1] ?? '') : '')

/** 公开版精简（DAC v1.0.0）：大盘页已下线，树行不再有「当前大盘」高亮。 */
/** The conversation currently open, so its row can be marked active. */
const openChatId = pathId('chat')

/**
 * How many chats an agent shows before the list is cut.
 *
 * A cap rather than a scroller: the sidebar also has to hold the other agents,
 * and one busy agent should not push them off the screen. The overflow rides
 * the "Show x more sessions" toggle below the list.
 */
const CHATS_SHOWN = 5

/**
 * Which agents are expanded.
 *
 * 蜂群 Q4 起默认全部收起（主脑与各 agent 组都一样）：侧栏一屏要装得下
 * 整支队伍，会话列表是点开才看的第二层。只记住用户主动展开的组。
 *
 * In localStorage because it is a view preference, not state the server owns,
 * and it has to survive the full page loads this app navigates with.
 */
const STORE_KEY = 'manager.agents.expanded'

const expandedSet = () => {
  try {
    const raw = JSON.parse(window.localStorage.getItem(STORE_KEY) ?? '[]')
    return new Set(Array.isArray(raw) ? raw : [])
  } catch {
    // Corrupt or unavailable storage must not cost you the sidebar.
    return new Set()
  }
}

const setExpanded = (agentId, open) => {
  const set = expandedSet()
  if (open) set.add(agentId)
  else set.delete(agentId)
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify([...set]))
  } catch {
    // Private-mode storage failures are not worth a visible error.
  }
}

/** Which agents have their full chat list unfolded ("Show less"). */
const MORE_KEY = 'manager.agents.chatsMore'

const chatsMoreSet = () => {
  try {
    const raw = JSON.parse(window.localStorage.getItem(MORE_KEY) ?? '[]')
    return new Set(Array.isArray(raw) ? raw : [])
  } catch {
    return new Set()
  }
}

const setChatsMore = (agentId, on) => {
  const set = chatsMoreSet()
  if (on) set.add(agentId)
  else set.delete(agentId)
  try {
    window.localStorage.setItem(MORE_KEY, JSON.stringify([...set]))
  } catch {
    // Same rule as the collapse preference.
  }
}

/** Chats per agent, from /api/chats. Empty until the first poll answers. */
let chatsByAgent = new Map()
/** The same chats by id, so a row action knows what it is acting on. */
let chatById = new Map()
/** Agents holding a live turn, so their rows can say so. */
let busyByAgent = new Map()
/** 蜂群 P5.4：每 agent 活跃 run 数，忙点 title 与详情面板用。 */
let activeByAgent = new Map()

/**
 * Expands the agent that owns the conversation on screen.
 *
 * Once, on arrival, rather than on every draw: arriving at a chat whose agent is
 * collapsed should show it, but a later collapse is a decision the user is
 * entitled to keep.
 */
let revealed = false
const revealOpenChat = (agents) => {
  if (revealed || openChatId === '') return
  revealed = true
  const owner = agents.find((a) => a.chats.some((c) => c.id === openChatId))
  if (owner !== undefined) setExpanded(owner.id, true)
}

const chatRow = (chat) => {
  const active = chat.id === openChatId ? ' active' : ''
  const title = chat.title === null || chat.title === '' ? t('side.newChat') : chat.title
  // Time first, count second. The list is ordered by last activity, so the time
  // is what explains the order; the turn count is context once you have found
  // the row. It is a turn count and not an unread count -- nothing here is ever
  // "unread", so it is spelled out rather than shown as a badge, which would be
  // read as unread.
  const parts = [ago(chat.lastActiveAt), chat.turns > 0 ? t('archive.turns', { count: chat.turns }) : ''].filter((p) => p !== '')
  const meta = parts.length === 0 ? '' : `<span class="chat-row-meta">${esc(parts.join(' · '))}</span>`
  // The row is a link and the actions are a button beside it, not inside it: a
  // button nested in an anchor is invalid, and clicking it would navigate as
  // well as open the menu.
  // The state is on both: the wrapper paints the row (the button is a sibling of
  // the link, so a highlight on the link alone stops short of it), the link keeps
  // it for the accent on its own glyph and text.
  return `<div class="chat-item${active}">
      <a class="tree-child chat-row${active}" href="/chat/${encodeURIComponent(chat.id)}" title="${esc(title)}">
        ${icon('chat', 13)}
        <span class="chat-row-main">
          <span class="label">${esc(title)}</span>
          ${meta}
        </span>
      </a>
      <button class="row-more" type="button" data-more="${esc(chat.id)}"
              aria-label="${esc(t('side.chatMore', { title }))}" aria-haspopup="menu">
        ${icon('more', 16)}
      </button>
    </div>`
}

/**
 * AGENTS 树里的 agent：不含主脑。主脑是 manager 级的总控，入口是上方
 * 的独立按钮，再出现在树里就重复了（之前还带着错误的大盘）。
 */
const treeAgents = (status) => status.agents.filter((agent) => agent.id !== 'brain')

/**
 * One expandable row per agent, with its conversations under it.
 *
 * The row toggles rather than navigating, and the board moved to its own ⊞
 * button. Conversations are a daily action and the board an occasional one, so
 * the whole-row click belongs to the frequent one -- UI.md §2.
 */
const agentNav = (status) => {
  const expanded = expandedSet()
  return treeAgents(status)
    .map((agent) => {
      const health = agentHealth(agent, status.endpoints)
      const chats = chatsByAgent.get(agent.id) ?? []
      // 默认收起：只有用户展开过的组才显示会话。展开过的组不会因为
      // 重绘被悄悄收起，哪怕它正持有打开的会话——强行展开反而让点击
      // 看起来像失效了。进入某个会话页时展开其组一次（revealOpenChat）。
      const open = expanded.has(agent.id)
      const busy = busyByAgent.get(agent.id) ?? null
      const unfolded = chatsMoreSet().has(agent.id)
      const shown = open ? (unfolded ? chats : chats.slice(0, CHATS_SHOWN)) : []
      const rest = chats.length - shown.length

      return `<div class="tree-group${open ? ' open' : ''}" data-agent="${esc(agent.id)}">
      <div class="tree-item">
        <button class="tree-toggle" type="button" data-toggle="${esc(agent.id)}"
                aria-expanded="${open}" title="${esc(agent.name)} · ${esc(agent.workspacePath)}">
          <span class="chev">${icon('chev', 12)}</span>
          <!-- Shown only in the collapsed rail, where the name is hidden and
               agents have no icon of their own to tell them apart by. -->
          <span class="rail-badge" aria-hidden="true">${esc([...agent.name][0] ?? '?')}</span>
          <span class="label">${esc(agent.name)}</span>
        </button>
        ${busy !== null ? `<span class="dot busy" title="${esc(t('side.brain.busyTitle', { count: activeByAgent.get(agent.id) ?? 1 }))}"></span>` : ''}
        ${agent.public ? `<span class="meta" title="${esc(t('side.agentPublic'))}">${icon('alert', 12)}</span>` : ''}
        <!-- The row's action area: endpoint health first, then new chat last --
             the "+" owns the far end of the row. (DAC v1.0.0：大盘入口已下线。) -->
        <!-- The dot is a button, because what it reports is not self-explanatory:
             it is the *endpoint's* health, so agents sharing one DSH process all
             go red together. Clicking says which endpoint and who else is on
             it. -->
        <button class="dot-btn ${health}" type="button" data-info="${esc(agent.id)}"
                title="${esc(t('side.agentDetailTitle', { health: HEALTH_TITLE[health], name: agent.name }))}"
                aria-label="${esc(t('side.agentDetail', { name: agent.name, health: HEALTH_TITLE[health] }))}">
          ${icon('endpoint', 15)}
          <span class="dot ${health}"></span>
        </button>
        <button class="tree-side" type="button" data-new="${esc(agent.id)}"
                title="${esc(t('side.agentNewChat', { name: agent.name }))}" aria-label="${esc(t('side.agentNewChat', { name: agent.name }))}">
          ${icon('add', 14)}
        </button>
      </div>
      ${
        open
          ? `<div class="tree-children">
        ${shown.map(chatRow).join('')}
        ${rest > 0 ? `<button class="tree-child more" type="button" data-chat-more="${esc(agent.id)}">Show ${rest} more sessions</button>` : ''}
        ${unfolded && chats.length > CHATS_SHOWN ? `<button class="tree-child more" type="button" data-chat-more="${esc(agent.id)}" data-less="1">Show less</button>` : ''}
      </div>`
          : ''
      }
    </div>`
    })
    .join('')
}

/**
 * Broadcasts the status the sidebar already fetched.
 *
 * The event is one channel; `window.__shellLastStatus` is the other, for pages
 * whose script ran after the first poll already answered. A module *import* is
 * deliberately NOT used as a third channel: an import resolves to a URL without
 * the `?v=` stamp, which made the browser load shell.js a second time as a
 * separate module -- every sidebar listener existed twice and every toggle
 * undid itself. The bug showed up as "the collapse button does nothing" on the
 * one page that imported this file.
 */
const publishStatus = (status) => {
  window.__shellLastStatus = status
  window.dispatchEvent(new CustomEvent('shell:status', { detail: status }))
}

let lastStatus = null

/**
 * 蜂群 Q5：离开上一个会话时，若它「建了但一个字没写」，顺手清掉。
 *
 * 用 sessionStorage 记住上一次的会话：刷新同一会话（prev 与当前相同）
 * 不算离开，避免「刷新即删自己」；跳到别的会话/别的页才算切换。判断
 * 交给后端 vacate——有回合或有标题的会话它自己会拒。
 */
let prevVacated = false
const maybeVacatePrevious = () => {
  if (prevVacated) return
  prevVacated = true
  const prevId = window.sessionStorage.getItem('manager.prevChatId') ?? ''
  window.sessionStorage.setItem('manager.prevChatId', openChatId)
  if (prevId === '' || prevId === openChatId) return
  const prev = chatById.get(prevId)
  if (prev === undefined || prev.turns > 0 || (prev.title ?? '') !== '') return
  void apiFetch(`/api/chats/${encodeURIComponent(prevId)}/vacate`, { method: 'POST' })
    .then(() => loadShell())
    .catch(() => {
      // 清理是顺手为之，失败不打扰。
    })
}

export const loadShell = async () => {
  try {
    // Chats come from the same poll as the status: the sidebar draws both in one
    // tree, and two independent refreshes would let the rows disagree about
    // which agent is busy for a second at a time.
    const [me, status, threads, nodesData, notifications] = await Promise.all([
      apiFetch('/api/me').then((r) => (r.ok ? r.json() : null)),
      apiFetch('/api/status').then((r) => (r.ok ? r.json() : null)),
      apiFetch('/api/chats').then((r) => (r.ok ? r.json() : null)),
      apiFetch('/api/nodes').then((r) => (r.ok ? r.json() : null)).catch(() => null),
      apiFetch('/api/notifications').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ])
    if (me === null) {
      window.location.href = '/login'
      return
    }
    // 蜂群2计划 P3：首登强制改密 —— 除改密页外一律弹过去。
    // 顺序关键：改密期间业务 API（status 等）被 403 门挡住，status 必为 null，
    // 若先判 status 会把改密页弹回 /login 造成死循环（发布前评审 B1）。
    const onPasswordPage = window.location.pathname === '/password'
    if (me.mustChangePassword === true) {
      if (!onPasswordPage) {
        window.location.href = '/password'
        return
      }
      // 改密页：业务 API 不可用，只画壳 + 用户名，其余渲染直接跳过
      $('who').textContent = me.username
      const avatar = $('avatar')
      if (avatar !== null) avatar.textContent = [...me.username][0] ?? '?'
      return
    }
    if (status === null) {
      window.location.href = '/login'
      return
    }

    if (notifications !== null) {
      setNotifyBadge(notifications.unread)
      if (!notifyPanel.hidden) renderNotifyPanel(notifications.items)
    }

    // 品牌页脚的运行时版本（⋮ 菜单里那行）；status 里带的是 manager 版本。
    if (typeof status.managerVersion === 'string' && status.managerVersion !== '') {
      const version = $('side-version')
      if (version !== null) version.textContent = `v${status.managerVersion}`
    }

    if (threads !== null) {
      chatsByAgent = new Map(threads.agents.map((a) => [a.id, a.chats]))
      chatById = new Map(threads.agents.flatMap((a) => a.chats.map((c) => [c.id, c])))
      busyByAgent = new Map(threads.agents.map((a) => [a.id, a.busyRunId]))
      activeByAgent = new Map(threads.agents.map((a) => [a.id, a.activeRuns ?? 0]))
      revealOpenChat(threads.agents)
      maybeVacatePrevious()
    }

    $('who').textContent = me.username
    const avatar = $('avatar')
    if (avatar !== null) avatar.textContent = [...me.username][0] ?? '?'
    $('agent-count').textContent = treeAgents(status).length === 0 ? '' : treeAgents(status).length
    setHtml('agent-nav', treeAgents(status).length === 0 ? `<p class="muted small">${esc(t('side.noAgents'))}</p>` : agentNav(status))
    renderBrain(status)
    if (nodesData !== null && Array.isArray(nodesData.nodes)) renderNodes(nodesData)
    else renderEndpointLines(status)

    lastStatus = status
    publishStatus(status)
  } catch {
    // The frame failing must not stop the page inside it from working.
  }
}

/**
 * Month-to-date spend, in the sidebar.
 *
 * On its own page it would only be seen by someone who already suspected a
 * problem. Cron makes this number move while nobody is watching, so it belongs
 * where it is passively visible.
 */
const loadSpendHint = async () => {
  try {
    const response = await apiFetch('/api/usage')
    if (!response.ok) return
    // 变量名不要用 t：它会遮蔽 ui.js 的翻译函数（2026-09-24 线上事故的同一类）。
    const totals = (await response.json()).totals
    if (totals.runs === 0) return
    const usd = totals.costMicroUsd / 1e6
    const amount = usd < 0.01 ? `$${usd.toFixed(4)}` : usd < 1 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`
    // A floor, not a total, whenever some model had no configured rate.
    $('spend-hint').textContent = `${totals.unpriced > 0 ? '≥' : ''}${amount}`
  } catch {
    // A missing figure must never take the page down with it.
  }
}

// 公开版精简（DAC v1.0.0）：侧栏「定时任务」提示随页面一并下线——调度健康度
// 改由任务页/审计页承载（调度引擎未动，/api/crons 与内部 API 保留）。

// ---------------------------------------------------------------------------
// navigation: one sidebar, two presentations
// ---------------------------------------------------------------------------
//
// Above 1024px the sidebar is docked and the control collapses it to an icon
// rail. Below, it is an off-canvas drawer behind the app bar's hamburger. Both
// go through this one place, because to the user it is a single thing -- the
// sidebar getting out of the way -- and two independent implementations would
// drift the moment a window is resized across the boundary.

const RAIL_KEY = 'manager.nav.rail'
const docked = () => window.matchMedia('(min-width: 1024px)').matches
const railed = () => document.body.classList.contains('nav-rail')
const drawerOpen = () => document.body.classList.contains('nav-open')

/** Focusable controls inside the drawer, for the focus trap and initial focus. */
const drawerStops = () =>
  [...document.querySelectorAll('#sidebar a[href], #sidebar button:not([disabled])')].filter(
    (node) => node.offsetParent !== null,
  )

/** What the control does next, spelled out rather than left to the icon. */
const syncNavControls = () => {
  const collapse = $('nav-collapse')
  const opener = $('nav-open')
  if (collapse === null || opener === null) return
  if (docked()) {
    const label = railed() ? t('side.expandRail') : t('side.collapse')
    collapse.setAttribute('aria-label', label)
    collapse.title = `${label}（[）`
  } else {
    collapse.setAttribute('aria-label', t('side.closeNav'))
    collapse.title = t('side.closeNav')
  }
  opener.setAttribute('aria-expanded', String(drawerOpen()))
}

const setRail = (on) => {
  document.body.classList.toggle('nav-rail', on)
  try {
    window.localStorage.setItem(RAIL_KEY, on ? '1' : '0')
  } catch {
    // A preference that cannot be stored still applies to this page.
  }
  syncNavControls()
}

/** Where focus was before the drawer took it, so it can be handed back. */
let focusBeforeDrawer = null

const openDrawer = () => {
  focusBeforeDrawer = document.activeElement
  document.body.classList.add('nav-open')
  // Focus moves into the drawer: a keyboard user who opens it and keeps tabbing
  // must not walk through the page behind an opaque overlay.
  drawerStops()[0]?.focus()
  syncNavControls()
}

const closeDrawer = () => {
  if (!drawerOpen()) return
  document.body.classList.remove('nav-open')
  if (focusBeforeDrawer instanceof HTMLElement) focusBeforeDrawer.focus()
  focusBeforeDrawer = null
  syncNavControls()
}

const toggleNav = () => {
  if (docked()) setRail(!railed())
  else if (drawerOpen()) closeDrawer()
  else openDrawer()
}

/**
 * Null-safe binding for the frame's controls.
 *
 * A missing element here used to mean an uncaught TypeError that killed the
 * rest of the shell's wiring -- one stale page and every button after it went
 * dead together. Now it logs once, loudly, and the frame keeps working.
 * `scripts/check-ids.mjs` cross-checks these ids against the rendered pages;
 * this is the runtime safety net for anything the audit misses.
 */
const bind = (id, event, handler) => {
  const node = $(id)
  if (node === null) {
    console.warn(`[shell] 找不到 #${id}，${event} 监听未挂载 -- 页面模板可能过期，请重启服务后强刷`)
    return
  }
  node.addEventListener(event, handler)
}

bind('nav-open', 'click', toggleNav)
bind('nav-collapse', 'click', () => {
  console.debug('[shell] nav toggle click:', { docked: docked(), railed: railed(), drawerOpen: drawerOpen() })
  toggleNav()
  console.debug('[shell] after toggle:', { railed: railed(), drawerOpen: drawerOpen() })
})
bind('nav-backdrop', 'click', closeDrawer)

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && drawerOpen()) {
    closeDrawer()
    // The conversation page also listens for Escape, to cancel a running turn.
    // Dismissing an overlay must not double as cancelling work behind it.
    event.stopImmediatePropagation()
    return
  }

  if (event.key === 'Tab' && drawerOpen()) {
    const stops = drawerStops()
    if (stops.length === 0) return
    const first = stops[0]
    const last = stops[stops.length - 1]
    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    }
    return
  }

  // `[` is the shortcut every editor-shaped app uses for this. Guarded against
  // firing while typing -- the composer is the most-used control in the app.
  if (event.key !== '[' || event.metaKey || event.ctrlKey || event.altKey) return
  const target = event.target
  if (target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) {
    return
  }
  event.preventDefault()
  toggleNav()
})

// Crossing the breakpoint with the drawer open would leave the docked sidebar
// with a stale overlay and a scroll lock over the whole page.
window.matchMedia('(min-width: 1024px)').addEventListener('change', () => {
  if (docked()) closeDrawer()
  syncNavControls()
})

try {
  if (window.localStorage.getItem(RAIL_KEY) === '1') document.body.classList.add('nav-rail')
} catch {
  // Storage being unavailable just means the sidebar starts expanded.
}

/**
 * The app bar's title.
 *
 * Derived from the path rather than from `document.title`, which is suffixed for
 * the browser tab. The conversation page overrides it with the thread's own name
 * through `shell:title`, since on a phone that bar is the only place the title
 * appears.
 */
const SECTION_TITLES = {
  app: t('topbar.home'),
  chat: t('topbar.chat'),
  archive: t('topbar.archive'),
  spend: t('topbar.spend'),
}
const setTopbarTitle = (text) => {
  $('topbar-title').textContent = text
}
setTopbarTitle(SECTION_TITLES[segments[0] ?? ''] ?? 'DAC')
window.addEventListener('shell:title', (event) => {
  if (typeof event.detail === 'string' && event.detail !== '') setTopbarTitle(event.detail)
})

/**
 * How much is archived, in the sidebar.
 *
 * Archiving is reversible, and a reversible action nobody is reminded of is one
 * nobody ever reverses.
 */
const loadArchiveHint = async () => {
  try {
    const response = await apiFetch('/api/chats/archived')
    if (!response.ok) return
    const { chats } = await response.json()
    $('archive-hint').textContent = chats.length === 0 ? '' : String(chats.length)
  } catch {
    // Same rule as the other hints: a missing figure is not worth an error.
  }
}

// ---------------------------------------------------------------------------
// per-row actions
// ---------------------------------------------------------------------------
//
// Rename and archive live on the row rather than only on the open conversation:
// tidying up is something you do to a list, and needing to open each thread
// first is what makes people leave the list untidy instead.

const menu = document.createElement('div')
menu.className = 'row-menu'
menu.setAttribute('role', 'menu')
menu.hidden = true
document.body.appendChild(menu)

/** The row whose menu is open, so an action knows its target. */
let menuChatId = null

const closeMenu = () => {
  menu.hidden = true
  menuChatId = null
  // The tree is redrawn every 15 seconds, so the button that was open may be
  // gone; querying the live DOM rather than holding a reference.
  for (const button of document.querySelectorAll('.row-more[aria-expanded="true"]')) {
    button.setAttribute('aria-expanded', 'false')
  }
}

const openMenu = (button, chatId) => {
  menuChatId = chatId
  button.setAttribute('aria-expanded', 'true')
  menu.innerHTML = `<button type="button" role="menuitem" data-act="rename">${esc(t('menu.rename'))}</button>
    <button type="button" role="menuitem" data-act="archive">${icon('archive', 13)}${esc(t('menu.archive'))}</button>`
  menu.hidden = false
  // Positioned after unhiding, since a hidden element measures as 0. Clamped to
  // the viewport so a row near the bottom does not open a menu off screen.
  const rect = button.getBoundingClientRect()
  const top = Math.min(rect.bottom + 4, window.innerHeight - menu.offsetHeight - 8)
  const left = Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8)
  menu.style.top = `${Math.max(8, top)}px`
  menu.style.left = `${Math.max(8, left)}px`
  menu.querySelector('button')?.focus()
}

const titleOf = (chatId) => {
  const chat = chatById.get(chatId)
  const title = chat?.title ?? ''
  return title === '' ? t('side.newChat') : title
}

const rename = async (chatId) => {
  const title = window.prompt(t('menu.renamePrompt'), titleOf(chatId))
  if (title === null || title.trim() === '') return
  const response = await apiFetch(`/api/chats/${encodeURIComponent(chatId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: title.trim() }),
  })
  if (!response.ok) {
    window.alert(t('menu.renameFailed'))
    return
  }
  await loadShell()
}

const archive = async (chatId) => {
  // Says what archiving does *not* do, because "归档" has to be believable: the
  // transcript and the bill both survive it.
  if (!window.confirm(t('menu.archiveConfirm', { title: titleOf(chatId) }))) {
    return
  }
  const response = await apiFetch(`/api/chats/${encodeURIComponent(chatId)}/remove`, { method: 'POST' })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    window.alert(body.detail ?? t('menu.archiveFailed'))
    return
  }
  // Archiving the conversation you are reading leaves the page showing a thread
  // that is no longer in the list. Jump straight to that agent's latest
  // remaining chat -- never through /app, which used to redirect to the brain's
  // latest chat right after and reload the page twice for the user.
  if (chatId === openChatId) {
    let fallback
    for (const chats of chatsByAgent.values()) {
      if (chats.some((c) => c.id === chatId)) {
        fallback = chats.filter((c) => c.id !== chatId)[0]
        break
      }
    }
    window.location.href = fallback === undefined ? '/' : `/chat/${encodeURIComponent(fallback.id)}`
    return
  }
  await Promise.all([loadShell(), loadArchiveHint()])
}

menu.addEventListener('click', async (event) => {
  const item = event.target.closest('button[data-act]')
  if (item === null || menuChatId === null) return
  const chatId = menuChatId
  const act = item.dataset.act
  closeMenu()
  if (act === 'rename') await rename(chatId)
  else if (act === 'archive') await archive(chatId)
})

// Fixed positioning means the menu would otherwise stay put while the sidebar
// scrolls out from under it.
document.addEventListener('click', (event) => {
  if (menu.hidden) return
  if (!menu.contains(event.target) && event.target.closest('.row-more') === null) closeMenu()
})
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !menu.hidden) {
    closeMenu()
    event.stopImmediatePropagation()
  }
})
$('agent-nav').addEventListener('scroll', closeMenu)

// ---------------------------------------------------------------------------
// agent details
// ---------------------------------------------------------------------------
//
// The dot in the tree is *endpoint* health, and when several agents share an
// endpoint every one of their dots moves together -- which reads as "all these
// agents are broken" when the truth is "one DSH process is". Until now that dot
// was a tooltip and nothing else. It is now the way into this panel, which says
// which endpoint, who else is on it, and what sharing it means.

const panel = $('agent-panel')

const closePanel = () => {
  panel.hidden = true
}

const kv = (label, value) => `<div class="kv"><dt>${esc(label)}</dt><dd>${value}</dd></div>`

const RUN_STATE = { done: 'ok', failed: 'bad', running: 'warn', missed: 'warn', skipped: 'muted' }

const panelBody = (data) => {
  const { agent, endpoint, sharedWith, month, runs, chats } = data
  const health = endpoint.reachable ? (endpoint.apiKeySet === false || endpoint.enabled === false ? 'warn' : 'ok') : 'bad'
  const usd = month.costMicroUsd / 1e6
  const cost = `${month.unpriced > 0 ? '≥' : ''}$${usd < 1 ? usd.toFixed(4) : usd.toFixed(2)}`

  const rows = [
    kv(t('panel.endpoint'), `<span class="dot ${health}"></span> ${esc(endpoint.id)} · <code>${esc(endpoint.url)}</code>`),
    kv(
      t('panel.endpointStatus'),
      endpoint.reachable
        ? `${esc(t('panel.reachable'))}${typeof endpoint.sessions === 'number' ? esc(t('panel.reachableSessions', { count: endpoint.sessions })) : ''}${endpoint.apiKeySet === false ? t('panel.keyNotSet') : ''}`
        : `<span class="error">${esc(t('panel.unreachable', { reason: endpoint.error ?? t('panel.unknownReason') }))}</span>`,
    ),
    // 容器形态：镜像标签即节点 DSH 版本的真相，先于版本行展示。
    ...(typeof endpoint.image === 'string' && endpoint.image !== ''
      ? [kv(t('panel.image'), `<code>${esc(endpoint.image)}</code>`)]
      : []),
    kv(
      t('panel.dshVersion'),
      typeof endpoint.dshVersion === 'string' && endpoint.dshVersion !== ''
        ? `<code>${esc(endpoint.dshVersion)}</code>${endpoint.dshCompatible === false ? ` <span class="warn">${esc(t('panel.versionMismatch'))}</span>` : ''}`
        : `<span class="muted">${esc(t('panel.unknown'))}</span>`,
    ),
    kv(t('panel.workspace'), `<code>${esc(agent.workspacePath)}</code>`),
    kv('preset', agent.preset === null ? `<span class="muted">${esc(t('panel.presetFollow'))}</span>` : `<code>${esc(agent.preset)}</code>`),
    kv(
      t('panel.model'),
      agent.model === null
        ? `<span class="muted">${esc(t('panel.presetFollow'))}</span>`
        : `<code>${esc(agent.provider === null ? agent.model : `${agent.provider}/${agent.model}`)}</code>`,
    ),
    kv(t('panel.public'), agent.public ? t('panel.publicYes') : t('panel.no')),
    kv(t('panel.sessions'), `${t('panel.sessionsActive', { count: chats.active })}${chats.archived > 0 ? t('panel.sessionsArchived', { count: chats.archived }) : ''}`),
    kv(t('panel.monthCost'), t('panel.monthCostValue', { cost, runs: month.runs })),
    kv(
      t('panel.state'),
      data.busyRunId === null
        ? t('panel.idle')
        : (data.activeRuns ?? 1) > 1
          ? t('panel.runningMany', { count: data.activeRuns })
          : t('panel.runningOne'),
    ),
  ]

  // Named, not counted: "shares an endpoint with 1 other agent" leaves you
  // guessing which one can read this workspace.
  if (sharedWith.length > 0) {
    rows.push(
      kv(
        t('panel.shared'),
        `${sharedWith.map((a) => esc(a.name)).join(', ')}<div class="muted small">${esc(t('panel.sharedNote'))}</div>`,
      ),
    )
  }

  const runList =
    runs.length === 0
      ? `<p class="muted small">${esc(t('panel.noRuns'))}</p>`
      : runs
          .map(
            (r) => `<div class="panel-run">
              <span class="${RUN_STATE[r.state] ?? 'muted'}">${esc(r.state)}</span>
              <span class="muted">${esc(r.trigger)}</span>
              <span class="grow muted small">${esc(when(r.startedAt))}</span>
            </div>`,
          )
          .join('')

  return `<dl class="kv-list">${rows.join('')}</dl>
    ${data.warnings.length === 0 ? '' : data.warnings.map((w) => banner('warn', t('panel.configWarning'), w)).join('')}
    <h3 class="panel-sub">${esc(t('panel.recentRuns'))}</h3>
    ${runList}
    <div class="panel-actions">
      <a class="btn-quiet btn-sm" href="/spend">${esc(t('panel.costDetail'))}</a>
    </div>`
}

const openPanel = async (agentId) => {
  panel.hidden = false
  $('agent-panel-title').textContent = agentId
  setHtml('agent-panel-content', '<div class="skeleton w60"></div><div class="skeleton w40"></div>')
  panel.querySelector('[data-close]')?.focus()
  try {
    const response = await apiFetch(`/api/agents/${encodeURIComponent(agentId)}`)
    if (!response.ok) {
      setHtml('agent-panel-content', banner('bad', t('panel.detailFailed'), t('panel.serverStatus', { status: response.status })))
      return
    }
    const data = await response.json()
    $('agent-panel-title').textContent = data.agent.name
    setHtml('agent-panel-content', panelBody(data))
  } catch (error) {
    setHtml('agent-panel-content', banner('bad', t('panel.detailFailed'), error.message))
  }
}

panel.addEventListener('click', (event) => {
  if (event.target.closest('[data-close]') !== null) closePanel()
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !panel.hidden) {
    closePanel()
    // Same reason as the drawer: dismissing an overlay is not cancelling the
    // turn running behind it.
    event.stopImmediatePropagation()
  }
})

/** Marks the section you are in, so the frame says where you are. */
const markActive = () => {
  const path = window.location.pathname
  for (const link of document.querySelectorAll('.side-link[data-nav]')) {
    link.classList.toggle('active', path === `/${link.dataset.nav}`)
  }
}

/**
 * Tree interactions, delegated.
 *
 * Bound to the container once rather than to each row: the poll rewrites the
 * tree's markup every 15 seconds, and per-row listeners would be attached to
 * nodes that no longer exist.
 */
$('agent-nav').addEventListener('click', async (event) => {
  const info = event.target.closest('.dot-btn')
  if (info !== null) {
    await openPanel(info.dataset.info)
    return
  }

  const more = event.target.closest('.row-more')
  if (more !== null) {
    // Second click on the same row closes it, which is what a toggle button is
    // expected to do.
    if (menuChatId === more.dataset.more) closeMenu()
    else openMenu(more, more.dataset.more)
    return
  }

  // "Show x more sessions" / "Show less": unfold or re-cap this agent's chat
  // list. Remembered per agent, like the expand preference.
  const chatMore = event.target.closest('[data-chat-more]')
  if (chatMore !== null) {
    setChatsMore(chatMore.dataset.chatMore, chatMore.dataset.less !== '1')
    if (lastStatus !== null) setHtml('agent-nav', agentNav(lastStatus))
    return
  }

  const toggle = event.target.closest('.tree-toggle')
  if (toggle !== null) {
    const group = toggle.closest('.tree-group')
    const open = group.classList.toggle('open')
    toggle.setAttribute('aria-expanded', String(open))
    setExpanded(toggle.dataset.toggle, open)
    // Redrawn from data rather than by hiding a node: the children are not
    // rendered at all while collapsed, so there is nothing to show.
    if (lastStatus !== null) setHtml('agent-nav', agentNav(lastStatus))
    return
  }

  const create = event.target.closest('[data-new]')
  if (create === null) return

  // A chat row cannot be linked to before it exists, so this is a request
  // followed by a navigation rather than a plain link.
  create.disabled = true
  try {
    const response = await apiFetch('/api/chats', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: create.dataset.new }),
    })
    if (!response.ok) {
      create.disabled = false
      return
    }
    const { chat } = await response.json()
    window.location.href = `/chat/${encodeURIComponent(chat.id)}`
  } catch {
    create.disabled = false
  }
})

// ---------------------------------------------------------------------------
// 蜂群 P5.3：站内通知（铃铛 + 面板）
// ---------------------------------------------------------------------------

const notifyBadge = $('notify-badge')
const notifyPanel = document.createElement('div')
notifyPanel.className = 'notify-panel'
notifyPanel.hidden = true
document.body.appendChild(notifyPanel)

// ---------------------------------------------------------------------------
// 导航分层（DAC v1.0.0）：节点 / 任务 常驻侧栏；技能 / 已归档 / 花费 / 审计 /
// 改密 收进左下角 ⋮ 弹窗（+ 品牌页脚 + 退出登录）。九个平级入口会让人把侧栏
// 当文档读，而每天真正用的只有两个。
// ⋮ 菜单与通知面板同一浮层语言：body 挂载 + fixed rect 定位（抽屉/rail 不裁剪）。
// markActive() 在下方执行，菜单必须在它之前入 DOM 才能吃到高亮。
// ---------------------------------------------------------------------------

const navLinkHtml = (item) => `<a class="side-link"${item.id === undefined ? '' : ` id="${item.id}"`} href="${item.href}" data-nav="${item.nav}">
      <svg width="14" height="14" aria-hidden="true"><use href="#i-${item.icon}" /></svg>
      <span class="grow">${item.label}</span>
      ${item.hint === null ? '' : `<span id="${item.hint}" class="muted small"></span>`}
    </a>`

const PRIMARY_NAV = [
  { href: '/nodes', nav: 'nodes', icon: 'server', label: t('nav.nodes'), hint: 'nodes-hint', id: 'nodes-link' },
  { href: '/runs', nav: 'runs', icon: 'history', label: t('nav.runs'), hint: null },
]

const MORE_NAV = [
  { href: '/skills', nav: 'skills', icon: 'spark', label: t('nav.skills'), hint: null },
  { href: '/archive', nav: 'archive', icon: 'archive', label: t('nav.archive'), hint: 'archive-hint' },
  { href: '/spend', nav: 'spend', icon: 'coin', label: t('nav.spend'), hint: 'spend-hint' },
  { href: '/audit', nav: 'audit', icon: 'shield', label: t('nav.audit'), hint: null },
  { href: '/password', nav: 'password', icon: 'pencil', label: t('nav.password'), hint: null },
]

const primaryNav = $('side-primary')
if (primaryNav !== null) primaryNav.innerHTML = PRIMARY_NAV.map(navLinkHtml).join('')

const moreMenu = document.createElement('div')
moreMenu.id = 'side-more-menu'
moreMenu.className = 'side-more-menu'
moreMenu.setAttribute('aria-label', t('nav.more'))
moreMenu.hidden = true
moreMenu.innerHTML = `${MORE_NAV.map(navLinkHtml).join('')}
  <div class="more-divider"></div>
  <!-- 语言切换（DAC v1.0.0）：点到 ?lang=xx，服务端写 cookie 并 302 回干净 URL；
       语言名一律用本族语写法（English / 中文），切换时不靠猜。 -->
  <div class="more-langs" role="group" aria-label="${esc(t('nav.language'))}">
    ${availableLocales()
      .map(
        (tag) =>
          `<a class="side-link${tag === currentLocale() ? ' active' : ''}" href="?lang=${encodeURIComponent(tag)}" hreflang="${esc(tag)}" lang="${esc(tag)}">
      <span class="grow">${esc(t(`lang.${tag}`))}</span>
      ${tag === currentLocale() ? '<span class="muted small">✓</span>' : ''}
    </a>`,
      )
      .join('')}
  </div>
  <!-- 品牌页脚（DAC v1.0.0）：全称 + 口号 + 仓库入口 + 运行时版本（版本号
       由 shell 的 /api/status 轮询回填，不在页面里写死）。 -->
  <div class="more-brand">
    <div class="more-brand-line"><strong>${esc(brand.name)}</strong> <span class="muted small">${esc(brand.full)}</span> <span id="side-version" class="muted small"></span></div>
    ${brand.tagline === '' ? '' : `<div class="muted small">${esc(brand.tagline)}</div>`}
    ${brand.repo === '' ? '' : `<a class="side-link" href="${esc(brand.repo)}" target="_blank" rel="noopener noreferrer" title="${esc(t('nav.sourceTitle'))}">
      <svg width="14" height="14" aria-hidden="true"><use href="#i-github" /></svg>
      <span class="grow">GitHub</span>
      <span class="muted small">↗</span>
    </a>`}
  </div>
  <button id="logout" class="more-logout" type="button">
    <svg width="14" height="14" aria-hidden="true"><use href="#i-logout" /></svg>
    <span class="grow">${esc(t('nav.logout'))}</span>
  </button>`
document.body.appendChild(moreMenu)

// 登出绑定在菜单入 DOM 之后（id 是同一套，绑定时机决定成败）。
$('logout')?.addEventListener('click', async () => {
  await apiFetch('/api/logout', { method: 'POST' })
  window.location.href = '/login'
})

const moreBtn = $('side-more')

const closeMoreMenu = () => {
  moreMenu.hidden = true
  moreBtn?.setAttribute('aria-expanded', 'false')
}

const openMoreMenu = () => {
  closeNotifyPanel()
  const rect = moreBtn?.getBoundingClientRect()
  if (rect !== undefined) {
    // 菜单右下角对齐按钮，向左上方展开；视口边缘钳制，不越界。
    moreMenu.style.bottom = `${window.innerHeight - rect.top + 8}px`
    moreMenu.style.left = `${Math.min(Math.max(rect.right - 224, 8), window.innerWidth - 232)}px`
  }
  moreMenu.hidden = false
  moreBtn?.setAttribute('aria-expanded', 'true')
  // 菜单打开焦点进首项（标准菜单行为）；Esc 关闭时归还按钮。
  moreMenu.querySelector('a')?.focus()
}

moreBtn?.addEventListener('click', (event) => {
  event.stopPropagation()
  if (moreMenu.hidden) openMoreMenu()
  else closeMoreMenu()
})

document.addEventListener('click', (event) => {
  if (moreMenu.hidden) return
  if (event.target.closest('#side-more') !== null) return
  if (!moreMenu.contains(event.target)) closeMoreMenu()
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !moreMenu.hidden) {
    closeMoreMenu()
    moreBtn?.focus()
  }
})

const setNotifyBadge = (unread) => {
  if (notifyBadge === null) return
  if (unread === 0) notifyBadge.hidden = true
  else {
    notifyBadge.hidden = false
    notifyBadge.textContent = unread > 99 ? '99+' : String(unread)
  }
}

const renderNotifyPanel = (items) => {
  const list =
    items.length === 0
      ? `<p class="notify-empty muted small">${esc(t('notify.empty'))}</p>`
      : items
          .map(
            (n) =>
              `<a class="notify-item${n.read ? '' : ' unread'}" href="${n.link === null ? '#' : esc(n.link)}" data-nid="${esc(n.id)}">
                <div class="notify-title">${esc(n.title)}</div>
                <div class="notify-body">${esc(n.body)}</div>
                <div class="notify-time">${esc(ago(n.at))}</div>
              </a>`,
          )
          .join('')
  notifyPanel.innerHTML = `<div class="notify-head">
      <strong>${esc(t('notify.title'))}</strong>
      <button type="button" class="btn-quiet btn-sm" data-notify-read-all>${esc(t('notify.readAll'))}</button>
    </div>
    <div class="notify-list">${list}</div>`
}

const closeNotifyPanel = () => {
  notifyPanel.hidden = true
}

$('notify-bell')?.addEventListener('click', async (event) => {
  event.stopPropagation()
  if (!notifyPanel.hidden) {
    closeNotifyPanel()
    return
  }
  closeMoreMenu()
  try {
    const response = await apiFetch('/api/notifications')
    if (!response.ok) return
    const body = await response.json()
    const bell = $('notify-bell')
    if (bell === null) return
    const rect = bell.getBoundingClientRect()
    notifyPanel.style.bottom = `${window.innerHeight - rect.top + 10}px`
    notifyPanel.style.left = `${Math.min(rect.left, window.innerWidth - 340)}px`
    renderNotifyPanel(body.items)
    notifyPanel.hidden = false
  } catch {
    // 面板保持关闭
  }
})

notifyPanel.addEventListener('click', async (event) => {
  const readAll = event.target.closest('[data-notify-read-all]')
  if (readAll !== null) {
    await apiFetch('/api/notifications/read-all', { method: 'POST' })
    setNotifyBadge(0)
    closeNotifyPanel()
    return
  }
  const item = event.target.closest('.notify-item')
  if (item === null) return
  await apiFetch(`/api/notifications/${encodeURIComponent(item.dataset.nid)}/read`, { method: 'POST' })
  // 纯告知（无链接）点了不跳转，只标已读
  if (item.getAttribute('href') === '#') event.preventDefault()
})

document.addEventListener('click', (event) => {
  if (notifyPanel.hidden) return
  if (event.target.closest('#notify-bell') !== null) return
  if (!notifyPanel.contains(event.target)) closeNotifyPanel()
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !notifyPanel.hidden) closeNotifyPanel()
})

markActive()
syncNavControls()
void loadShell()
void loadSpendHint()
void loadArchiveHint()

// Endpoint health changes on its own (DSH restarts, key rotation). The hints
// move far more slowly, so they poll at a fraction of the rate.
//
// Nothing polls while the page is hidden. A background tab has nothing to draw,
// and its requests still compete for the six connections HTTP/1.1 allows an
// origin -- which the tab you are actually looking at needs. Refreshed on return
// instead, which is also when a stale sidebar would first be noticed.
// 债务 F4:本地 poll 已收敛进 ui.js 的 poll(document.hidden 挂起 + 错误退避)。

poll(loadShell, 15_000)
poll(loadSpendHint, 60_000)
// Slower still: this count only changes when you change it.
poll(loadArchiveHint, 300_000)

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return
  void loadShell()
  void loadArchiveHint()
  void selfHealStaleFrame()
})

// ---------------------------------------------------------------------------
// stale-frame self-heal
// ---------------------------------------------------------------------------
//
// Pages are baked at server boot and stamped with content-hashed asset URLs.
// A tab left open across a deploy keeps running its old scripts even after the
// server moves on -- the exact situation where a "broken" button is actually a
// day-old page. On return to a visible tab, compare the shell.js version this
// page loaded against the one the server currently stamps; a mismatch reloads
// once, so the next interaction runs the code the server actually serves.

const loadedShellVersion = (() => {
  const tag = document.querySelector('script[src*="/assets/shell.js"]')
  if (tag === null) return null
  try {
    return new URL(tag.src, window.location.href).searchParams.get('v')
  } catch {
    return null
  }
})()

// One loud line per page load: whoever reports a broken button can paste this
// and the failure layer is immediately obvious (stale version / narrow window).
console.info(
  `[shell] loaded shell.js?v=${loadedShellVersion} at ${window.location.href} · innerWidth=${window.innerWidth} · docked=${docked()}`,
)

let healed = false

const selfHealStaleFrame = async () => {
  if (healed || loadedShellVersion === null) return
  try {
    const response = await apiFetch('/', { headers: { accept: 'text/html' }, cache: 'no-store' })
    if (!response.ok) return
    const html = await response.text()
    const match = html.match(/shell\.js\?v=([a-f0-9]+)/)
    if (match !== null && match[1] !== loadedShellVersion) {
      // One reload, and one only: the fresh page re-runs this check and finds
      // a matching version, so there is nothing left to loop on.
      healed = true
      window.location.reload()
    }
  } catch {
    // Offline or mid-deploy: nothing to heal against.
  }
}

// Run immediately, not only on tab return: a page that has been sitting open
// across a deploy heals on its next load instead of waiting for a background
// round-trip that may never come.
void selfHealStaleFrame()

window.addEventListener('pageshow', (event) => {
  // Back/forward cache restores do not fire visibilitychange: the page comes
  // back frozen, with all its stale wiring intact. Heal those too.
  if (event.persisted) void selfHealStaleFrame()
})
