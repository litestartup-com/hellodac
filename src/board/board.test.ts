import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { LIMITS, parseBlock } from './model.js'
import { BOARD_DIR, readBoard } from './store.js'

const makeWorkspace = (files: Record<string, unknown | string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'board-'))
  mkdirSync(join(root, BOARD_DIR), { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(
      join(root, BOARD_DIR, name),
      typeof content === 'string' ? content : JSON.stringify(content, null, 2),
      'utf8',
    )
  }
  return root
}

const page = (label: string, blocks: unknown[], extra: Record<string, unknown> = {}) => ({
  label,
  blocks,
  ...extra,
})

// ---------------------------------------------------------------------------
// blocks
// ---------------------------------------------------------------------------

test('accepts every block type in the catalogue', () => {
  const samples: unknown[] = [
    { type: 'kpi', items: [{ label: '收入', value: '¥1,200', tone: 'good' }] },
    { type: 'metrics', items: [{ name: '体重', value: '71.5kg', target: '72.5kg' }] },
    { type: 'list', items: [{ text: '写周报', note: '周五前', tag: 'P0' }] },
    { type: 'table', columns: ['日期', '金额'], rows: [['08-30', '38']] },
    { type: 'progress', items: [{ label: '餐饮', value: 380, max: 1000 }] },
    { type: 'bars', items: [{ label: 'W33', value: -2.4 }] },
    { type: 'pie', items: [{ label: '现金', value: 38.7 }] },
    { type: 'checklist', items: [{ text: '早睡', done: true }] },
    { type: 'quote', items: [{ text: '知行合一', source: '王阳明' }] },
    { type: 'groups', groups: [{ label: '创业', items: ['重新理解创业'] }] },
    { type: 'note', text: '这是一段说明', tone: 'info' },
  ]

  for (const sample of samples) {
    const { block, problem } = parseBlock(sample)
    assert.equal(problem, null, `${(sample as { type: string }).type} should be valid`)
    assert.equal(block.type, (sample as { type: string }).type)
  }
})

test('an unknown block type becomes a visible placeholder, not a silent drop', () => {
  // A card that quietly disappears is the worst failure: the board looks fine
  // and the number you came for is simply absent.
  const { block, problem } = parseBlock({ type: 'sparkline', title: '趋势', items: [] })

  assert.equal(block.type, 'unsupported')
  assert.equal(block.title, '趋势', 'the title survives so you can tell which card broke')
  assert.match(problem ?? '', /sparkline/)
  assert.match(problem ?? '', /kpi/, 'the message lists what manager does understand')
})

test('a malformed block of a known type says where it went wrong', () => {
  // The most likely mistake a model makes: a number written as a string.
  const { block, problem } = parseBlock({ type: 'progress', items: [{ label: '餐饮', value: '380', max: 1000 }] })

  assert.equal(block.type, 'unsupported')
  assert.match(problem ?? '', /progress/)
  assert.match(problem ?? '', /items\.0\.value/)
})

test('a block with no type at all is handled', () => {
  const { block, problem } = parseBlock({ title: '忘了写 type' })
  assert.equal(block.type, 'unsupported')
  assert.match(problem ?? '', /no "type"/)
})

test('blocks that are not objects do not throw', () => {
  for (const raw of [null, undefined, 'kpi', 42, []]) {
    const { block } = parseBlock(raw)
    assert.equal(block.type, 'unsupported', `${JSON.stringify(raw)} must degrade, not crash`)
  }
})

test('oversized content is rejected rather than shipped to the browser', () => {
  // The data is written by a language model; a runaway generation should not
  // become a megabyte response or a hung page.
  const huge = { type: 'note', text: 'x'.repeat(LIMITS.MAX_TEXT + 1) }
  assert.equal(parseBlock(huge).block.type, 'unsupported')

  const tooMany = {
    type: 'list',
    items: Array.from({ length: LIMITS.MAX_ITEMS + 1 }, () => ({ text: 'x' })),
  }
  assert.equal(parseBlock(tooMany).block.type, 'unsupported')
})

test('table cells accept numbers and booleans, and stringify them', () => {
  // Writing an amount as a number is the most natural mistake an agent makes,
  // and it used to turn the entire table into an error card.
  const { block, problem } = parseBlock({
    type: 'table',
    columns: ['日期', '金额', '已核对'],
    rows: [['08-30', 38, true], ['08-31', 12.5, false]],
  })

  assert.equal(problem, null)
  assert.equal(block.type, 'table')
  assert.deepEqual((block as { rows: string[][] }).rows, [
    ['08-30', '38', 'true'],
    ['08-31', '12.5', 'false'],
  ])
})

test('a null table cell becomes an empty string, not the text "null"', () => {
  const { block } = parseBlock({ type: 'table', columns: ['a', 'b'], rows: [['x', null]] })
  assert.deepEqual((block as { rows: string[][] }).rows, [['x', '']])
})

test('objects in a table cell are still rejected', () => {
  // Stringifying an object would print "[object Object]" onto the board, which
  // looks like data but is not.
  const { block } = parseBlock({ type: 'table', columns: ['a'], rows: [[{ nested: 1 }]] })
  assert.equal(block.type, 'unsupported')
})

