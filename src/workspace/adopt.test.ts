import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectWorkspace } from './adopt.js'

/**
 * Debt C2: adopt (the workspace check-up) had zero coverage. Covered here:
 * an explicit blocker for a path that does not exist / the non-git blocker / the missing
 * RULE.md+CONTEXT.md blocker / branch, dirty and lastCommit on a git repo / the note-data directory and keys.
 */

test('Debt C2: a path that does not exist = exists:false + a path blocker (no throw)', async () => {
  const report = await inspectWorkspace(join(tmpdir(), 'definitely-not-here-xyz'))
  assert.equal(report.exists, false)
  assert.ok(report.blockers.some((b) => b.includes('does not exist')), 'a missing path must block explicitly')
})

test('Debt C2: an empty directory = all three blockers reported: missing docs / missing data dir / not git', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adopt-empty-'))
  const report = await inspectWorkspace(dir)
  assert.equal(report.exists, true)
  assert.equal(report.git.isRepo, false)
  assert.equal(report.noteData.present, false)
  const reasons = report.blockers.join('\n')
  assert.match(reasons, /missing RULE\.md/)
  assert.match(reasons, /missing CONTEXT\.md/)
  assert.match(reasons, /missing data directory/)
  assert.match(reasons, /not a git repository/)
  rmSync(dir, { recursive: true, force: true })
})

test('Debt C2: a git repo check-up returns branch/dirty/lastCommit; dirty lists the uncommitted files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adopt-git-'))
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir, stdio: 'ignore' })
  writeFileSync(join(dir, 'RULE.md'), '# rules\n', 'utf8')
  writeFileSync(join(dir, 'CONTEXT.md'), '# context\n', 'utf8')
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: dir, stdio: 'ignore' })
  writeFileSync(join(dir, 'dirty.txt'), 'uncommitted', 'utf8') // never added

  const report = await inspectWorkspace(dir)
  assert.equal(report.git.isRepo, true)
  assert.ok(report.git.branch !== null, 'a git repo always has a current branch name')
  assert.ok(report.git.dirty.includes('dirty.txt'), 'uncommitted files must be listed (rollback semantics depend on it)')
  assert.ok(report.git.lastCommit !== null && report.git.lastCommit.message === 'initial')
  assert.ok(!report.blockers.some((b) => b.includes('not a git repository')))
  assert.deepEqual(report.docs.map((d) => d.present), [true, true], 'RULE.md/CONTEXT.md both present')

  rmSync(dir, { recursive: true, force: true })
})

test('Debt C2: a note-data directory that exists but holds no file = present:true + zero loaded; missing files report present per the manifest', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adopt-notedata-'))
  // NOTE_DATA_DIR = Z-元数据/note-data (two levels, the note-kaka convention)
  mkdirSync(join(dir, 'Z-元数据', 'note-data'), { recursive: true })
  const report = await inspectWorkspace(dir)
  assert.equal(report.noteData.present, true)
  assert.deepEqual(report.noteData.loaded, [])
  assert.ok(report.noteData.files.length > 0 && report.noteData.files.every((f) => f.present === false), 'every missing manifest file reports present:false')
  rmSync(dir, { recursive: true, force: true })
})
