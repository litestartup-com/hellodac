import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  NOTE_DATA_DIR,
  keysForFile,
  readNoteData,
  readRawFile,
  serializeNoteDataFile,
  type NoteData,
} from './notedata.js'
import { validateNoteData, type ValidateRules } from './validate.js'

const makeWorkspace = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'notedata-'))
  const dir = join(root, NOTE_DATA_DIR)
  mkdirSync(dir, { recursive: true })
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(dir, name), contents, 'utf8')
  return root
}

const TRADE_JS = `// ============================================================
// Note Kaka 数据文件 · trade（交易快照，每周更新）
// 更新于 2026-08-18 · 由 note.html 通过 <script src> 加载
// 治理：快照历史只渲染最近 8 条
// 注意：仅记百分比、不记金额（隐私保护）
// ============================================================
window.NOTE_DATA = window.NOTE_DATA || {};

window.NOTE_DATA.trade = {
  asOf: "2026-08-19",
  ytd: 12.35, cum: 44.1, cash: 38.74,
  holdings: [
    { name:"光大证券", code:"601788", type:"个股", weight:30.33, cost:15.456, price:14.24, note:"超限(≤20%)，反弹减仓" },
    { name:"黄金ETF", code:"159937", type:"ETF", weight:2.5, cost:8.241, price:8.98, note:"压舱" },
  ],
  watch: [
    { name:"洛阳钼业", code:"603993", weight:null, price:18.82 },
  ],
  queue: [
    { name:"云南白药", code:"000538", target:"~9%", price:49.93, batches:["47附近 ~3pp","回调45-45.5 ~3pp"] },
  ],
  history: [
    { d:"08-19", pos:60.9, cash:38.7, top:"光大30.33", note:"西电加仓(违纪)" },
  ],
};
`

test('债务 E11 回归: readRawFile——文件不存在返回 null;存在但读不了必须显性抛出', () => {
  const dir = mkdtempSync(join(tmpdir(), 'notedata-raw-'))
  mkdirSync(join(dir, NOTE_DATA_DIR), { recursive: true })
  assert.equal(readRawFile(dir, 'core.js'), null, '不存在 = null(旧语义)')

  // 文件位置是目录:readFileSync 抛 EISDIR(非 ENOENT)——绝不能静默返回 null,
  // 否则 writer 会把它当「不存在」重建,覆盖掉无法读取的真实数据。
  mkdirSync(join(dir, NOTE_DATA_DIR, 'weekly.js'), { recursive: true })
  assert.throws(() => readRawFile(dir, 'weekly.js'), /reading .* failed|EISDIR/i, '读取失败必须显性抛出')
})

test('reads window.NOTE_DATA the way the browser accumulates it', () => {
  const root = makeWorkspace({
    'core.js': 'window.NOTE_DATA = window.NOTE_DATA || {};\nwindow.NOTE_DATA.meta = { asOf:"2026-08-18", week:34 };\n',
    'trade.js': TRADE_JS,
  })
  const { data, loaded, problems } = readNoteData(root)

  assert.deepEqual(loaded, ['core.js', 'trade.js'])
  // The three absent files are reported, not fatal -- note.html tolerates
  // missing data files the same way.
  assert.equal(problems.length, 3)
  assert.deepEqual(data.meta, { asOf: '2026-08-18', week: 34 })
  const trade = data.trade as Record<string, unknown>
  assert.equal(trade.asOf, '2026-08-19')
  assert.equal((trade.holdings as unknown[]).length, 2)
  assert.equal(((trade.watch as Record<string, unknown>[])[0] ?? {}).weight, null)
})

test('a broken data file does not lose the others', () => {
  const root = makeWorkspace({
    'core.js': 'window.NOTE_DATA = window.NOTE_DATA || {};\nwindow.NOTE_DATA.meta = { week:34 };\n',
    'trade.js': 'window.NOTE_DATA.trade = { oops: ;',
  })
  const { data, loaded, problems } = readNoteData(root)

  assert.deepEqual(loaded, ['core.js'])
  assert.deepEqual(data.meta, { week: 34 })
  assert.ok(problems.some((p) => p.file === 'trade.js' && p.reason.includes('evaluation failed')))
})

test('the sandbox denies access to require and process', () => {
  const root = makeWorkspace({
    'core.js': 'window.NOTE_DATA = window.NOTE_DATA || {};\nwindow.NOTE_DATA.meta = { leaked: typeof process, req: typeof require };\n',
  })
  const { data } = readNoteData(root)
  assert.deepEqual(data.meta, { leaked: 'undefined', req: 'undefined' })
})

