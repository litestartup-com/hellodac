import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createContext, runInContext } from 'node:vm'

/**
 * Reads and writes note-kaka's `Z-元数据/note-data/*.js` data files.
 *
 * These files are deliberately `.js` and not `.json`: under `file://` the
 * browser refuses `fetch()` (origin is null), so `<script src>` is the only way
 * `note.html` can work by double-clicking it with no server. That property is
 * worth preserving, so manager reads and writes the `.js` form directly instead
 * of converting the repository to JSON (note-data/README.md §5.1).
 *
 * manager's own dashboard is served over HTTP, so it simply parses these files
 * server-side and exposes ordinary JSON through its own API.
 */

/** Load order matters: the files accumulate onto one shared `window.NOTE_DATA`. */
export const NOTE_DATA_DIR = join('Z-元数据', 'note-data')
export const NOTE_DATA_FILES = ['core.js', 'weekly.js', 'trade.js', 'acct.js', 'mind.js'] as const
export type NoteDataFile = (typeof NOTE_DATA_FILES)[number]

/** Top-level keys of `window.NOTE_DATA`, mapped to the file that owns each. */
export const KEY_OWNER: Record<string, NoteDataFile> = {
  meta: 'core.js',
  core: 'core.js',
  weekly: 'weekly.js',
  trade: 'trade.js',
  acct: 'acct.js',
  mind: 'mind.js',
}

export interface NoteData {
  [key: string]: unknown
}

/**
 * `missing` is benign: note.html renders an empty page for an absent data file
 * on purpose (README §5.3), and a workspace may legitimately not have all five.
 * `invalid` means the file exists but does not evaluate -- that is corruption,
 * and callers that write must refuse to proceed.
 */
export type ProblemKind = 'missing' | 'invalid'

export interface DataProblem {
  file: NoteDataFile
  kind: ProblemKind
  reason: string
}

export interface ReadResult {
  data: NoteData
  /** Files that were present and evaluated without error. */
  loaded: NoteDataFile[]
  problems: DataProblem[]
}

const dataDir = (workspacePath: string): string => join(workspacePath, NOTE_DATA_DIR)

/**
 * Evaluates the data files the same way the browser does -- sequentially, in one
 * shared context -- so `window.NOTE_DATA = window.NOTE_DATA || {}` accumulates.
 *
 * A `vm` context is used rather than `eval` so the files cannot reach `require`,
 * `process` or the filesystem. They come from the user's own git repository, but
 * an agent writes to them, so treating them as untrusted input is cheap
 * insurance against a malformed or hostile write.
 */
export const readNoteData = (workspacePath: string): ReadResult => {
  const dir = dataDir(workspacePath)
  const sandbox: { window: { NOTE_DATA?: NoteData } } = { window: {} }
  const context = createContext(sandbox)
  const loaded: NoteDataFile[] = []
  const problems: DataProblem[] = []

  for (const file of NOTE_DATA_FILES) {
    let source: string
    try {
      source = readFileSync(join(dir, file), 'utf8')
    } catch (error) {
      const code = (error as { code?: string }).code
      problems.push({
        file,
        kind: code === 'ENOENT' ? 'missing' : 'invalid',
        reason: code === 'ENOENT' ? 'not present' : `unreadable: ${(error as Error).message}`,
      })
      continue
    }
    try {
      // Bounded: a runaway loop in a corrupted data file must not hang manager.
      runInContext(source, context, { timeout: 2_000, filename: file })
      loaded.push(file)
    } catch (error) {
      // One broken file must not lose the others, matching note.html's own
      // per-file fallback behaviour (README §5.3).
      problems.push({ file, kind: 'invalid', reason: `evaluation failed: ${(error as Error).message}` })
    }
  }

  const raw = sandbox.window.NOTE_DATA ?? {}

  // Objects built inside a vm context belong to a different realm, so they carry
  // a foreign Object.prototype: `deepStrictEqual` and any `instanceof` check
  // against them fails, and they may hide getters or functions. Round-tripping
  // through JSON pulls the values into this realm as plain data and drops
  // anything that is not data -- which is exactly the sanitisation an untrusted
  // file deserves.
  //
  // Done per top-level key so a single cyclic or throwing key does not discard
  // the other datasets.
  const data: NoteData = {}
  for (const key of Object.keys(raw)) {
    try {
      data[key] = JSON.parse(JSON.stringify((raw as Record<string, unknown>)[key])) as unknown
    } catch (error) {
      const file = KEY_OWNER[key]
      problems.push({
        file: file ?? (NOTE_DATA_FILES[0]),
        kind: 'invalid',
        reason: `key "${key}" is not plain data: ${(error as Error).message}`,
      })
    }
  }

  return { data, loaded, problems }
}

