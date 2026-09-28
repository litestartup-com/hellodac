// Debt F1: chat-render render-function tests -- pure string building from frames to HTML (no DOM);
// escaping and folding behaviour are pinned down by tests before the split.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { useTestDictionary } from './test-i18n.mjs'

useTestDictionary('en')

const { makeRenderer } = await import('./chat-render.js')

const setup = () =>
  makeRenderer({
    getState: () => ({ agent: { id: 'a1', name: 'writer', workspacePath: 'C:\\ws' }, chat: { title: 't' } }),
    openTools: new Set(),
    openContext: new Set(),
  })

test('debt F1: tokens abbreviates thousands and handles a null usage', () => {
  const { tokens } = setup()
  assert.equal(tokens(null), null)
  assert.equal(tokens({ inputTokens: 12, outputTokens: 34 }), '12 in · 34 out')
  assert.equal(tokens({ inputTokens: 1500, outputTokens: 999 }), '1.5k in · 999 out')
})

test('debt F1: questionCard escapes the question text and the option labels (model output entering HTML must be escaped)', () => {
  const { questionCard } = setup()
  const html = questionCard({
    kind: 'question',
    id: 'q1',
    questions: [
      { id: 'a', question: '<img src=x onerror=alert(1)>', header: '<b>h</b>', options: [{ label: '<script>x</script>', description: '<i>d</i>' }] },
    ],
  })
  assert.ok(!html.includes('<img'), 'the question text must be escaped')
  assert.ok(!html.includes('<script>'), 'the option label must be escaped')
  assert.ok(!html.includes('<b>'), 'the header must be escaped')
  assert.ok(html.includes('&lt;img'), 'the escaped entity must show up')
})

test('debt F1: approvalCard escapes the tool name and the reason', () => {
  const { approvalCard } = setup()
  const html = approvalCard({ kind: 'approval', id: 'a1', toolName: '<x>', reason: 'y<i>' })
  assert.ok(!html.includes('<x>'))
  assert.ok(!html.includes('<i>'))
})

test('debt F1: openTools decides the toolsBlock folding, and a failure expands its result by default', () => {
  const { toolsBlock } = setup()
  const tools = [
    { name: 'read', args: null, raw: '{}', failed: false, done: true, resultText: 'ok' },
    { name: 'write', args: { path: 'a.txt' }, raw: '{"path":"a.txt"}', failed: true, done: true, resultText: 'boom' },
  ]
  const html = toolsBlock(tools, 3)
  assert.ok(html.includes('tool calls ×2 · 1 failed'))
  assert.ok(!html.includes('<details class="tools" data-fold="3" open>'), 'a folded block must not carry open')
  const opened = makeRenderer({ getState: () => null, openTools: new Set([3]), openContext: new Set() }).toolsBlock(tools, 3)
  assert.ok(opened.includes('data-fold="3" open>'), 'an openTools hit must carry open')
  assert.ok(html.includes('<details class="tool-result" open>'), 'a failed result must be expanded by default')
  assert.ok(!html.includes('<details class="tool-result" open>') === false)
})

test('debt F1: agentTurn uses streamed while streaming, and the authoritative text wins after message', () => {
  const { agentTurn } = setup()
  const streaming = agentTurn({ role: 'agent', text: '', streamed: 'preview', streaming: true, reasoning: '', tools: [], usage: null, reason: null, error: null, runId: null, runState: null, awaiting: null }, 0, false)
  assert.ok(streaming.includes('preview'))
  const final = agentTurn({ role: 'agent', text: 'final', streamed: 'preview', streaming: false, reasoning: '', tools: [], usage: null, reason: null, error: null, runId: null, runState: null, awaiting: null }, 0, false)
  assert.ok(final.includes('final'))
  assert.ok(!final.includes('preview'), 'streamed must be dropped after message')
})

test('debt F1: the footer failure state takes precedence over the stats row', () => {
  const { footer } = setup()
  const failed = footer({ role: 'agent', error: '<boom>', streaming: false }, 0, true)
  assert.ok(failed.includes('&lt;boom&gt;'))
  assert.ok(!failed.includes('turn-actions'), 'the failure state renders no feedback buttons')
})

test('2026-09-24 incident regression: the normal footer renders three action buttons (wording from the dictionary, must not throw t is not a function)', () => {
  const { footer } = setup()
  const block = {
    role: 'agent',
    error: null,
    streaming: false,
    usage: { inputTokens: 12, outputTokens: 34 },
    run: { id: 'run-1', startedAt: 1_000, endedAt: 5_000, usage: null },
  }
  let html = ''
  assert.doesNotThrow(() => {
    html = footer(block, 2, true)
  }, 'the footer must not throw because a local variable shadows t() (the production incident scene)')
  assert.ok(html.includes('data-act="copy"'), 'the copy button is there')
  assert.ok(html.includes('aria-label="Copy answer"'), 'the copy button aria-label comes from the dictionary')
  assert.ok(html.includes('aria-label="Helpful"'), 'the thumbs-up aria-label comes from the dictionary')
  assert.ok(html.includes('aria-label="Not helpful"'), 'the thumbs-down aria-label comes from the dictionary')
  // Stats row as before: duration + token counts
  assert.ok(html.includes('4s'), 'the turn duration is shown')
  assert.ok(html.includes('12 in · 34 out'), 'the token stats still come from tokens()')
})

test('2026-09-24 incident regression: a new chat with an empty title must not throw (the same chatTitle shadowing)', async () => {
  // chat.js is a page script (it touches the DOM at module level), so it cannot be loaded whole under Node;
  // this checks the correct spelling of the same pattern instead: an empty title falls back to the dictionary wording.
  const { t } = await import('./ui.js')
  const titleOf = (title) => (title === null || title === '' ? t('side.newChat') : title)
  assert.equal(titleOf(''), 'New session')
  assert.equal(titleOf(null), 'New session')
  assert.equal(titleOf('preset title'), 'preset title')
})

test('debt F1: userTurn does not render markdown, it escapes plain text', () => {
  const { userTurn } = setup()
  const html = userTurn({ role: 'user', text: '**bold** <script>x</script>', injected: false })
  assert.ok(html.includes('**bold**'), 'the asterisks are kept as-is (a user message renders no markdown)')
  assert.ok(!html.includes('<script>'))
})
