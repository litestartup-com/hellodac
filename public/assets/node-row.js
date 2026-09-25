// @ts-check
// UI 精简（DAC v1.0.0）：节点行与它的 ⋮ 溢出菜单——纯函数层，DOM 装配留在 nodes.js。
// 可单测（node-row.test.mjs）。与 node-form.js / machines.js 同一分工：能被断言
// 的部分不放进 DOM 文件。
//
// 这次精简的依据（改前实测）：单行原来横向塞了 4 个区块——标题+2 个告警 pill、
// meta（managed/pid/lastError）、detail（agent/镜像/DSH 版本/钉版/主机 + 常驻版本
// 下拉）、最多 5 个操作按钮，外加一张固定 330px 的「原生 GUI」卡（含整条 SSH 隧道
// 命令）。行内绝大多数像素花在偶尔才用的操作上，而「哪个节点活着」被挤到角落。
//
// 精简后主行＝状态、ID、归属、当前版本；其余全部进菜单。
import { esc, t } from './ui.js'
import { nodeMenuItems, versionMenuItems, menuPanelHtml, menuItemHtml, triggerButtonHtml } from './menu.js'

/** 状态点样式。live/offline 是协议里的裸词，不翻译。 */
export const NODE_STATE_DOT = { live: 'ok', cold: 'muted', starting: 'warn', restarting: 'warn', offline: 'bad' }

/**
 * 状态文案：显式反查，不用模板拼键。
 *
 * 拼 `t(\`nodes.state.${state}\`)` 运行时没问题，但键守卫
 * （scripts/check-i18n-keys.mjs）只认字面量：拼出来的键会被判成「未引用」，
 * 于是它们的缺失永远没人发现。写死几行换一个真守得住的门禁。
 */
const STATE_LABEL = {
  cold: () => t('nodes.state.cold'),
  starting: () => t('nodes.state.starting'),
  restarting: () => t('nodes.state.restarting'),
}

/** @param {string} state @returns {string} */
export const nodeStateLabel = (state) => (state === 'live' || state === 'offline' ? state : (STATE_LABEL[state]?.() ?? state))

/** 浮层的 DOM id（节点行菜单与版本子菜单各一个）。 */
export const nodeMenuId = (id) => `node-menu-${id}`
export const nodeVersionMenuId = (id) => `node-version-menu-${id}`

/**
 * 当前 DSH 版本的人类可读串；容器形态优先显示镜像 tag（tag 即版本）。
 * 无任何版本信息 → null（不渲染这一段，避免留个空占位）。
 * @param {{ image?: unknown, dshVersion?: unknown }} n
 * @returns {string | null}
 */
export const nodeVersionText = (n) => {
  if (typeof n.image === 'string' && n.image !== '') return n.image
  if (typeof n.dshVersion === 'string' && n.dshVersion !== '') return `DSH ${n.dshVersion}`
  return null
}

/**
 * 节点行。
 * @param {object} n /api/nodes 的一行
 * @param {(host: string) => string} hostName host id → hostname（未知回退 id）
 * @returns {string}
 */
export const nodeRow = (n, hostName) => {
  const dot = NODE_STATE_DOT[n.state] ?? 'muted'
  const label = nodeStateLabel(n.state)
  const agents = Array.isArray(n.agents) && n.agents.length > 0 ? n.agents.join(' / ') : null
  const version = nodeVersionText(n)
  // 归属：agent 列表与所属主机（跨机场景「它在哪」是关键信息，留在主行）。
  const owner = [agents, typeof n.host === 'string' && n.host !== '' ? hostName(n.host) : null].filter((x) => x !== null).join(' · ')
  // 告警必须一眼可见，所以留常显（这正是「一目了然」的核心，不进菜单）。
  const versionWarn =
    typeof n.dshVersion === 'string' && n.dshVersion !== '' && n.dshCompatible === false
      ? `<span class="pill-mini warn" title="${esc(t('nodes.versionWarnTitle', { version: n.dshVersion }))}">${esc(t('nodes.versionWarn'))}</span>`
      : ''
  const driftWarn =
    n.dshDrift === true ? `<span class="pill-mini warn" title="${esc(t('nodes.driftWarnTitle'))}">${esc(t('nodes.driftWarn'))}</span>` : ''
  // 错误保留可见，但压成一行 + 悬停看全文：排障要能立刻看到，同时不许它撑高整行。
  const err =
    typeof n.lastError === 'string' && n.lastError !== ''
      ? `<div class="node-err" title="${esc(n.lastError)}">${esc(n.lastError)}</div>`
      : ''
  const trigger = triggerButtonHtml({ id: `node-more-${n.id}`, label: t('common.more'), controls: nodeMenuId(n.id) })
  return `<div class="node-row" data-node-row="${esc(n.id)}">
    <div class="node-main">
      <div class="node-title"><span class="dot ${dot}"></span>${esc(n.id)} <span class="node-state">${esc(label)}</span> ${versionWarn} ${driftWarn}</div>
      ${owner === '' ? '' : `<div class="node-sub">${esc(owner)}</div>`}
      ${err}
    </div>
    ${version === null ? '' : `<div class="node-ver" title="${esc(t('nodes.currentVersion'))}">${esc(version)}</div>`}
    ${trigger}
  </div>`
}

/**
 * 节点行的浮层（主菜单 + 版本子菜单），挂 body。
 *
 * 两个浮层一次出齐、常驻 DOM，只在打开时定位并显示——避免每次点击重建 DOM
 * （重建会丢焦点，键盘用户每点一次就被踢回文档开头）。
 * @param {object} n
 * @param {Array<{ dsh: string, status: string }>} versionList
 * @returns {string}
 */
export const nodeMenuHtml = (n, versionList) => {
  const items = nodeMenuItems({
    id: n.id,
    state: n.state,
    managed: n.managed === true,
    dshDrift: n.dshDrift === true,
    pinnedVersion: typeof n.configuredDshVersion === 'string' ? n.configuredDshVersion : null,
    hasVersions: Array.isArray(versionList) && versionList.length > 0,
    versionMenuId: nodeVersionMenuId(n.id),
  })
  // 原生 GUI：原来常显一张 330px 的卡（含整条 SSH 隧道命令）。隧道命令、打开、
  // 配置三项都在「原生访问」编辑器里，所以菜单只留一个入口，不再重复一份。
  items.push(menuItemHtml({ label: t('nodes.access.title'), attrs: `data-node-access="${esc(n.id)}"` }))
  const main = menuPanelHtml({ id: nodeMenuId(n.id), label: t('common.more'), items })
  const sub = menuPanelHtml({
    id: nodeVersionMenuId(n.id),
    label: t('nodes.action.version'),
    items: versionMenuItems(versionList, n.configuredDshVersion),
    modifier: 'menu-sub',
  })
  return main + sub
}