// ---------------------------------------------------------------------------
// Shape-preserving serializer
// ---------------------------------------------------------------------------

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/
/**
 * Records stay on one line up to this width. The existing files put one holding
 * or one snapshot per line, and keeping that means changing a single record
 * produces a single-line git diff -- which is the whole point of using git as
 * the audit trail. JSON.stringify would turn every edit into a ten-line diff.
 */
const INLINE_BUDGET = 240

const isPrimitive = (value: unknown): boolean =>
  value === null || ['string', 'number', 'boolean'].includes(typeof value)

const literal = (value: unknown): string => {
  if (value === null) return 'null'
  if (value === undefined) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null'
  if (typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

const propKey = (key: string): string => (IDENT.test(key) ? key : JSON.stringify(key))

const inlineOf = (value: unknown): string | null => {
  if (isPrimitive(value)) return literal(value)
  if (Array.isArray(value)) {
    if (!value.every(isPrimitive)) return null
    const body = value.map(literal).join(', ')
    const text = body === '' ? '[]' : `[${body}]`
    return text.length <= INLINE_BUDGET ? text : null
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (!entries.every(([, v]) => isPrimitive(v))) return null
    if (entries.length === 0) return '{}'
    const text = `{ ${entries.map(([k, v]) => `${propKey(k)}:${literal(v)}`).join(', ')} }`
    return text.length <= INLINE_BUDGET ? text : null
  }
  return null
}

const serializeValue = (value: unknown, depth: number): string => {
  const inline = inlineOf(value)
  if (inline !== null) return inline

  const pad = '  '.repeat(depth + 1)
  const closePad = '  '.repeat(depth)

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const items = value.map((item) => `${pad}${serializeValue(item, depth + 1)},`)
    return `[\n${items.join('\n')}\n${closePad}]`
  }

  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined)
  if (entries.length === 0) return '{}'
  const lines = entries.map(([k, v]) => `${pad}${propKey(k)}: ${serializeValue(v, depth + 1)},`)
  return `{\n${lines.join('\n')}\n${closePad}}`
}

/**
 * Keeps the existing header comment block verbatim (README §6 mandates a header
 * on every data file, and it carries the governance note a human wrote). Only
 * the assigned object is regenerated.
 */
const splitHeader = (source: string): string | null => {
  const marker = source.indexOf('window.NOTE_DATA')
  if (marker <= 0) return null
  return source.slice(0, marker).trimEnd()
}

export interface SerializeInput {
  /** Existing file contents, used to preserve the header comment. */
  previous: string | null
  /** Top-level keys this file owns, in the order they should be emitted. */
  keys: string[]
  data: NoteData
}

export const serializeNoteDataFile = ({ previous, keys, data }: SerializeInput): string => {
  const header = previous === null ? null : splitHeader(previous)
  const parts: string[] = []
  if (header !== null && header !== '') parts.push(header, '')
  parts.push('window.NOTE_DATA = window.NOTE_DATA || {};', '')
  for (const key of keys) {
    if (!(key in data)) continue
    parts.push(`window.NOTE_DATA.${key} = ${serializeValue(data[key], 0)};`, '')
  }
  // UTF-8 without BOM, trailing newline (README §4.5).
  return `${parts.join('\n').trimEnd()}\n`
}

/** Keys owned by a given file, preserving the documented emission order. */
export const keysForFile = (file: NoteDataFile): string[] =>
  Object.entries(KEY_OWNER)
    .filter(([, owner]) => owner === file)
    .map(([key]) => key)

/**
 * 债务 E11:读取失败必须显性——旧实现 catch 一切返回 null,把「读不了」
 * (权限/IO/EISDIR)当成「不存在」,writer 会据此重建文件并覆盖真实数据。
 * 现在只有 ENOENT(确实不存在)返回 null;其余错误显性抛出。
 */
export const readRawFile = (workspacePath: string, file: NoteDataFile): string | null => {
  const path = join(dataDir(workspacePath), file)
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`reading ${path} failed: ${message}`)
  }
}

export const noteDataFilePath = (workspacePath: string, file: NoteDataFile): string =>
  join(dataDir(workspacePath), file)
