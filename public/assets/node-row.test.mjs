import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nodeRow, nodeMenuHtml, nodeMenuId, nodeVersionMenuId, nodeVersionText, nodeStateLabel } from './node-row.js'
import { placePanel, placeSubmenu, menuPanelHtml, menuItemHtml, triggerButtonHtml } from './menu.js'

import { useTestDictionary, testDictionary } from './test-i18n.mjs'

useTestDictionary('en')
const DICT = testDictionary('en')

/**
 * UI 精简（DAC v1.0.0）回归：节点行只留「哪个节点活着、跑的什么」，其余进 ⋮ 菜单。
 *
 * 改前实测：单行横向 4 个区块（标题+2 告警 pill / meta / detail+常驻版本下拉 /
 * 最多 5 个操作按钮），外加一张固定 330px 的原生 GUI 卡（含整条 SSH 隧道命令）。
 * 这些断言就是把「不该常显的东西」钉住——否则下次重构很容易又摊回行里。
 */

const NODE = {
  id: 'ops33',
  state: 'live',
  managed: true,
  agents: ['personal', 'brain'],
  host: 'agent-abc123',
  dshVersion: '0.1.5-rc.2',
  dshCompatible: true,
  image: null,
  pid: 4242,
  lastError: null,
  configuredDshVersion: null,
}
const VERSIONS = [
  { dsh: '0.1.5-rc.2', status: 'verified' },
  { dsh: '0.1.2-rc.1', status: 'pending' },
]

const hostName = (h) => (h === 'agent-abc123' ? 'ubuntu-focal' : h)

test('UI 精简: 节点行只常显状态/ID/归属/版本 + 一个 ⋮ 触发器', () => {
  const html = nodeRow(NODE, hostName)
  assert.ok(html.includes('ops33'), '节点 ID 在')
  assert.ok(html.includes('live'), '状态在')
  assert.ok(html.includes('personal / brain'), 'agent 归属在')
  assert.ok(html.includes('ubuntu-focal'), '主机名在（跨机场景的关键信息）')
  assert.ok(html.includes('DSH 0.1.5-rc.2'), '当前版本在')
  assert.ok(html.includes('menu-trigger'), '有 ⋮ 触发器')
  assert.ok(html.includes(`aria-controls="${nodeMenuId('ops33')}"`), '触发器声明它控制哪个浮层')
})

test('UI 精简: 操作按钮、版本下拉、GUI 卡一律不再常显在行里', () => {
  const html = nodeRow(NODE, hostName)
  // 这些原来都是行内常显元素——现在必须在菜单里，不能回到行里。
  assert.ok(!html.includes('data-node-down'), '停止按钮不在行里')
  assert.ok(!html.includes('data-node-restart'), '重启按钮不在行里')
  assert.ok(!html.includes('data-node-logs'), '日志按钮不在行里')
  assert.ok(!html.includes('data-node-rm'), '删除按钮不在行里')
  assert.ok(!html.includes('<select'), '版本下拉不在行里')
  assert.ok(!html.includes('ssh -N'), '隧道命令不在行里')
  assert.ok(!html.includes('node-gui'), 'GUI 卡不在行里')
  assert.ok(!html.includes('node-actions'), '操作条不在行里')
})

test('UI 精简: 告警仍常显（异常必须一眼看到，不能藏进菜单）', () => {
  const drift = nodeRow({ ...NODE, dshDrift: true }, hostName)
  assert.ok(drift.includes('pill-mini warn'), '漂移告警常显')
  const mismatch = nodeRow({ ...NODE, dshCompatible: false }, hostName)
  assert.ok(mismatch.includes('pill-mini warn'), '版本不匹配告警常显')
})

test('UI 精简: 错误压成一行并可悬停看全文（可见但不撑高整行）', () => {
  const long = 'E'.repeat(400)
  const html = nodeRow({ ...NODE, lastError: long }, hostName)
  assert.ok(html.includes('node-err'), '错误有独立样式')
  assert.ok(html.includes(`title="${long}"`), '全文走 tooltip')
  assert.ok(!html.includes('<select'), '不因错误又多出控件')
})

