import assert from 'node:assert/strict'
import test from 'node:test'
import { useTestDictionary } from './test-i18n.mjs'

useTestDictionary('en')

const { classifyTool, toolBody, toolFilePath, toolSummary, toolTitle } = await import('./tool-cards.js')

// Tool-card derivation tests. The rules are DSH web's own (ui-tool
// GenericToolCard, 0.1.2-rc.1): these tests pin the ported tables so an
// upstream change of tool naming is a visible, deliberate diff.

test('classifies DSH tool names into variants', () => {
  assert.equal(classifyTool('bash'), 'bash')
  assert.equal(classifyTool('pwsh'), 'bash')
  assert.equal(classifyTool('read'), 'read')
  assert.equal(classifyTool('web_fetch'), 'read')
  assert.equal(classifyTool('web_search'), 'search')
  assert.equal(classifyTool('grep'), 'search')
  assert.equal(classifyTool('glob'), 'search')
  assert.equal(classifyTool('write'), 'write')
  assert.equal(classifyTool('edit'), 'edit')
  assert.equal(classifyTool('run_code'), 'code')
  assert.equal(classifyTool('cordis_package_inspect'), 'read')
  assert.equal(classifyTool('cordis_run'), 'others')
  assert.equal(classifyTool('something_new'), 'others', 'unknown tools land on the generic row')
})

test('titles: tool-owned overrides win over variant titles', () => {
  assert.equal(toolTitle('pwsh'), 'Pwsh')
  assert.equal(toolTitle('cordis_run'), 'Run Cordis Plugin')
  assert.equal(toolTitle('bash'), 'terminal')
  assert.equal(toolTitle('write'), 'write')
  assert.equal(toolTitle('unknown_tool'), 'tool call')
})

test('summary picks the variant key (DSH SUMMARY_KEYS) and truncates to one line', () => {
  assert.equal(toolSummary('bash', '{"command":"ls -la","description":"list"}'), 'list')
  assert.equal(toolSummary('bash', '{"command":"ls -la"}'), 'ls -la')
  assert.equal(toolSummary('read', '{"path":"/a/b.txt"}'), '/a/b.txt')
  assert.equal(toolSummary('web_search', '{"queries":["q1","q2"]}'), 'q1, q2')
  assert.equal(toolSummary('write', '{"file_path":"x.md"}'), 'x.md')
  // Unparseable arguments fall back to the raw first line; empty args stay empty.
  assert.equal(toolSummary('bash', 'not json\nmore'), 'not json')
  assert.equal(toolSummary('bash', ''), '')
})

test('file path derivation only for read/write/edit variants', () => {
  assert.equal(toolFilePath('write', '{"path":"C:/a/b.txt"}'), 'C:/a/b.txt')
  assert.equal(toolFilePath('read', '{"file_path":"/x"}'), '/x')
  assert.equal(toolFilePath('edit', '{"path":"y.md"}'), 'y.md')
  assert.equal(toolFilePath('bash', '{"command":"x"}'), null)
  assert.equal(toolFilePath('run_code', '{"code":"1"}'), null)
})

test('body: code text for run_code, pretty JSON otherwise, null when empty', () => {
  assert.equal(toolBody('run_code', '{"code":"console.log(1)"}'), 'console.log(1)')
  const json = toolBody('bash', '{"command":"echo hi","description":"d"}')
  assert.match(json, /"command": "echo hi"/)
  assert.equal(toolBody('unknown_tool', 'not json'), 'not json')
  assert.equal(toolBody('bash', ''), null)
})
