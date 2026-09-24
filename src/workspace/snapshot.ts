import { simpleGit, type SimpleGit } from 'simple-git'

/**
 * Commits whatever an agent changed in its workspace, so every run is auditable
 * and revertable.
 *
 * This exists because `writer.ts` cannot cover agent runs. That path is for
 * manager's own writes, where manager composes the content and can validate it
 * before it lands. An agent writes through DSH's own tools, inside a sandbox
 * manager does not control, so manager only ever sees the result on disk. All it
 * can do -- and must do -- is snapshot it.
 *
 * Three rules:
 *
 * 1. **Never fail a run because git failed.** The turn already happened and
 *    already cost money. A commit problem is reported, not raised.
 * 2. **Pre-existing changes get their own commit.** Otherwise the run's commit
 *    would mix the operator's uncommitted edits with the agent's work, and
 *    reverting the agent would throw away the operator's notes too.
 * 3. **A failed run is still snapshotted.** An agent that wrote three files and
 *    then timed out has still changed the workspace; leaving that uncommitted is
 *    how work gets silently lost.
 */

export interface SnapshotResult {
  /** null when there was nothing to commit, which is the common case. */
  commit: string | null
  /** Workspace-relative paths, posix-style. */
  files: string[]
  /**
   * Non-null when no snapshot could be taken (not a repo, git failed, no
   * identity configured). The run is unaffected; this is for the operator.
   */
  skipped: string | null
}

const CLEAN: SnapshotResult = { commit: null, files: [], skipped: null }

/** Keeps `git log --oneline` readable; the full text goes in the body. */
const SUBJECT_MAX = 64

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

const subjectFrom = (text: string): string => {
  const flat = oneLine(text)
  if (flat === '') return '(no instruction)'
  return flat.length <= SUBJECT_MAX ? flat : `${flat.slice(0, SUBJECT_MAX - 1)}…`
}

/** Everything git considers changed, including untracked files. */
const changedPaths = async (git: SimpleGit): Promise<string[]> => {  const status = await git.status()
  const all = [
    ...status.not_added,
    ...status.modified,
    ...status.created,
    ...status.deleted,
    ...status.renamed.map((r) => r.to),
    ...status.staged,
  ].map((p) => p.replace(/\\/g, '/'))
  return [...new Set(all)].sort()
}

/**
 * Stages everything and commits it.
 *
 * `add --all` deliberately: an agent creates files as well as editing them, and
 * a new file left untracked is the one most likely to be lost. `.gitignore`
 * still applies, so build output and secrets stay out.
 */
const commitAll = async (workspacePath: string, subject: string, body: string[]): Promise<SnapshotResult> => {
  let git: SimpleGit
  try {
    git = simpleGit(workspacePath)
  } catch (error) {
    return { ...CLEAN, skipped: `git unavailable: ${(error as Error).message}` }
  }

  try {
    if (!(await git.checkIsRepo())) {
      return {
        ...CLEAN,
        skipped: `${workspacePath} is not a git repository, so this run left no audit trail`,
      }
    }

    const files = await changedPaths(git)
    if (files.length === 0) return CLEAN

    await git.raw(['add', '--all'])
    const summary = await git.commit([subject, '', ...body].join('\n'))
    // An empty hash means nothing was actually staged -- for instance every
    // changed path is gitignored. Not an error, just not a commit.
    return { commit: summary.commit === '' ? null : summary.commit, files, skipped: null }
  } catch (error) {
    // Most likely no user.name/user.email in this repo. Say so plainly: the
    // files are still on disk, they are simply not committed yet.
    return {
      commit: null,
      files: [],
      skipped: `could not commit: ${(error as Error).message}`,
    }
  }
}

export interface RunLabel {
  runId: string
  agentName: string
}

/**
 * 蜂群 P5.4：工作区当前 HEAD，用于并发冲突检测——run 结束时若 HEAD 已经
 * 不在它开始时的位置，说明期间有另一个回合提交过。非 git 仓返回 null。
 */
export const currentHead = async (workspacePath: string): Promise<string | null> => {
  try {
    const git = simpleGit(workspacePath)
    if (!(await git.checkIsRepo())) return null
    const head = await git.revparse(['HEAD'])
    return head === '' ? null : head
  } catch {
    return null
  }
}

/**
 * Commits anything already uncommitted, before the agent starts.
 *
 * Committing someone's work-in-progress uninvited is a real intrusion, so the
 * message says exactly what happened and why. The alternative is worse: those
 * edits would otherwise be swept into the agent's commit and become
 * indistinguishable from it.
 */
export const snapshotBefore = async (workspacePath: string, label: RunLabel): Promise<SnapshotResult> =>
  commitAll(workspacePath, 'chore: uncommitted changes before the run', [
    `These changes existed before ${label.agentName} started, so the agent did not make them.`,
    "They are committed separately so the next commit contains only the agent's own work and can be reverted safely.",
    '',
    `Run: ${label.runId}`,
  ])

export interface AfterOptions extends RunLabel {
  /** The instruction, used as the commit subject. */
  prompt: string
  trigger: string
  state: string
}

export const snapshotAfter = async (workspacePath: string, options: AfterOptions): Promise<SnapshotResult> => {
  const failed = options.state !== 'done'
  const body = [
    `Agent: ${options.agentName}`,
    `Run: ${options.runId}`,
    `Trigger: ${options.trigger}`,
    // Worth saying out loud: these files are what an unfinished turn left
    // behind, so they may be half-written.
    ...(failed ? [`State: ${options.state} -- the run did not finish cleanly, so the changes may be incomplete`] : []),
    '',
    'Instruction:',
    ...oneLine(options.prompt)
      .split('\n')
      .map((line) => `  ${line}`),
  ]
  return commitAll(workspacePath, `${options.agentName}: ${subjectFrom(options.prompt)}`, body)
}