test('round-trips: serialize then re-read yields an equivalent object', () => {
  const root = makeWorkspace({ 'trade.js': TRADE_JS })
  const first = readNoteData(root)

  const rewritten = serializeNoteDataFile({
    previous: TRADE_JS,
    keys: keysForFile('trade.js'),
    data: first.data,
  })
  writeFileSync(join(root, NOTE_DATA_DIR, 'trade.js'), rewritten, 'utf8')

  const second = readNoteData(root)
  assert.deepEqual(second.data.trade, first.data.trade)

  // Writing twice must be a no-op, otherwise every agent run would produce a
  // spurious commit.
  const third = serializeNoteDataFile({
    previous: rewritten,
    keys: keysForFile('trade.js'),
    data: second.data,
  })
  assert.equal(third, rewritten)
})

test('serializer preserves the header comment and keeps one record per line', () => {
  const root = makeWorkspace({ 'trade.js': TRADE_JS })
  const { data } = readNoteData(root)
  const out = serializeNoteDataFile({ previous: TRADE_JS, keys: keysForFile('trade.js'), data })

  assert.ok(out.startsWith('// ==='), 'header block is kept verbatim')
  assert.ok(out.includes('仅记百分比、不记金额'), 'the human-written governance note survives')
  assert.ok(out.includes('window.NOTE_DATA = window.NOTE_DATA || {};'))

  // One holding per line is what makes a single edit a single-line git diff.
  const holdingLines = out.split('\n').filter((line) => line.includes('"光大证券"'))
  assert.equal(holdingLines.length, 1)
  assert.ok((holdingLines[0] ?? '').includes('weight:30.33'))

  assert.ok(!out.includes('\uFEFF'), 'no BOM')
  assert.ok(out.endsWith('\n'))
})

test('unquoted keys are only used where they are valid identifiers', () => {
  const data: NoteData = { core: { ok: 1, 'needs-quotes': 2, '中文键': 3 } }
  const out = serializeNoteDataFile({ previous: null, keys: ['core'], data })
  assert.ok(out.includes('ok:1') || out.includes('ok: 1'))
  assert.ok(out.includes('"needs-quotes"'))
  assert.ok(out.includes('"中文键"'))
})

// 债务 E12:note-kaka 的业务规则已外置为 per-agent 配置(manager.config.yaml
// → agent.validate)。本测试文件里的规则断言显式传入同一套规则。
const NOTE_KAKA_RULES: ValidateRules = {
  windows: [
    { path: 'trade.history', max: 8, archive: 'E03.10.01-交易大盘（持仓·任务·快照）.md' },
    { path: 'weekly.weeks', max: 26, archive: 'G-日志/.../00-2026年周报/*.md' },
    { path: 'weekly.logs', max: 10, archive: 'G01.08-2026年/0X月份/' },
  ],
  forbidAmountFields: true,
  acctFlowMaxAgeMonths: 1,
}

test('债务 E12 回归: 无规则(新用户)不继承任何业务规则——窗口/金额/acct 全不拦', () => {
  const overflow = {
    trade: { history: Array.from({ length: 99 }, (_, i) => ({ d: `08-0${i}`, pos: 60 })) },
    acct: { flow: [{ d: '03-15', c: '旧账', a: 99 }] },
  }
  const violations = validateNoteData(overflow, { now: new Date(2026, 7, 30) })
  assert.equal(violations.filter((v) => v.rule === 'governance-window').length, 0, '窗口规则必须由配置显式开启')
  assert.equal(violations.filter((v) => v.rule === 'no-amounts').length, 0, '金额规则必须由配置显式开启')
})

test('governance windows are enforced against the documented caps', () => {
  const overflow = {
    trade: { history: Array.from({ length: 9 }, (_, i) => ({ d: `08-0${i}`, pos: 60 })) },
    weekly: { weeks: Array.from({ length: 27 }, (_, i) => ({ w: i, r: 50 })), logs: Array.from({ length: 11 }, () => ({ d: '08-01' })) },
  }
  const violations = validateNoteData(overflow, { rules: NOTE_KAKA_RULES })
  const paths = violations.filter((v) => v.rule === 'governance-window').map((v) => v.path)
  assert.ok(paths.includes('trade.history'))
  assert.ok(paths.includes('weekly.weeks'))
  assert.ok(paths.includes('weekly.logs'))
})

