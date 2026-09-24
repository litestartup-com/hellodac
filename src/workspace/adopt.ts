import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { simpleGit } from 'simple-git'
import { NOTE_DATA_DIR, NOTE_DATA_FILES, readNoteData } from './notedata.js'
import { DEFAULT_RULES, validateNoteData, type ValidateRules, type Violation } from './validate.js'

/**
 * Inspects an adopted workspace. It deliberately writes nothing.
 *
 * The original plan was to seed `AGENTS.md`, `crons.yaml` and empty data
 * skeletons into the workspace. note-kaka already documents its own rules in
 * `RULE.md`, `CONTEXT.md` and `note-data/README.md`, and `RULE.md` §5 explicitly
 * forbids adding engineering scaffolding to the notes repository. So manager
 * adapts to the workspace instead of reshaping it, and points the agent at the
 * documents that are already there.
 */

/** Documents the agent must read before touching anything (RULE.md §0). */
export const REQUIRED_DOCS = ['RULE.md', 'CONTEXT.md'] as const

export interface WorkspaceReport {
  path: string
  exists: boolean
  /** Docs that define the rules, and whether each is present. */
  docs: { name: string; present: boolean }[]
  noteData: {
    dir: string
    present: boolean
    files: { name: string; present: boolean }[]
    loaded: string[]
    problems: { file: string; reason: string }[]
    /** Top-level keys found on `window.NOTE_DATA`. */
    keys: string[]
  }
  git: {
    isRepo: boolean
    branch: string | null
    /** Uncommitted paths. A dirty workspace makes rollback ambiguous. */
    dirty: string[]
    lastCommit: { hash: string; date: string; message: string } | null
  }
  /** Pre-existing violations of the workspace's own documented rules. */
  violations: Violation[]
  /** Blocking problems that must be fixed before an agent may run. */
  blockers: string[]
}

const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export const inspectWorkspace = async (
  workspacePath: string,
  /** 债务 E12:治理规则随 agent 配置;缺省 = 通用凭证检查。 */
  rules: ValidateRules = DEFAULT_RULES,
): Promise<WorkspaceReport> => {
  const exists = isDir(workspacePath)
  const dataDir = join(workspacePath, NOTE_DATA_DIR)

  const docs = REQUIRED_DOCS.map((name) => ({ name, present: existsSync(join(workspacePath, name)) }))
  const files = NOTE_DATA_FILES.map((name) => ({ name, present: existsSync(join(dataDir, name)) }))

  const parsed = exists ? readNoteData(workspacePath) : { data: {}, loaded: [], problems: [] }

  const git = {
    isRepo: false,
    branch: null as string | null,
    dirty: [] as string[],
    lastCommit: null as WorkspaceReport['git']['lastCommit'],
  }
  if (exists) {
    try {
      const repo = simpleGit(workspacePath)
      git.isRepo = await repo.checkIsRepo()
      if (git.isRepo) {
        const status = await repo.status()
        git.branch = status.current
        git.dirty = [...status.not_added, ...status.modified, ...status.created, ...status.deleted, ...status.renamed.map((r) => r.to)]
        const log = await repo.log({ maxCount: 1 })
        const latest = log.latest
        git.lastCommit = latest === null ? null : { hash: latest.hash.slice(0, 8), date: latest.date, message: latest.message }
      }
    } catch {
      // A workspace without git still works for reading; it just cannot be
      // rolled back, which shows up as a blocker below.
      git.isRepo = false
    }
  }

  const violations = validateNoteData(parsed.data, { rules })

  const blockers: string[] = []
  if (!exists) blockers.push(`workspace path does not exist: ${workspacePath}`)
  if (exists && !isDir(dataDir)) blockers.push(`missing data directory: ${NOTE_DATA_DIR}`)
  for (const doc of docs) {
    if (!doc.present) blockers.push(`missing ${doc.name}, which defines the rules the agent must follow`)
  }
  for (const problem of parsed.problems) blockers.push(`${problem.file}: ${problem.reason}`)
  // git is the rollback mechanism for every agent write; without it a bad write
  // cannot be undone, so running an agent here would be reckless.
  if (exists && !git.isRepo) blockers.push('not a git repository, so agent writes could not be rolled back')

  return {
    path: workspacePath,
    exists,
    docs,
    noteData: {
      dir: NOTE_DATA_DIR,
      present: isDir(dataDir),
      files,
      loaded: parsed.loaded,
      problems: parsed.problems,
      keys: Object.keys(parsed.data),
    },
    git,
    violations,
    blockers,
  }
}
