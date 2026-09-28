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

test('send/stop share one slot and queued send is wired (option C)', () => {
  // One slot toggles: while busy only the stop square shows (the implementation moved to chat-composer.js).
  assert.match(page, /class="composer-slot"/)
  assert.match(composer, /const busy = refs\.sending\.value \|\| turnRunning/)
  assert.match(composer, /el\.send\.hidden = busy/)
  assert.match(composer, /el\.stop\.hidden = !busy/)
  // The queued-send ghost arrow button: it appears only while a turn runs and the input is not empty.
  assert.match(page, /id="chat-queue"/)
  assert.match(source, /el\.queue\.addEventListener\('click', \(\) => void send\(\)\)/)
})

test('Ongoing Goal bar: the host goal projection renders (display only, hidden when complete)', () => {
  assert.match(page, /id="goal-bar"/)
  assert.match(source, /const renderGoalBar = \(\) => \{/)
  assert.match(source, /chat\.goal\.active/)
  assert.match(source, /chat\.goal\.paused/)
  assert.match(source, /chat\.goal\.blocked/)
  assert.match(source, /goal\.phase === 'complete'/)
})