test('UI 精简: 生命周期项随状态切换——冷/离线给启动，运行中给停止+重启', () => {
  const cold = nodeMenuHtml({ ...NODE, state: 'cold' }, VERSIONS)
  assert.ok(cold.includes('data-node-up="ops33"'), '冷态给启动')
  assert.ok(!cold.includes('data-node-down'), '冷态不给停止')

  const live = nodeMenuHtml(NODE, VERSIONS)
  assert.ok(live.includes('data-node-down="ops33"'), '运行中给停止')
  assert.ok(live.includes('data-node-restart="ops33"'), '运行中给重启')
  assert.ok(!live.includes('data-node-up'), '运行中不给启动')
})

test('UI 精简: 对齐只在真漂移时出现；删除恒带危险样式', () => {
  const noDrift = nodeMenuHtml(NODE, VERSIONS)
  assert.ok(!noDrift.includes('data-node-align'), '不漂移就没有对齐项')
  const drift = nodeMenuHtml({ ...NODE, dshDrift: true }, VERSIONS)
  assert.ok(drift.includes('data-node-align="ops33"'), '漂移时给对齐')
  assert.ok(drift.includes('menu-item danger'), '删除是危险项（红字）')
})

test('UI 精简: 版本子菜单与旧下拉同源，标出当前项并含「跟随默认」', () => {
  const html = nodeMenuHtml({ ...NODE, configuredDshVersion: '0.1.2-rc.1' }, VERSIONS)
  assert.ok(html.includes(`id="${nodeVersionMenuId('ops33')}"`), '版本子菜单面板在')
  assert.ok(html.includes('data-node-version-set=""'), '有「跟随默认」项')
  assert.ok(html.includes('data-node-version-set="0.1.5-rc.2"'), '矩阵里的版本都在')
  assert.ok(html.includes('(unverified)'), 'pending 版本带未验证标注（与下拉同文案）')
  // 当前钉在 0.1.2-rc.1 → 那一项带 ✓
  const checked = html.split('data-node-version-set="0.1.2-rc.1"')[1] ?? ''
  assert.ok(checked.includes('✓'), '当前版本带勾选标记')
})

test('UI 精简: 未接线的 manager（无 agentCommand 等）也要给出 ⋮ 菜单不报错', () => {
  const html = nodeMenuHtml({ ...NODE, state: 'starting' }, [])
  assert.ok(html.includes('menu-panel'), '面板仍渲染')
  assert.ok(html.includes('disabled'), 'starting 时生命周期项禁用')
})

test('UI 精简: 外管节点不给生命周期操作，只给日志与原生访问', () => {
  const html = nodeMenuHtml({ ...NODE, managed: false }, VERSIONS)
  assert.ok(!html.includes('data-node-down'), '外管不给停止')
  assert.ok(!html.includes('data-node-version-menu'), '外管不给版本切换')
  assert.ok(!html.includes('data-node-rm'), '外管不给删除')
  assert.ok(html.includes('data-node-logs="ops33"'), '外管仍有日志')
  assert.ok(html.includes('data-node-access="ops33"'), '外管仍有原生访问')
})

test('UI 精简: 行里始终给「原生访问」入口（GUI 命令的落脚点）', () => {
  const html = nodeMenuHtml(NODE, VERSIONS)
  assert.ok(html.includes('data-node-access="ops33"'), '菜单里有原生访问项')
})

test('UI 精简: 版本文案——容器优先镜像 tag，其次 DSH 版本，都没有则 null', () => {
  assert.equal(nodeVersionText({ image: 'hellodac/dac-node:0.1.5-rc.2', dshVersion: '0.1.5-rc.2' }), 'hellodac/dac-node:0.1.5-rc.2')
  assert.equal(nodeVersionText({ image: null, dshVersion: '0.1.5-rc.2' }), 'DSH 0.1.5-rc.2')
  assert.equal(nodeVersionText({ image: '', dshVersion: '' }), null)
})

test('UI 精简: 状态文案——live/offline 是协议裸词不翻译，其余走字典', () => {
  assert.equal(nodeStateLabel('live'), 'live')
  assert.equal(nodeStateLabel('offline'), 'offline')
  assert.equal(nodeStateLabel('cold'), DICT['nodes.state.cold'])
})

