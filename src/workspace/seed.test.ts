import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedEmptyWorkspaces } from './seed.js'

test('Hive plan 2 P6: an empty workspace is seeded with templates + git; a non-empty one is never touched', () => {
  const root = mkdtempSync(join(tmpdir(), 'seed-'))
  const brain = join(root, 'brain')
  const personal = join(root, 'personal')
  const noteVault = join(root, 'note-vault')
  try {
    mkdirSync(brain, { recursive: true })
    mkdirSync(personal, { recursive: true })
    mkdirSync(noteVault, { recursive: true })
    writeFileSync(join(noteVault, 'notes.md'), 'my notes', 'utf8')

    const seeded = seedEmptyWorkspaces([
      { id: 'brain', workspacePath: brain },
      { id: 'personal', workspacePath: personal },
      { id: 'note-vault', workspacePath: noteVault },
    ])

    assert.deepEqual(seeded.sort(), ['brain', 'personal'])
    assert.ok(existsSync(join(brain, 'AGENTS.md')), 'the brain template carries AGENTS.md')
    assert.ok(existsSync(join(brain, '.skills', 'brain-api', 'SKILL.md')), 'the brain template carries the skill manual')
    assert.ok(existsSync(join(brain, '.git')), 'seeding creates a separate git repo')
    assert.ok(existsSync(join(personal, 'AGENTS.md')))
    // Non-empty workspace: files as they were, no templates pushed in
    assert.equal(readdirSync(noteVault).length, 1)
    assert.equal(existsSync(join(noteVault, 'AGENTS.md')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Hive plan 2 P6: a node name with no template falls back to a minimal git init', () => {
  const root = mkdtempSync(join(tmpdir(), 'seed-fallback-'))
  const odd = join(root, 'some-random-node')
  try {
    mkdirSync(odd, { recursive: true })
    const seeded = seedEmptyWorkspaces([{ id: 'some-random-node', workspacePath: odd }])
    assert.deepEqual(seeded, ['some-random-node'])
    assert.ok(existsSync(join(odd, 'AGENTS.md')), 'the generic AGENTS.md covers it')
    assert.ok(existsSync(join(odd, '.git')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
