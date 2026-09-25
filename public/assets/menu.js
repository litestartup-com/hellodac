// @ts-check
// 通用浮层菜单原语（DAC v1.0.0 UI 精简）：溢出菜单（⋮）与其子菜单的纯函数层。
//
// 为什么要有这一层：节点行、抽屉底部的语言/关于都长成「一行触发器 → 点开一列菜单
// → 其中某项再展开第二层」的形状。以前每处各写一遍浮层与定位，视觉与行为就会
// 各自漂移；这里把「行怎么画」「菜单怎么排」「浮层往哪摆」收敛成三个纯函数，
// DOM 装配与事件绑定留在各自页面（可单测：menu.test.mjs）。
//
// 定位约束（实测过的坑，别用 CSS 的 absolute 图省事）：
//   节点行、抽屉都在会裁剪/滚动/变换的容器里（.card 圆角裁剪、抽屉 transform），
//   absolute 子菜单会被裁掉。所以浮层一律 position: fixed + 挂 body，
//   坐标由 JS 按触发器 rect 现算，并在视口边缘钳制。
import { esc, t } from './ui.js'

/** 触发器按钮：⋮ 溢出菜单的标准形态（图标按钮，带展开态标记）。 */
export const triggerButtonHtml = ({ id, label, controls }) =>
  `<button type="button" class="icon-btn menu-trigger" id="${esc(id)}" aria-haspopup="true" aria-expanded="false" aria-controls="${esc(controls)}" title="${esc(label)}" aria-label="${esc(label)}"><svg width="16" height="16" aria-hidden="true"><use href="#i-more-v" /></svg></button>`

/**
 * 一行菜单项。
 *
 * 刻意**不带图标**：图标集里没有 stop/restart/tag 这些语义图标，硬凑会拿错图标
 * 表达错意思；而节点行原来的操作按钮本来也是纯文字，菜单保持一致更好读。
 * @param {{ kind?: 'item' | 'submenu' | 'danger' | 'sep' | 'note' | 'group', label?: string, attrs?: string, trailing?: string | null }} spec
 * @returns {string}
 */
export const menuItemHtml = (spec) => {
  const kind = spec.kind ?? 'item'
  if (kind === 'sep') return '<div class="menu-sep" role="separator"></div>'
  if (kind === 'group') return `<div class="menu-group">${esc(spec.label ?? '')}</div>`
  if (kind === 'note') return `<div class="menu-note">${esc(spec.label ?? '')}</div>`
  const cls = kind === 'danger' ? ' class="menu-item danger"' : ' class="menu-item"'
  const trailing = typeof spec.trailing === 'string' && spec.trailing !== '' ? `<span class="menu-trailing">${esc(spec.trailing)}</span>` : ''
  const attrs = typeof spec.attrs === 'string' ? spec.attrs : ''
  // 子菜单项：点开第二层，用 aria-haspopup 标出来（与普通项区分）。
  const popup = kind === 'submenu' ? ' aria-haspopup="true" aria-expanded="false"' : ''
  return `<button type="button"${cls}${popup} ${attrs}><span class="menu-grow">${esc(spec.label ?? '')}</span>${trailing}${kind === 'submenu' ? '<span class="menu-chevron" aria-hidden="true">›</span>' : ''}</button>`
}

/**
 * 一个浮层菜单面板。
 * @param {{ id: string, label: string, items: string[], modifier?: string, hidden?: boolean, side?: boolean }} spec
 * @returns {string}
 */
export const menuPanelHtml = (spec) => {
  const mod = typeof spec.modifier === 'string' && spec.modifier !== '' ? ` ${spec.modifier}` : ''
  const side = spec.side === true ? ' data-side="1"' : ''
  const hidden = spec.hidden === false ? '' : ' hidden'
  return `<div class="menu-panel${mod}" id="${esc(spec.id)}" role="menu" aria-label="${esc(spec.label)}"${side}${hidden}>${spec.items.join('')}</div>`
}

/**
 * 浮层水平/垂直坐标：先按「右对齐触发器右边缘」试算，再在视口内钳制。
 * 返回的是 CSS 值，调用方直接写 style。
 * @param {{ rect: { top: number, right: number, bottom: number, left: number }, width: number, height: number, viewport: { w: number, h: number }, gap?: number }} p
 * @returns {{ left: number, top: number, side: 'left' | 'right' }}
 */
export const placePanel = ({ rect, width, height, viewport, gap = 8 }) => {
  // 优先右对齐（⋮ 在所有者的右端），越界则改左对齐，仍越界就贴边。
  let left = rect.right - width
  let side = 'left'
  if (left < gap) {
    left = rect.left
    side = 'right'
  }
  if (left + width > viewport.w - gap) left = Math.max(gap, viewport.w - width - gap)
  // 垂直：默认从触发器下方展开；下方放不下且上方更宽裕时翻到上方。
  let top = rect.bottom + 6
  if (top + height > viewport.h - gap && rect.top - height - 6 >= gap) top = rect.top - height - 6
  if (top + height > viewport.h - gap) top = Math.max(gap, viewport.h - height - gap)
  return { left: Math.round(left), top: Math.round(top), side }
}

