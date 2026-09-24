import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { useTestDictionary } from './test-i18n.mjs'

useTestDictionary('en')

const source = await readFile(new URL('./chat.js', import.meta.url), 'utf8')
const composer = await readFile(new URL('./chat-composer.js', import.meta.url), 'utf8')
const page = await readFile(new URL('../pages/chat.html', import.meta.url), 'utf8')

test('optional composer controls are guarded before event binding', () => {
  assert.match(source, /if \(el\.access !== null\) \{\n  registerDropdown\(el\.access,/)
  assert.match(source, /if \(el\.model !== null\) \{\n  registerDropdown\(el\.model,/)
  assert.match(source, /if \(el\.context !== null && el\.contextPopover !== null && el\.contextWrap !== null\)/)
  assert.match(source, /if \(el\.settings !== null && el\.identity !== null\)/)
})

test('send/stop share one slot and queue send is wired (方案 C)', () => {
  // 主槽叠放：同槽变身，busy 时只显示停止方块(实现已下沉 chat-composer.js)。
  assert.match(page, /class="composer-slot"/)
  assert.match(composer, /const busy = refs\.sending\.value \|\| turnRunning/)
  assert.match(composer, /el\.send\.hidden = busy/)
  assert.match(composer, /el\.stop\.hidden = !busy/)
  // 排队发送 ghost 箭头按钮：回合运行中输入非空才浮现。
  assert.match(page, /id="chat-queue"/)
  assert.match(source, /el\.queue\.addEventListener\('click', \(\) => void send\(\)\)/)
})

test('Ongoing Goal 条：宿主 goal 投影渲染（仅显示，complete 隐藏）', () => {
  assert.match(page, /id="goal-bar"/)
  assert.match(source, /const renderGoalBar = \(\) => \{/)
  assert.match(source, /chat\.goal\.active/)
  assert.match(source, /chat\.goal\.paused/)
  assert.match(source, /chat\.goal\.blocked/)
  assert.match(source, /goal\.phase === 'complete'/)
})
