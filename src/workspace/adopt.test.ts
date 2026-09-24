import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectWorkspace } from './adopt.js'

/**
 * 债务 C2:adopt(工作区体检)此前零覆盖。覆盖:
 * 不存在路径的显性阻断 / 非 git 阻断 / 缺 RULE.md+CONTEXT.md 阻断 /
 * git 仓库的 branch/dirty/lastCommit / note-data 目录与 keys。
 */

test('债务 C2: 路径不存在 = exists:false + 路径阻断(不抛)', async () => {
  const report = await inspectWorkspace(join(tmpdir(), 'definitely-not-here-xyz'))
  assert.equal(report.exists, false)
  assert.ok(report.blockers.some((b) => b.includes('does not exist')), '路径缺失必须显性阻断')
})

test('债务 C2: 空目录 = 缺文档/缺数据目录/非 git 三类阻断全报', async () => {
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

test('债务 C2: git 仓库体检返回 branch/dirty/lastCommit;dirty 显性列出未提交文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adopt-git-'))
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir, stdio: 'ignore' })
  writeFileSync(join(dir, 'RULE.md'), '# rules\n', 'utf8')
  writeFileSync(join(dir, 'CONTEXT.md'), '# context\n', 'utf8')
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: dir, stdio: 'ignore' })
  writeFileSync(join(dir, 'dirty.txt'), 'uncommitted', 'utf8') // 不 add

  const report = await inspectWorkspace(dir)
  assert.equal(report.git.isRepo, true)
  assert.ok(report.git.branch !== null, 'git 仓库必有当前分支名')
  assert.ok(report.git.dirty.includes('dirty.txt'), '未提交文件必须显性列出(回滚语义依赖它)')
  assert.ok(report.git.lastCommit !== null && report.git.lastCommit.message === 'initial')
  assert.ok(!report.blockers.some((b) => b.includes('not a git repository')))
  assert.deepEqual(report.docs.map((d) => d.present), [true, true], 'RULE.md/CONTEXT.md 齐备')

  rmSync(dir, { recursive: true, force: true })
})

test('债务 C2: note-data 目录存在但无文件 = present:true + 零 loaded;缺文件按清单报 present', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adopt-notedata-'))
  // NOTE_DATA_DIR = Z-元数据/note-data(两级,note-kaka 约定)
  mkdirSync(join(dir, 'Z-元数据', 'note-data'), { recursive: true })
  const report = await inspectWorkspace(dir)
  assert.equal(report.noteData.present, true)
  assert.deepEqual(report.noteData.loaded, [])
  assert.ok(report.noteData.files.length > 0 && report.noteData.files.every((f) => f.present === false), '清单文件缺失逐个报 present:false')
  rmSync(dir, { recursive: true, force: true })
})
