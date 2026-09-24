// 债务 F1:chat-composer 纯函数测试——composer 层下沉前钉死可测面。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { useTestDictionary } from './test-i18n.mjs'

useTestDictionary('en')

const { modelKey, shortPath, accessOptions, sendPolicy } = await import('./chat-composer.js')

test('债务 F1: modelKey 用 \\0 拼接 provider/model(与 loadModels 的 choices 键一致)', () => {
  assert.equal(modelKey({ provider: 'deepseek', model: 'v4' }), 'deepseek\u0000v4')
})

test('债务 F1: shortPath 长路径掐中段保首尾,短路径原样', () => {
  const short = 'C:\\ws\\a'
  assert.equal(shortPath(short), short)
  const long = 'C:\\Users\\Someone\\Documents\\Projects\\deepseek-workspace\\dsh-agent-manager\\public\\assets'
  const out = shortPath(long)
  assert.ok(out.length <= 53)
  assert.ok(out.startsWith('C:\\Users\\Someon'), '盘符开头保留')
  assert.ok(out.endsWith('assets'), '尾部工作区名保留')
  assert.ok(out.includes('…'))
})

test('债务 F1: accessOptions 第三档随 fullAccess 解锁状态变化', () => {
  const unlocked = accessOptions({ fullAccess: true })
  assert.equal(unlocked.length, 3)
  assert.deepEqual(unlocked[2], { value: 'danger-full-access', label: 'full access', danger: true })
  const locked = accessOptions({ fullAccess: false })
  assert.equal(locked.length, 3)
  assert.deepEqual(locked[2], { value: 'danger-full-access', label: 'full access · node has not unlocked it', danger: true, locked: true })
})

test('债务 F1: sendPolicy 空文本/发送中/无状态一律不发', () => {
  assert.deepEqual(sendPolicy({ text: '', sending: false, state: {} }), { kind: 'empty' })
  assert.deepEqual(sendPolicy({ text: 'x', sending: true, state: {} }), { kind: 'busy' })
  assert.deepEqual(sendPolicy({ text: 'x', sending: false, state: null }), { kind: 'no_state' })
  assert.equal(sendPolicy({ text: '  x  ', sending: false, state: {} }).kind, 'ok')
})

test('债务 F1: sendPolicy 截取 trim 后的文本', () => {
  const result = sendPolicy({ text: '  你好  ', sending: false, state: {} })
  assert.deepEqual(result, { kind: 'ok', text: '你好' })
})