/**
 * 子菜单挂靠点：主菜单项右边缘 → 子菜单左边缘；放不下就翻到左侧。
 * @param {{ rect: { top: number, right: number, left: number, bottom: number }, width: number, height: number, viewport: { w: number, h: number }, gap?: number }} p
 * @returns {{ left: number, top: number }}
 */
export const placeSubmenu = ({ rect, width, height, viewport, gap = 6 }) => {
  let left = rect.right + gap
  if (left + width > viewport.w - 8) left = Math.max(8, rect.left - width - gap)
  let top = rect.top
  if (top + height > viewport.h - 8) top = Math.max(8, viewport.h - height - 8)
  return { left: Math.round(left), top: Math.round(top) }
}

/**
 * 节点行的 ⋮ 菜单项（纯数据 → HTML）。
 *
 * 为什么要整个搬进菜单：这一行原来常显最多 5 个按钮 + 版本下拉 + 一张 330px 的
 * 原生 GUI 卡（含整条 SSH 命令），真正该一眼看到的「哪个节点活着」反被挤到角落。
 * 低频操作进菜单后，主行只留状态、ID、归属、当前版本。
 *
 * @param {{ id: string, state: string, managed: boolean, dshDrift?: boolean, pinnedVersion?: string | null, hasVersions?: boolean }} n
 * @returns {string[]}
 */
export const nodeMenuItems = (n) => {
  const id = esc(n.id)
  const disabled = n.state === 'starting' ? ' disabled' : ''
  const items = []
  if (!n.managed) {
    // 外管节点 manager 不掌控生命周期，只给日志与原生访问。
    items.push(menuItemHtml({ kind: 'note', label: t('nodes.externalManual') }))
  } else if (n.state === 'cold' || n.state === 'offline') {
    items.push(menuItemHtml({ label: t('nodes.action.start'), attrs: `data-node-up="${id}"` }))
  } else {
    items.push(menuItemHtml({ label: t('nodes.action.stop'), attrs: `data-node-down="${id}"${disabled}` }))
    items.push(menuItemHtml({ label: t('nodes.action.restart'), attrs: `data-node-restart="${id}"${disabled}` }))
  }
  items.push(menuItemHtml({ kind: 'sep' }))
  // 版本切换：原来是常显下拉框，改成子菜单（罕见操作，不配占常显位）。
  if (n.managed && n.hasVersions === true) {
    const pinned = typeof n.pinnedVersion === 'string' && n.pinnedVersion !== '' ? n.pinnedVersion : null
    items.push(
      menuItemHtml({
        kind: 'submenu',
        label: t('nodes.action.version'),
        trailing: pinned ?? t('nodes.version.default'),
        // 带上它控制的面板 id：打开子菜单时直接拿，不必从节点 id 反推。
        attrs: `data-node-version-menu="${id}" aria-controls="${esc(n.versionMenuId ?? '')}"`,
      }),
    )
  }
  // 对齐只在真漂移时出现（原来是个条件按钮，位置却在常显区）。
  if (n.dshDrift === true) items.push(menuItemHtml({ label: t('nodes.action.align'), attrs: `data-node-align="${id}"` }))
  items.push(menuItemHtml({ label: t('nodes.action.logs'), attrs: `data-node-logs="${id}"` }))
  if (n.managed) {
    items.push(menuItemHtml({ kind: 'sep' }))
    items.push(menuItemHtml({ kind: 'danger', label: t('nodes.action.remove'), attrs: `data-node-rm="${id}"` }))
  }
  return items
}

/**
 * 版本子菜单的选项：数据源与旧下拉完全同源（GET /api/nodes 的 supportedDsh 矩阵，
 * 前端不硬编码版本清单），只是渲染成可点菜单项——原生 <select> 在浮层里样式与
 * 键盘行为都会走样，所以子菜单用一组菜单项而不是塞一个 select 进去。
 * @param {Array<{ dsh: string, status: string }>} list
 * @param {string | null | undefined} current 当前钉版（null/空 = 跟随默认）
 * @returns {string[]}
 */
export const versionMenuItems = (list, current) => {
  const cur = typeof current === 'string' && current !== '' ? current : ''
  const follow = menuItemHtml({
    label: t('nodes.form.versionFollowDefault'),
    attrs: 'data-node-version-set=""',
    trailing: cur === '' ? '✓' : null,
  })
  const opts = (Array.isArray(list) ? list : []).map((v) =>
    menuItemHtml({
      label: v.status === 'pending' ? t('nodes.version.pending', { version: v.dsh }) : v.dsh,
      attrs: `data-node-version-set="${esc(v.dsh)}"`,
      trailing: v.dsh === cur ? '✓' : null,
    }),
  )
  return [follow, ...opts]
}
