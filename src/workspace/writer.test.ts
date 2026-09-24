import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { NOTE_DATA_DIR, readNoteData } from './notedata.js'
import { WriteRejected, appendMarkdown, applyWrites, resolveInside, writeNoteData, type ApplyOptions } from './writer.js'
import type { ValidateRules } from './validate.js'

/** 债务 E12:note-kaka 规则(外置后由调用方传入)。 */
const RULES: ValidateRules = {
  windows: [
    { path: 'trade.history', max: 8, archive: 'E03.10.01-交易大盘.md' },
    { path: 'weekly.weeks', max: 26, archive: 'G-日志/00-2026年周报' },
    { path: 'weekly.logs', max: 10, archive: 'G01.08-2026年/0X月份' },
  ],
  forbidAmountFields: true,
  acctFlowMaxAgeMonths: 1,
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const TRADE_JS = `// ============================================================
// Note Kaka 数据文件 · trade（交易快照）
// 治理：快照历史只渲染最近 8 条
// ============================================================
window.NOTE_DATA = window.NOTE_DATA || {};

window.NOTE_DATA.trade = {
  asOf: "2026-08-19",
  cash: 38.74,
  holdings: [
    { name:"光大证券", code:"601788", weight:30.33, cost:15.456, price:14.24 },
  ],
  history: [
    { d:"08-19", pos:60.9, cash:38.7, note:"起点" },
  ],
};
`

const ACCT_JS = `// acct
window.NOTE_DATA = window.NOTE_DATA || {};
window.NOTE_DATA.acct = { flow: [ { d:"--", c:"--", a:"--", n:"待录入" } ] };
`

/** A workspace that looks like note-kaka: a git repo with note-data files. */
const makeRepo = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'writer-'))
  mkdirSync(join(root, NOTE_DATA_DIR), { recursive: true })
  writeFileSync(join(root, NOTE_DATA_DIR, 'trade.js'), TRADE_JS, 'utf8')
  writeFileSync(join(root, NOTE_DATA_DIR, 'acct.js'), ACCT_JS, 'utf8')
  writeFileSync(join(root, 'RULE.md'), '# rules\n', 'utf8')
  git(root, 'init', '-q')
  git(root, 'config', 'user.email', 'test@local')
  git(root, 'config', 'user.name', 'test')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'initial')
  return root
}

const opts = { message: 'test write' }

test('rejects paths that escape the workspace', () => {
  const root = makeRepo()
  // 平台无关的逃逸：`../` 与 POSIX 绝对路径在 win32 / posix 下都判为绝对。
  // 注意 `resolveInside` 用平台原生 isAbsolute：`/etc/hosts` 在 win32 下
  // 同样 isAbsolute（驱动器根路径），两边都会拒绝。
  const alwaysRejected = ['../escape.md', '../../etc/hosts', 'a/../../escape.md', '/etc/hosts']
  // Windows 驱动器绝对路径只在 win32 上是绝对路径；在 posix 上它是工作区内
  // 合法相对路径（写成 <root>/C:/...），没有逃逸风险，应当放行——CI 在 Linux
  // 上跑，这里必须按平台断言，否则整条套件 Linux-only 红（蜂群2计划 P6 回归）。
  const winOnlyRejected = ['C:/Windows/System32/x.md', 'D:\\outside\\x.md']

  for (const bad of alwaysRejected) {
    assert.throws(() => resolveInside(root, bad), WriteRejected, `should reject ${bad}`)
  }
  for (const bad of winOnlyRejected) {
    if (process.platform === 'win32') {
      assert.throws(() => resolveInside(root, bad), WriteRejected, `should reject ${bad}`)
    } else {
      const resolved = resolveInside(root, bad)
      assert.ok(resolved.startsWith(root), `${bad} must stay inside the workspace on posix`)
    }
  }
})

test('refuses to write inside .git', () => {
  const root = makeRepo()
  assert.throws(() => resolveInside(root, '.git/config'), WriteRejected)
  assert.throws(() => resolveInside(root, '.git/hooks/pre-commit'), WriteRejected)
})

test('accepts ordinary paths inside the workspace', () => {
  const root = makeRepo()
  const resolved = resolveInside(root, join(NOTE_DATA_DIR, 'trade.js'))
  assert.ok(resolved.includes('trade.js'))
  assert.ok(resolveInside(root, 'G-日志/G03.01-工作日志.md').length > 0)
})

