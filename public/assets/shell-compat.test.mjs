import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('./shell.js', import.meta.url), 'utf8')

test('endpoint status never invents a session count', () => {
  // apiproxy 端点没有会话数来源（gateway 老 /health 才有）：不得用 '?' 占位
  // 或 0 冒充，未知时整个省略（2026-09-11 修复「可达 · ? 个会话」）。
  assert.doesNotMatch(source, /sessions \?\? '\?'/)
  assert.doesNotMatch(source, /sessions \?\? 0/)
  assert.match(source, /typeof endpoint\.sessions === 'number'/)
  assert.match(source, /typeof ep\.sessions === 'number'/)
})
