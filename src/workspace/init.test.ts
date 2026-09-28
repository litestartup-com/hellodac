import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readBoard } from '../board/store.js'
import { initWorkspace, listPresets } from './init.js'

const fresh = (): string => mkdtempSync(join(tmpdir(), 'init-'))

test('ships the presets the config offers', () => {
  const presets = listPresets()
  for (const expected of ['personal', 'company', 'product']) {
    assert.ok(presets.includes(expected), `${expected} template is missing`)
  }
})

test('every shipped template produces a board manager can render', () => {
  // The templates are the first thing a new user sees. If one of them fails
  // validation, the product's opening impression is a page full of red
  // placeholder cards -- so check them all, not just personal.
  for (const preset of listPresets()) {
    // Hive P2: brain is the brain's scratchpad template (a manager-level object), not a business
    // workspace -- no board and no dashboard rendered; business dashboard assertions apply to worker templates only.
    if (preset === 'brain') continue
    const root = fresh()
    initWorkspace({ workspacePath: root, preset, useGit: false })

    const board = readBoard(root, 'fallback')
    assert.deepEqual(board.problems, [], `${preset} template has invalid board data`)
    assert.ok(board.pages.length > 0, `${preset} template has no pages`)
    for (const page of board.pages) {
      for (const block of page.blocks) {
        assert.notEqual(block.type, 'unsupported', `${preset}/${page.key} contains an unrenderable block`)
      }
    }
  }
})

test('every template explains itself to the agent', () => {
  for (const preset of listPresets()) {
    // Hive P2: brain's AGENTS.md is a list of red lines and dispatch criteria, with no business block
    // directory (it has no board); that assertion applies to the worker template only.
    if (preset === 'brain') continue
    const root = fresh()
    initWorkspace({ workspacePath: root, preset, useGit: false })
    const agents = join(root, 'AGENTS.md')
    assert.ok(existsSync(agents), `${preset} has no AGENTS.md`)
    // Without the block catalogue the agent has to guess, and guesses become
    // unsupported cards on the user's board.
    assert.match(readFileSync(agents, 'utf8'), /kpi/, `${preset}/AGENTS.md does not list the block types`)
  }
})

test('never overwrites a file that already exists', () => {
  // Initialising may well be run against a directory the user already keeps
  // notes in, or one manager set up months ago. Replacing their content would
  // be the worst thing this command could do.
  const root = fresh()
  mkdirSync(join(root, 'board'), { recursive: true })
  writeFileSync(join(root, 'AGENTS.md'), 'Rules I wrote myself\n', 'utf8')
  writeFileSync(join(root, 'board', 'meta.json'), '{"title":"My Own Title"}', 'utf8')

  const result = initWorkspace({ workspacePath: root, preset: 'personal', useGit: false })

  assert.equal(readFileSync(join(root, 'AGENTS.md'), 'utf8'), 'Rules I wrote myself\n')
  assert.equal(readBoard(root, 'x').title, 'My Own Title')
  assert.ok(result.skipped.includes('AGENTS.md'))
  assert.ok(result.created.length > 0, 'the missing files were still added')
})

test('running twice is a no-op the second time', () => {
  const root = fresh()
  const first = initWorkspace({ workspacePath: root, preset: 'personal', useGit: false })
  const second = initWorkspace({ workspacePath: root, preset: 'personal', useGit: false })

  assert.ok(first.created.length > 0)
  assert.deepEqual(second.created, [], 'nothing new on a second run')
  assert.deepEqual(second.skipped.sort(), first.created.sort())
})

test('creates the workspace directory when it does not exist yet', () => {
  const root = join(fresh(), 'nested', 'workspace')
  initWorkspace({ workspacePath: root, preset: 'personal', useGit: false })
  assert.ok(existsSync(join(root, 'AGENTS.md')))
})

test('an unknown preset fails loudly and lists the real ones', () => {
  assert.throws(
    () => initWorkspace({ workspacePath: fresh(), preset: 'nope', useGit: false }),
    /unknown preset "nope".*personal/s,
  )
})

test('initialises git and commits the scaffold', () => {
  const root = fresh()
  const result = initWorkspace({ workspacePath: root, preset: 'personal' })

  assert.equal(result.gitInitialised, true)
  assert.notEqual(result.committed, null)
  assert.deepEqual(result.warnings, [], 'git should have worked')

  // A clean tree proves everything the scaffold wrote actually got committed.
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })
  assert.equal(status.trim(), '', `uncommitted leftovers:\n${status}`)
})

test('the .gitignore it writes is committed, not left untracked', () => {
  // Regression: .gitignore used to be written after the commit, so every fresh
  // workspace reported a dirty tree the moment init finished.
  const root = fresh()
  const result = initWorkspace({ workspacePath: root, preset: 'personal' })

  assert.ok(existsSync(join(root, '.gitignore')))
  assert.ok(result.created.includes('.gitignore'))
  const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
  assert.match(tracked, /\.gitignore/)
})

test('a workspace that already has a .gitignore keeps it', () => {
  const root = fresh()
  writeFileSync(join(root, '.gitignore'), 'secret-notes/\n', 'utf8')
  const result = initWorkspace({ workspacePath: root, preset: 'personal' })

  assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), 'secret-notes/\n')
  assert.ok(!result.created.includes('.gitignore'))
})

test('nested template files are committed too', () => {
  // git pathspecs are forward-slashed even on Windows, so a nested path added
  // with a backslash separator could silently fail to stage.
  const root = fresh()
  initWorkspace({ workspacePath: root, preset: 'personal' })

  const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
  assert.match(tracked, /board\/overview\.json/)
})

test('does not create a nested repository inside an existing one', () => {
  // A repo inside a repo silently detaches the workspace from the history the
  // user thinks it is in.
  const root = fresh()
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root, stdio: 'ignore' })

  const sub = join(root, 'notes')
  mkdirSync(sub, { recursive: true })
  const result = initWorkspace({ workspacePath: sub, preset: 'personal' })

  assert.equal(result.gitInitialised, false, 'reused the surrounding repository')
  assert.ok(!existsSync(join(sub, '.git')))
})

test('2026-09-05: adopting an outer repo warns about the missing audit trail', () => {
  // The brain's workspace once squatted inside an outer repo: no git of its own, files ignored by
  // .gitignore, so no agent run had a commit to audit. Adopting an outer repo must now warn explicitly.
  const root = fresh()
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root, stdio: 'ignore' })

  const sub = join(root, 'notes')
  mkdirSync(sub, { recursive: true })
  const result = initWorkspace({ workspacePath: sub, preset: 'personal' })

  assert.ok(
    result.warnings.some((w) => w.includes('adopted by an outer repository')),
    `warnings should name the nesting problem, got: ${result.warnings.join(' | ')}`,
  )
})

test('skips git entirely when asked', () => {
  const root = fresh()
  const result = initWorkspace({ workspacePath: root, preset: 'personal', useGit: false })

  assert.equal(result.gitInitialised, false)
  assert.equal(result.committed, null)
  assert.ok(!existsSync(join(root, '.git')))
  assert.ok(existsSync(join(root, 'AGENTS.md')), 'the files are still there')
})

test('the personal template lays out the pages a user expects', () => {
  const root = fresh()
  initWorkspace({ workspacePath: root, preset: 'personal', useGit: false })
  const board = readBoard(root, 'x')

  assert.equal(board.title, 'Personal dashboard')
  assert.deepEqual(
    board.pages.map((p) => p.key),
    ['overview', 'money', 'health'],
  )
  // asOf starts empty on purpose: a template must not claim to be current.
  assert.equal(board.asOf, null)
})
