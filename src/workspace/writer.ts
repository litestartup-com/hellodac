import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { simpleGit, type SimpleGit } from 'simple-git'
import {
  KEY_OWNER,
  NOTE_DATA_DIR,
  NOTE_DATA_FILES,
  keysForFile,
  readNoteData,
  readRawFile,
  serializeNoteDataFile,
  type NoteData,
  type NoteDataFile,
} from './notedata.js'
import { DEFAULT_RULES, validateNoteData, type ValidateRules, type Violation } from './validate.js'

/**
 * The single channel through which anything reaches an agent's workspace.
 *
 * Every write is: bounded to the workspace, refused if it would clobber
 * uncommitted work, validated before it lands, written atomically, and
 * committed. If any step fails the whole batch is rolled back, so a workspace is
 * never left half-written.
 */

export class WriteRejected extends Error {
  constructor(
    message: string,
    readonly reasons: string[],
    readonly violations: Violation[] = [],
  ) {
    super(message)
    this.name = 'WriteRejected'
  }
}

/** Paths manager must never touch, whatever it is asked to do. */
const FORBIDDEN_PREFIXES = ['.git']

/**
 * Resolves a workspace-relative path, refusing anything that escapes the
 * workspace -- including via a symlinked parent directory, which a plain
 * string prefix check would miss.
 */
export const resolveInside = (workspacePath: string, relPath: string): string => {
  if (relPath.trim() === '') throw new WriteRejected('empty path', ['a path is required'])
  if (isAbsolute(relPath)) throw new WriteRejected('absolute path', [`refusing an absolute path: ${relPath}`])
  if (relPath.includes('\0')) throw new WriteRejected('invalid path', ['path contains a null byte'])

  const root = realpathSync(workspacePath)
  const target = resolve(root, relPath)
  const inside = relative(root, target)
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    throw new WriteRejected('path escapes the workspace', [`${relPath} resolves outside ${root}`])
  }

  const firstSegment = inside.split(sep)[0] ?? ''
  if (FORBIDDEN_PREFIXES.includes(firstSegment)) {
    throw new WriteRejected('forbidden path', [`${relPath} is inside ${firstSegment}, which manager must never write`])
  }

  // A symlinked ancestor could point anywhere; check the nearest one that
  // exists, since the target file itself may not exist yet.
  let ancestor = dirname(target)
  while (!existsSync(ancestor) && ancestor !== dirname(ancestor)) ancestor = dirname(ancestor)
  const ancestorReal = realpathSync(ancestor)
  const ancestorInside = relative(root, ancestorReal)
  if (ancestorInside !== '' && (ancestorInside.startsWith('..') || isAbsolute(ancestorInside))) {
    throw new WriteRejected('path escapes the workspace via a symlink', [
      `${relPath} resolves through ${ancestorReal}, outside ${root}`,
    ])
  }

  return target
}

export interface FileWrite {
  /** Workspace-relative path. */
  relPath: string
  contents: string
}

export interface ApplyOptions {
  /** Commit subject. */
  message: string
  /**
   * The user's own words, recorded in the commit body so a misinterpretation
   * can be traced back and corrected (DESIGN.md: git is the audit trail).
   */
  originalRequest?: string
  /** Skip the commit; used by tests and dry runs. */
  commit?: boolean
  /**
   * 债务 R7:落盘后二次校验的治理规则(per-agent,来自 manager.config.yaml)。
   * 缺省 = DEFAULT_RULES(只做通用凭证检查)。writeNoteData 会把写前校验用的
   * 同一份规则透传到这里——回读校验与写前校验必须同一标准,否则落盘内容
   * 偏离(并发/序列化差异)时按默认规则放行。
   */
  rules?: ValidateRules
}

export interface ApplyResult {
  /** Workspace-relative paths that were written. Empty means it was a no-op. */
  files: string[]
  /** null when nothing changed, so no commit was made. */
  commit: string | null
}

const gitFor = (workspacePath: string): SimpleGit => simpleGit(workspacePath)

/** Paths with uncommitted changes, as workspace-relative posix-ish strings. */
const dirtyPaths = async (git: SimpleGit): Promise<Set<string>> => {
  const status = await git.status()
  return new Set(
    [
      ...status.not_added,
      ...status.modified,
      ...status.created,
      ...status.deleted,
      ...status.renamed.map((r) => r.to),
      ...status.staged,
    ].map((p) => p.replace(/\\/g, '/')),
  )
}