test('trade data may not carry amounts, only percentages', () => {
  const withMoney = { trade: { holdings: [{ name: '光大证券', weight: 30.33, amount: 120000 }] } }
  const violations = validateNoteData(withMoney, { rules: NOTE_KAKA_RULES })
  assert.ok(violations.some((v) => v.rule === 'no-amounts' && v.path.endsWith('.amount')))

  // Per-share cost and price are already in the real file and are legitimate.
  const clean = { trade: { holdings: [{ name: '光大证券', weight: 30.33, cost: 15.456, price: 14.24 }] } }
  assert.equal(validateNoteData(clean, { rules: NOTE_KAKA_RULES }).filter((v) => v.rule === 'no-amounts').length, 0)
})

test('credentials are rejected and never echoed back', () => {
  const leaky = { core: { work: { todos: [{ t: 'deploy', n: 'api_key=sk-abcdefghijklmnopqrstuvwxyz012345' }] } } }
  const violations = validateNoteData(leaky)
  const secret = violations.filter((v) => v.rule === 'no-secrets')
  assert.ok(secret.length > 0)
  for (const v of secret) {
    assert.ok(!v.detail.includes('sk-abcdefghijklmnopqrstuvwxyz012345'), 'the secret must not be copied into the report')
  }
})

test('acct.flow keeps only the current and previous month', () => {
  const now = new Date(2026, 7, 30) // 2026-08-30
  const data = {
    acct: {
      flow: [
        { d: '08-19', c: '餐饮', a: 30 },
        { d: '07-02', c: '交通', a: 12 },
        { d: '03-15', c: '旧账', a: 99 },
      ],
    },
  }
  const violations = validateNoteData(data, { now, rules: NOTE_KAKA_RULES })
  const stale = violations.filter((v) => v.rule === 'governance-window' && v.path.startsWith('acct.flow'))
  assert.equal(stale.length, 1)
  assert.ok((stale[0]?.detail ?? '').includes('03-15'))
})

test('placeholder rows are not mistaken for stale data', () => {
  // acct.js currently ships as a framework page: README §2.0 documents "--" and
  // "" as the placeholder convention for "nothing recorded yet".
  const data = {
    acct: {
      flow: [
        { d: '--', c: '--', a: '--', n: '示例：8/18 餐饮 58.0 晚餐' },
        { d: '', c: '', a: '', n: '待录入' },
      ],
    },
  }
  const violations = validateNoteData(data, { now: new Date(2026, 7, 30), rules: NOTE_KAKA_RULES })
  assert.deepEqual(
    violations.filter((v) => v.path.startsWith('acct.flow')),
    [],
  )
})

test('the real note-kaka workspace parses, validates and round-trips', (t) => {
  // Read-only against the live workspace. Skipped when it is not present so the
  // suite still passes on a machine that has no note-kaka checkout.
  const root = process.env.NOTE_KAKA_PATH ?? 'C:/Workplace/gitee/note-kaka'
  let raw: string
  try {
    raw = readFileSync(join(root, NOTE_DATA_DIR, 'trade.js'), 'utf8')
  } catch {
    t.skip(`note-kaka not found at ${root}`)
    return
  }

  const { data, loaded, problems } = readNoteData(root)
  assert.deepEqual(problems, [], 'every real data file evaluates cleanly')
  assert.equal(loaded.length, 5)
  assert.deepEqual(Object.keys(data).sort(), ['acct', 'core', 'meta', 'mind', 'trade', 'weekly'])

  // Governance drift is expected as the notes grow and is surfaced by
  // scripts/smoke.mjs, so it must not fail this suite. A leaked credential is a
  // different matter -- that is an emergency, and it is asserted here.
  const violations = validateNoteData(data)
  assert.deepEqual(
    violations.filter((v) => v.rule === 'no-secrets'),
    [],
    'no credentials in the real data files',
  )
  assert.deepEqual(
    violations.filter((v) => v.rule === 'no-amounts'),
    [],
    'real trade data records percentages only',
  )

  const rewritten = serializeNoteDataFile({ previous: raw, keys: keysForFile('trade.js'), data })
  // Serialization happens in memory only; nothing is written to note-kaka.
  const check = mkdtempSync(join(tmpdir(), 'notedata-real-'))
  mkdirSync(join(check, NOTE_DATA_DIR), { recursive: true })
  writeFileSync(join(check, NOTE_DATA_DIR, 'trade.js'), rewritten, 'utf8')
  const reread = readNoteData(check)
  assert.deepEqual(reread.data.trade, data.trade, 'real trade data survives a round-trip')
})