test('a successful note-data write lands and produces exactly one commit', async () => {
  const root = makeRepo()
  const before = git(root, 'rev-list', '--count', 'HEAD').trim()

  const { data } = readNoteData(root)
  const trade = { ...(data.trade as Record<string, unknown>), asOf: '2026-08-30' }
  const result = await writeNoteData(root, { trade }, { message: 'trade: weekly snapshot', originalRequest: '更新一下交易快照' })

  assert.ok(result.commit !== null, 'a commit was produced')
  assert.deepEqual(result.files, [`${NOTE_DATA_DIR.replace(/\\/g, '/')}/trade.js`])

  const after = git(root, 'rev-list', '--count', 'HEAD').trim()
  assert.equal(Number(after), Number(before) + 1, 'exactly one commit')

  const reread = readNoteData(root)
  assert.equal((reread.data.trade as Record<string, unknown>).asOf, '2026-08-30')
  // Untouched files must stay byte-identical.
  assert.equal(readFileSync(join(root, NOTE_DATA_DIR, 'acct.js'), 'utf8'), ACCT_JS)
  assert.equal(git(root, 'status', '--short').trim(), '', 'workspace is clean afterwards')
})

test('the commit message records the user’s original words', async () => {
  const root = makeRepo()
  const { data } = readNoteData(root)
  const trade = { ...(data.trade as Record<string, unknown>), cash: 40 }
  await writeNoteData(root, { trade }, { message: 'trade: adjust cash', originalRequest: '把现金调到40' })

  const body = git(root, 'log', '-1', '--pretty=%B')
  assert.ok(body.includes('trade: adjust cash'))
  assert.ok(body.includes('把现金调到40'), 'the original request is traceable')
})

test('rejects data that breaks a governance window, leaving the file untouched', async () => {
  const root = makeRepo()
  const original = readFileSync(join(root, NOTE_DATA_DIR, 'trade.js'), 'utf8')
  const { data } = readNoteData(root)
  const trade = {
    ...(data.trade as Record<string, unknown>),
    history: Array.from({ length: 9 }, (_, i) => ({ d: `08-1${i}`, pos: 60, note: 'x' })),
  }

  await assert.rejects(
    () => writeNoteData(root, { trade }, opts, RULES),
    (error: unknown) => {
      assert.ok(error instanceof WriteRejected)
      assert.ok(error.violations.some((v) => v.rule === 'governance-window'))
      return true
    },
  )

  assert.equal(readFileSync(join(root, NOTE_DATA_DIR, 'trade.js'), 'utf8'), original, 'file is byte-identical')
  assert.equal(git(root, 'status', '--short').trim(), '', 'nothing left dirty')
})

test('rejects trade data carrying amounts', async () => {
  const root = makeRepo()
  const original = readFileSync(join(root, NOTE_DATA_DIR, 'trade.js'), 'utf8')
  const { data } = readNoteData(root)
  const trade = {
    ...(data.trade as Record<string, unknown>),
    holdings: [{ name: '光大证券', weight: 30.33, amount: 120000 }],
  }

  await assert.rejects(() => writeNoteData(root, { trade }, opts, RULES), WriteRejected)
  assert.equal(readFileSync(join(root, NOTE_DATA_DIR, 'trade.js'), 'utf8'), original)
})

test('rejects a credential anywhere in the data', async () => {
  const root = makeRepo()
  const { data } = readNoteData(root)
  const trade = {
    ...(data.trade as Record<string, unknown>),
    holdings: [{ name: 'x', weight: 1, note: 'api_key=sk-abcdefghijklmnopqrstuvwxyz012345' }],
  }
  await assert.rejects(() => writeNoteData(root, { trade }, opts), WriteRejected)
})

test('refuses when the target file has uncommitted changes', async () => {
  const root = makeRepo()
  const target = join(root, NOTE_DATA_DIR, 'trade.js')
  writeFileSync(target, `${TRADE_JS}// my own uncommitted edit\n`, 'utf8')
  const mine = readFileSync(target, 'utf8')

  const { data } = readNoteData(root)
  const trade = { ...(data.trade as Record<string, unknown>), asOf: '2026-09-01' }

  await assert.rejects(
    () => writeNoteData(root, { trade }, opts),
    (error: unknown) => {
      assert.ok(error instanceof WriteRejected)
      assert.ok(error.reasons.join(' ').includes('trade.js'))
      return true
    },
  )
  assert.equal(readFileSync(target, 'utf8'), mine, 'my uncommitted edit survives untouched')
})

test('an unrelated dirty file does not block the write', async () => {
  const root = makeRepo()
  writeFileSync(join(root, 'RULE.md'), '# rules\nedited by hand\n', 'utf8')

  const { data } = readNoteData(root)
  const trade = { ...(data.trade as Record<string, unknown>), asOf: '2026-09-02' }
  const result = await writeNoteData(root, { trade }, opts)

  assert.ok(result.commit !== null)
  // The unrelated edit must neither be committed nor reverted.
  assert.ok(git(root, 'status', '--short').includes('RULE.md'))
  assert.ok(readFileSync(join(root, 'RULE.md'), 'utf8').includes('edited by hand'))
})