// ---- 浮层定位（纯函数）：越界钳制 ----

test('浮层定位: 右对齐优先，左边放不下改左对齐，右边越界再贴边', () => {
  const viewport = { w: 1000, h: 800 }
  const wide = { top: 100, right: 900, bottom: 120, left: 876 }
  assert.deepEqual(placePanel({ rect: wide, width: 200, height: 300, viewport }), { left: 700, top: 126, side: 'left' })

  // 靠近左边缘：右对齐会算出负数 → 改成左对齐
  const leftish = { top: 100, right: 120, bottom: 120, left: 96 }
  const placed = placePanel({ rect: leftish, width: 200, height: 300, viewport })
  assert.equal(placed.side, 'right')
  assert.equal(placed.left, 96)
})

test('浮层定位: 下方放不下且上方更宽裕时翻到触发器上方', () => {
  const viewport = { w: 1000, h: 400 }
  const nearBottom = { top: 300, right: 500, bottom: 320, left: 476 }
  const placed = placePanel({ rect: nearBottom, width: 200, height: 200, viewport })
  assert.ok(placed.top + 200 <= viewport.h, '不溢出视口下沿')
  assert.ok(placed.top < nearBottom.top, '翻到了上方')
})

test('浮层定位: 子菜单贴主菜单右侧；右侧放不下翻到左侧', () => {
  const viewport = { w: 1000, h: 800 }
  const item = { top: 200, right: 400, bottom: 226, left: 100 }
  assert.equal(placeSubmenu({ rect: item, width: 200, height: 120, viewport }).left, 406)

  const nearRight = { top: 200, right: 980, bottom: 226, left: 700 }
  const flipped = placeSubmenu({ rect: nearRight, width: 200, height: 120, viewport })
  assert.ok(flipped.left + 200 <= viewport.w, '翻到左侧后不越界')
  assert.ok(flipped.left < nearRight.left, '确实在左侧')
})

test('浮层定位: 子菜单在视口底部时上移，不溢出', () => {
  const viewport = { w: 1000, h: 300 }
  const item = { top: 280, right: 400, bottom: 300, left: 100 }
  const placed = placeSubmenu({ rect: item, width: 200, height: 200, viewport })
  assert.ok(placed.top + 200 <= viewport.h, '不溢出')
})

// ---- 菜单原语 ----

test('菜单原语: 分隔线/分组标题/说明行各司其职', () => {
  assert.ok(menuItemHtml({ kind: 'sep' }).includes('menu-sep'))
  assert.ok(menuItemHtml({ kind: 'group', label: 'G' }).includes('menu-group'))
  assert.ok(menuItemHtml({ kind: 'note', label: 'N' }).includes('menu-note'))
})

test('菜单原语: 子菜单项带 aria-haspopup 与 chevron，普通项没有', () => {
  const sub = menuItemHtml({ kind: 'submenu', label: 'Version' })
  assert.ok(sub.includes('aria-haspopup="true"'), '标出可展开')
  assert.ok(sub.includes('menu-chevron'), '有指向箭头')
  const plain = menuItemHtml({ label: 'Logs' })
  assert.ok(!plain.includes('aria-haspopup'), '普通项不标可展开')
})

test('菜单原语: 危险项带 danger 类；标签一律转义', () => {
  assert.ok(menuItemHtml({ kind: 'danger', label: 'Delete' }).includes('menu-item danger'))
  assert.ok(menuItemHtml({ label: '<img src=x>' }).includes('&lt;img'), '标签转义')
})

test('菜单原语: 触发器默认隐藏（hidden），不会先闪一下再定位', () => {
  assert.ok(menuPanelHtml({ id: 'p', label: 'L', items: [] }).includes('hidden'))
  assert.ok(!menuPanelHtml({ id: 'p', label: 'L', items: [], hidden: false }).includes('hidden'))
  assert.ok(triggerButtonHtml({ id: 't', label: 'More', controls: 'p' }).includes('aria-expanded="false"'))
})
