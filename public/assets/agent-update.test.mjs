import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyPendingUpdate, currentAgentVersion } from './agent/update.mjs'

test('Capability four M4-3: applyPendingUpdate -- .next is swapped in atomically, the version marker is persisted, .prev keeps the previous generation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'upd-'))
  try {
    writeFileSync(join(dir, 'agent.mjs'), 'old-entry')
    writeFileSync(join(dir, 'runtime.mjs'), 'old-runtime')
    mkdirSync(join(dir, '.next'), { recursive: true })
    writeFileSync(join(dir, '.next', 'agent.mjs'), 'new-entry')
    writeFileSync(join(dir, '.next', 'runtime.mjs'), 'new-runtime')
    writeFileSync(join(dir, '.next', '.version'), '9.9.9')
    applyPendingUpdate(dir)
    assert.equal(readFileSync(join(dir, 'agent.mjs'), 'utf8'), 'new-entry', 'the new entry took effect')
    assert.equal(readFileSync(join(dir, 'runtime.mjs'), 'utf8'), 'new-runtime', 'the new runtime took effect')
    assert.equal(readFileSync(join(dir, '.prev', 'agent.mjs'), 'utf8'), 'old-entry', 'the previous generation is kept (the rollback source)')
    assert.equal(readFileSync(join(dir, '.prev', 'runtime.mjs'), 'utf8'), 'old-runtime')
    assert.equal(currentAgentVersion(dir), '9.9.9', 'the version marker is persisted')
    assert.ok(!existsSync(join(dir, '.next')), '.next is consumed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Capability four M4-3: instant-crash rollback -- a restart within 90s + a swap less than 10 min ago -> the previous generation is restored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'upd-'))
  try {
    writeFileSync(join(dir, 'agent.mjs'), 'bad-entry')
    writeFileSync(join(dir, 'runtime.mjs'), 'bad-runtime')
    mkdirSync(join(dir, '.prev'), { recursive: true })
    writeFileSync(join(dir, '.prev', 'agent.mjs'), 'good-entry')
    writeFileSync(join(dir, '.prev', 'runtime.mjs'), 'good-runtime')
    writeFileSync(join(dir, '.update-at'), String(Date.now() - 60_000), 'utf8')
    writeFileSync(join(dir, '.update-version'), '9.9.9', 'utf8')
    writeFileSync(join(dir, '.last-boot'), String(Date.now() - 60_000), 'utf8')
    applyPendingUpdate(dir)
    assert.equal(readFileSync(join(dir, 'agent.mjs'), 'utf8'), 'good-entry', 'rolled back to the previous generation')
    assert.equal(readFileSync(join(dir, 'runtime.mjs'), 'utf8'), 'good-runtime')
    assert.ok(!existsSync(join(dir, '.update-at')), 'the update marker is cleared after a rollback')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Capability four M4-3: a normal restart does not roll back -- a swap longer than 10 min ago -> the new code is kept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'upd-'))
  try {
    writeFileSync(join(dir, 'agent.mjs'), 'new-entry')
    writeFileSync(join(dir, 'runtime.mjs'), 'new-runtime')
    mkdirSync(join(dir, '.prev'), { recursive: true })
    writeFileSync(join(dir, '.prev', 'agent.mjs'), 'good-entry')
    writeFileSync(join(dir, '.update-at'), String(Date.now() - 11 * 60_000), 'utf8')
    writeFileSync(join(dir, '.last-boot'), String(Date.now() - 60_000), 'utf8')
    applyPendingUpdate(dir)
    assert.equal(readFileSync(join(dir, 'agent.mjs'), 'utf8'), 'new-entry', 'past the window it is not misread as an instant crash')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