test('an unchanged write produces no commit', async () => {
  const root = makeRepo()
  const before = git(root, 'rev-list', '--count', 'HEAD').trim()
  const { data } = readNoteData(root)

  const result = await writeNoteData(root, { trade: data.trade }, opts)

  assert.equal(result.commit, null)
  assert.deepEqual(result.files, [])
  assert.equal(git(root, 'rev-list', '--count', 'HEAD').trim(), before, 'no empty commit')
})

test('an unchanged write leaves the file byte-identical', async () => {
  // The serializer normalises formatting, so a no-op write must be detected from
  // the data rather than the text -- otherwise the file would be reformatted and
  // committed every time a scheduled job found nothing to do.
  const root = makeRepo()
  const original = readFileSync(join(root, NOTE_DATA_DIR, 'trade.js'), 'utf8')
  const { data } = readNoteData(root)

  const result = await writeNoteData(root, { trade: data.trade }, opts)

  assert.equal(result.commit, null)
  assert.equal(readFileSync(join(root, NOTE_DATA_DIR, 'trade.js'), 'utf8'), original, 'not even reformatted')
  assert.equal(git(root, 'status', '--short').trim(), '')
})

test('rejects an unknown dataset name', async () => {
  const root = makeRepo()
  await assert.rejects(() => writeNoteData(root, { nonsense: {} }, opts), WriteRejected)
})

test('refuses to write to a directory that is not a git repository', async () => {
  const root = mkdtempSync(join(tmpdir(), 'writer-nogit-'))
  mkdirSync(join(root, NOTE_DATA_DIR), { recursive: true })
  writeFileSync(join(root, NOTE_DATA_DIR, 'trade.js'), TRADE_JS, 'utf8')

  await assert.rejects(
    () => writeNoteData(root, { trade: { asOf: 'x' } }, opts),
    (error: unknown) => {
      assert.ok(error instanceof WriteRejected)
      assert.ok(error.reasons.join(' ').includes('rolled back'))
      return true
    },
  )
})

test('appends to markdown and commits', async () => {
  const root = makeRepo()
  const result = await appendMarkdown(root, 'G-日志/工作日志.md', '- 2026-08-30 测试一行', {
    message: 'log: append entry',
    originalRequest: '记一笔',
  })

  assert.ok(result.commit !== null)
  const contents = readFileSync(join(root, 'G-日志/工作日志.md'), 'utf8')
  assert.equal(contents, '- 2026-08-30 测试一行\n')
  assert.ok(git(root, 'log', '-1', '--pretty=%B').includes('记一笔'))
})

test('appending twice keeps both lines and does not duplicate newlines', async () => {
  const root = makeRepo()
  await appendMarkdown(root, 'notes.md', 'first', opts)
  await appendMarkdown(root, 'notes.md', 'second', opts)
  assert.equal(readFileSync(join(root, 'notes.md'), 'utf8'), 'first\nsecond\n')
})

test('appendMarkdown refuses non-markdown targets', async () => {
  const root = makeRepo()
  await assert.rejects(() => appendMarkdown(root, 'config.json', '{}', opts), WriteRejected)
})

test('a write is atomic: no temp files are left behind', async () => {
  const root = makeRepo()
  const { data } = readNoteData(root)
  await writeNoteData(root, { trade: { ...(data.trade as Record<string, unknown>), asOf: '2026-09-03' } }, opts)

  const dir = join(root, NOTE_DATA_DIR)
  const leftovers = readFileSync(join(dir, 'trade.js'), 'utf8')
  assert.ok(leftovers.includes('2026-09-03'))
  assert.ok(!existsSync(join(dir, 'trade.js.tmp')))
  assert.equal(git(root, 'status', '--short').trim(), '')
})

test('applyWrites rejects an empty batch', async () => {
  const root = makeRepo()
  await assert.rejects(() => applyWrites(root, [], opts), WriteRejected)
})

test('债务 R7: applyWrites 落盘后二次校验必须按传入规则拒绝(不得退化为 DEFAULT_RULES)', async () => {
  const root = makeRepo()
  const overflowing =
    'window.NOTE_DATA = window.NOTE_DATA || {};\nwindow.NOTE_DATA.trade = { history: [' +
    Array.from({ length: 9 }, (_, i) => `{ d:"08-${String(i + 1).padStart(2, '0')}", pos:${i}, cash:1, note:"n" }`).join(', ') +
    '] };\n'
  // 变量形态携带额外 rules 字段(与 ApplyOptions 结构兼容),旧实现会忽略它
  // 改用 DEFAULT_RULES 回读校验 → 违规数据照样落盘 → 本测试红。
  const r7opts: ApplyOptions & { rules?: ValidateRules } = { message: 'r7', commit: false, rules: RULES }
  await assert.rejects(
    () => applyWrites(root, [{ relPath: `${NOTE_DATA_DIR}/trade.js`, contents: overflowing }], r7opts),
    (error: unknown) =>
      error instanceof WriteRejected && error.violations.some((v) => v.rule === 'governance-window'),
    '带治理规则的写,落盘内容违规必须按规则拒绝',
  )
})
