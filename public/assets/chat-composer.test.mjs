// Debt F1: chat-composer pure-function tests -- pin the testable surface before the composer layer is split out.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { useTestDictionary } from './test-i18n.mjs'

useTestDictionary('en')

const { modelKey, shortPath, accessOptions, sendPolicy } = await import('./chat-composer.js')

test('debt F1: modelKey joins provider/model with \\0 (the same key spelling as the choices in loadModels)', () => {
  assert.equal(modelKey({ provider: 'deepseek', model: 'v4' }), 'deepseek\u0000v4')
})

test('debt F1: shortPath cuts the middle of a long path but keeps both ends; short paths pass through unchanged', () => {
  const short = 'C:\\ws\\a'
  assert.equal(shortPath(short), short)
  const long = 'C:\\Users\\Someone\\Documents\\Projects\\deepseek-workspace\\dsh-agent-manager\\public\\assets'
  const out = shortPath(long)
  assert.ok(out.length <= 53)
  assert.ok(out.startsWith('C:\\Users\\Someon'), 'the drive prefix is kept')
  assert.ok(out.endsWith('assets'), 'the trailing workspace name is kept')
  assert.ok(out.includes('…'))
})

test('debt F1: the third accessOptions tier follows the fullAccess unlock state', () => {
  const unlocked = accessOptions({ fullAccess: true })
  assert.equal(unlocked.length, 3)
  assert.deepEqual(unlocked[2], { value: 'danger-full-access', label: 'full access', danger: true })
  const locked = accessOptions({ fullAccess: false })
  assert.equal(locked.length, 3)
  assert.deepEqual(locked[2], { value: 'danger-full-access', label: 'full access · node has not unlocked it', danger: true, locked: true })
})

test('debt F1: sendPolicy refuses empty text, an in-flight send and a missing state', () => {
  assert.deepEqual(sendPolicy({ text: '', sending: false, state: {} }), { kind: 'empty' })
  assert.deepEqual(sendPolicy({ text: 'x', sending: true, state: {} }), { kind: 'busy' })
  assert.deepEqual(sendPolicy({ text: 'x', sending: false, state: null }), { kind: 'no_state' })
  assert.equal(sendPolicy({ text: '  x  ', sending: false, state: {} }).kind, 'ok')
})

test('debt F1: sendPolicy returns the trimmed text', () => {
  const result = sendPolicy({ text: '  hello  ', sending: false, state: {} })
  assert.deepEqual(result, { kind: 'ok', text: 'hello' })
})