test('checklist done defaults to false when omitted', () => {
  const { block } = parseBlock({ type: 'checklist', items: [{ text: '冥想' }] })
  assert.equal(block.type, 'checklist')
  assert.equal((block as { items: { done: boolean }[] }).items[0]?.done, false)
})

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

test('reads meta and pages, ordering by order then filename', () => {
  const root = makeWorkspace({
    'meta.json': { title: '个人大盘', asOf: '2026-08-30' },
    'zebra.json': page('最后', [], { order: 9 }),
    'alpha.json': page('第一', [], { order: 1 }),
    'money.json': page('记账', [], { order: 5 }),
  })

  const board = readBoard(root, '兜底标题')

  assert.equal(board.title, '个人大盘')
  assert.equal(board.asOf, '2026-08-30')
  assert.deepEqual(
    board.pages.map((p) => p.label),
    ['第一', '记账', '最后'],
  )
})

test('pages without an explicit order come last, sorted by filename', () => {
  const root = makeWorkspace({
    'b.json': page('B', []),
    'a.json': page('A', []),
    'first.json': page('First', [], { order: 1 }),
  })

  assert.deepEqual(
    readBoard(root, 't').pages.map((p) => p.label),
    ['First', 'A', 'B'],
  )
})

test('the page key defaults to the filename, so an agent need not repeat it', () => {
  const root = makeWorkspace({ 'health.json': page('健康', []) })
  assert.equal(readBoard(root, 't').pages[0]?.key, 'health')
})

test('meta.json is configuration, not a page', () => {
  const root = makeWorkspace({ 'meta.json': { title: 'T' }, 'overview.json': page('总览', []) })
  const board = readBoard(root, 't')
  assert.equal(board.pages.length, 1)
  assert.equal(board.pages[0]?.key, 'overview')
})

test('an uninitialised workspace reads as empty, not as an error', () => {
  const root = mkdtempSync(join(tmpdir(), 'board-bare-'))
  const board = readBoard(root, '兜底标题')

  assert.equal(board.title, '兜底标题')
  assert.deepEqual(board.pages, [])
  assert.deepEqual(board.problems, [])
})

test('a broken page is reported and the others still load', () => {
  // Half-written JSON is the expected consequence of an interrupted agent turn.
  const root = makeWorkspace({
    'good.json': page('好的', [{ type: 'note', text: '正常' }], { order: 1 }),
    'broken.json': '{ "label": "坏的", "blocks": [',
  })

  const board = readBoard(root, 't')

  assert.equal(board.pages.length, 1, 'one bad file must not cost the whole board')
  assert.equal(board.pages[0]?.label, '好的')
  assert.equal(board.problems.length, 1)
  assert.equal(board.problems[0]?.file, `${BOARD_DIR}/broken.json`)
  assert.match(board.problems[0]?.detail ?? '', /not valid JSON/)
})

test('a bad block is reported and the surrounding blocks survive', () => {
  const root = makeWorkspace({
    'overview.json': page('总览', [
      { type: 'note', text: '前面' },
      { type: 'nonsense' },
      { type: 'note', text: '后面' },
    ]),
  })

  const board = readBoard(root, 't')
  const blocks = board.pages[0]?.blocks ?? []

  assert.equal(blocks.length, 3, 'the placeholder keeps its position')
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['note', 'unsupported', 'note'],
  )
  assert.equal(board.problems.length, 1)
  assert.match(board.problems[0]?.detail ?? '', /block 1/)
})

test('a corrupt meta.json does not cost the pages', () => {
  const root = makeWorkspace({ 'meta.json': '{oops', 'overview.json': page('总览', []) })
  const board = readBoard(root, '兜底标题')

  assert.equal(board.title, '兜底标题', 'falls back rather than failing')
  assert.equal(board.pages.length, 1)
  assert.equal(board.problems.length, 1)
})

test('a page missing its label is rejected with a reason', () => {
  const root = makeWorkspace({ 'overview.json': { blocks: [] } })
  const board = readBoard(root, 't')

  assert.equal(board.pages.length, 0)
  assert.match(board.problems[0]?.detail ?? '', /label/)
})

test('non-json files in board/ are ignored', () => {
  // Agents leave notes and editors leave backups; neither is a page.
  const root = makeWorkspace({ 'overview.json': page('总览', []), 'README.md': '# 说明', 'notes.txt': 'x' })
  assert.equal(readBoard(root, 't').pages.length, 1)
  assert.equal(readBoard(root, 't').problems.length, 0)
})

test('more pages than the cap are refused instead of rendered', () => {
  const files: Record<string, unknown> = {}
  for (let i = 0; i < LIMITS.MAX_PAGES + 3; i += 1) {
    files[`p${String(i).padStart(3, '0')}.json`] = page(`P${i}`, [])
  }
  const board = readBoard(makeWorkspace(files), 't')

  assert.equal(board.pages.length, LIMITS.MAX_PAGES)
  assert.equal(board.problems.length, 3)
})
