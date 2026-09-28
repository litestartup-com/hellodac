import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('./shell.js', import.meta.url), 'utf8')

test('endpoint status never invents a session count', () => {
  // An apiproxy endpoint has no source for a session count (only the legacy gateway /health reports one): it
  // must not be faked with a '?' placeholder or a 0, so an unknown count is omitted entirely (fixed 2026-09-11:
  // "reachable · ? sessions").
  assert.doesNotMatch(source, /sessions \?\? '\?'/)
  assert.doesNotMatch(source, /sessions \?\? 0/)
  assert.match(source, /typeof endpoint\.sessions === 'number'/)
  assert.match(source, /typeof ep\.sessions === 'number'/)
})