const toPosix = (p: string): string => p.replace(/\\/g, '/')

/** Writes via a temp file in the same directory, so a reader never sees a partial file. */
const atomicWrite = (absolutePath: string, contents: string): void => {
  mkdirSync(dirname(absolutePath), { recursive: true })
  const tmp = `${absolutePath}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(tmp, contents, { encoding: 'utf8' })
    renameSync(tmp, absolutePath)
  } catch (error) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      // Nothing more to do; the original file is untouched either way.
    }
    throw error
  }
}

/**
 * Applies a batch of writes under a single commit.
 *
 * Refuses up front if a target file already has uncommitted changes: rolling
 * back would then destroy work manager did not make. Unrelated dirty files are
 * ignored, so an unrelated edit elsewhere in the notes does not block writing.
 */
export const applyWrites = async (
  workspacePath: string,
  writes: FileWrite[],
  options: ApplyOptions,
): Promise<ApplyResult> => {
  if (writes.length === 0) throw new WriteRejected('nothing to write', ['no writes were supplied'])

  const targets = writes.map((w) => ({ ...w, absolutePath: resolveInside(workspacePath, w.relPath) }))
  const root = realpathSync(workspacePath)
  const relForGit = targets.map((t) => toPosix(relative(root, t.absolutePath)))

  const git = gitFor(root)
  const isRepo = await git.checkIsRepo().catch(() => false)
  if (!isRepo) {
    throw new WriteRejected('workspace is not a git repository', [
      'refusing to write where changes could not be rolled back or audited',
    ])
  }

  const dirty = await dirtyPaths(git)
  const conflicts = relForGit.filter((p) => dirty.has(p))
  if (conflicts.length > 0) {
    throw new WriteRejected('target file has uncommitted changes', [
      `commit or discard these first, otherwise a rollback would lose your own edits: ${conflicts.join(', ')}`,
    ])
  }

  // Snapshot for rollback: null means the file did not exist.
  const before = new Map<string, string | null>(
    targets.map((t) => [t.absolutePath, existsSync(t.absolutePath) ? readFileSync(t.absolutePath, 'utf8') : null]),
  )

  const rollback = (): void => {
    for (const [absolutePath, contents] of before) {
      try {
        if (contents === null) {
          if (existsSync(absolutePath)) unlinkSync(absolutePath)
        } else {
          atomicWrite(absolutePath, contents)
        }
      } catch {
        // Reported by the caller's error; git status will also show the mess.
      }
    }
  }

  for (const target of targets) atomicWrite(target.absolutePath, target.contents)

  // Validate what actually landed on disk, not what we intended to write.
  const touchedNoteData = relForGit.some((p) => p.startsWith(toPosix(NOTE_DATA_DIR)))
  if (touchedNoteData) {
    const { data, problems } = readNoteData(root)
    // A missing data file is a supported state, so only corruption is fatal.
    const corrupt = problems.filter((p) => p.kind === 'invalid')
    if (corrupt.length > 0) {
      rollback()
      throw new WriteRejected(
        'the written data files do not parse',
        corrupt.map((p) => `${p.file}: ${p.reason}`),
      )
    }
    // 债务 R7:回读校验与写前校验同一套规则(writeNoteData 透传),不得退化
    // 为 DEFAULT_RULES——否则带治理规则的 agent 在落盘偏离时会被放行。
    const violations = validateNoteData(data, options.rules === undefined ? {} : { rules: options.rules })
    if (violations.length > 0) {
      rollback()
      throw new WriteRejected(
        'the write violates the workspace’s own documented rules',
        violations.map((v) => `[${v.rule}] ${v.path}: ${v.detail}`),
        violations,
      )
    }
  }

  if (options.commit === false) return { files: relForGit, commit: null }

  try {
    await git.add(relForGit)
    const body = options.originalRequest === undefined ? [] : ['', `Requested: ${options.originalRequest}`]
    const summary = await git.commit([options.message, ...body].join('\n'), relForGit)
    // Nothing staged means the write was a no-op; that is a success, not a failure.
    const hash = summary.commit === '' ? null : summary.commit
    return { files: relForGit, commit: hash }
  } catch (error) {
    rollback()
    throw new WriteRejected('commit failed', [(error as Error).message])
  }
}

// ---------------------------------------------------------------------------
// note-data specific entry point
// ---------------------------------------------------------------------------

export interface NoteDataPatch {
  /** Top-level keys of window.NOTE_DATA to replace wholesale. */
  [key: string]: unknown
}

/**
 * Replaces whole top-level datasets (`trade`, `acct`, ...) and rewrites only the
 * files that own them, keeping every other file byte-identical.
 */
export const writeNoteData = async (
  workspacePath: string,
  patch: NoteDataPatch,
  options: ApplyOptions,
  /** 债务 E12:写前校验的治理规则;缺省 = 只做通用凭证检查。 */
  rules: ValidateRules = DEFAULT_RULES,
): Promise<ApplyResult> => {
  const keys = Object.keys(patch)
  if (keys.length === 0) throw new WriteRejected('nothing to write', ['no datasets were supplied'])

  const unknown = keys.filter((k) => !(k in KEY_OWNER))
  if (unknown.length > 0) {
    throw new WriteRejected('unknown dataset', [
      `not a known note-data key: ${unknown.join(', ')}; known keys are ${Object.keys(KEY_OWNER).join(', ')}`,
    ])
  }

  const current = readNoteData(workspacePath)
  // Writing on top of a file we could not parse would silently discard whatever
  // it held. A merely absent file is fine and gets created.
  const corrupt = current.problems.filter((p) => p.kind === 'invalid')
  if (corrupt.length > 0) {
    throw new WriteRejected(
      'refusing to write while the existing data files do not parse',
      corrupt.map((p) => `${p.file}: ${p.reason}`),
    )
  }

  const merged: NoteData = { ...current.data, ...patch }

  // Validate before touching the disk as well as after, so an obviously bad
  // request never reaches the filesystem.
  const violations = validateNoteData(merged, { rules })
  if (violations.length > 0) {
    throw new WriteRejected(
      'the write violates the workspace’s own documented rules',
      violations.map((v) => `[${v.rule}] ${v.path}: ${v.detail}`),
      violations,
    )
  }

  const owners = new Set<NoteDataFile>()
  for (const key of keys) {
    const owner = KEY_OWNER[key]
    if (owner !== undefined) owners.add(owner)
  }

  const writes: FileWrite[] = []
  for (const file of NOTE_DATA_FILES) {
    if (!owners.has(file)) continue

    // Compare the parsed data, not the bytes. The serializer normalises
    // formatting, so identical data can still produce different text -- and
    // rewriting on that basis would reformat a file for no reason and leave a
    // pointless commit behind every time a cron job finds nothing to change.
    const fileKeys = keysForFile(file)
    const unchanged = fileKeys.every((key) => isDeepStrictEqual(current.data[key], merged[key]))
    if (unchanged) continue

    const previous = readRawFile(workspacePath, file)
    const contents = serializeNoteDataFile({ previous, keys: fileKeys, data: merged })
    if (previous !== null && previous === contents) continue
    // Built from the known layout rather than by diffing absolute paths: on
    // Windows `%TEMP%` can be an 8.3 short name, so `relative(realpath, join)`
    // would not cancel out.
    writes.push({ relPath: noteDataRelPath(file), contents })
  }

  if (writes.length === 0) return { files: [], commit: null }

  // 债务 R7:把写前校验的同一份规则透传进 applyWrites(回读校验同标准)。
  return applyWrites(workspacePath, writes, { ...options, rules })
}

/** Appends a line to a markdown file, creating it if needed. */
export const appendMarkdown = async (
  workspacePath: string,
  relPath: string,
  line: string,
  options: ApplyOptions,
): Promise<ApplyResult> => {
  const absolutePath = resolveInside(workspacePath, relPath)
  if (!relPath.toLowerCase().endsWith('.md')) {
    throw new WriteRejected('not a markdown file', [`${relPath} does not end in .md`])
  }
  const existing = existsSync(absolutePath) ? readFileSync(absolutePath, 'utf8') : ''
  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n'
  const contents = `${existing}${separator}${line.replace(/\s+$/, '')}\n`
  return applyWrites(workspacePath, [{ relPath, contents }], options)
}

export const noteDataRelPath = (file: NoteDataFile): string => toPosix(join(NOTE_DATA_DIR, file))
