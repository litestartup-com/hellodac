import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify } from 'yaml'
import { CONFIG_MIGRATIONS, CURRENT_CONFIG_VERSION, migrateConfigIfNeeded } from './migrations.js'

test('P0 regression: the migration chain covers 0..CURRENT and steps +1 at each level (the same assertion as check-docs)', () => {
  for (let v = 0; v < CURRENT_CONFIG_VERSION; v += 1) {
    assert.ok(CONFIG_MIGRATIONS.some((m) => m.from === v), `missing the migration ${v} -> ${v + 1}`)
  }
  for (const m of CONFIG_MIGRATIONS) {
    assert.equal(m.to, m.from + 1, `migration {from:${m.from},to:${m.to}} must be a +1 ascending link`)
  }
})

test('P0 regression: an old config (no config_version) gets a version stamp after migration and its original fields stay put', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mig-'))
  const file = join(dir, 'c.yaml')
  const doc = { listen: { host: '127.0.0.1', port: 8080 }, endpoints: { A: { url: 'http://x' } } }
  writeFileSync(file, stringify(doc), 'utf8')
  const result = migrateConfigIfNeeded(file, doc)
  assert.equal(result.doc.config_version, 1)
  assert.deepEqual((result.doc as { listen: unknown }).listen, { host: '127.0.0.1', port: 8080 }, 'the original fields stay put')
})

test('P0 regression: migrateConfigIfNeeded writes back + backs up the original file + explains with a warning + is idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mig-file-'))
  const file = join(dir, 'config.yaml')
  writeFileSync(file, 'listen:\n  host: 127.0.0.1\n  port: 8080\nendpoints:\n  A:\n    url: http://x\n', 'utf8')
  const parsed = { listen: { host: '127.0.0.1', port: 8080 }, endpoints: { A: { url: 'http://x' } } }
  const result = migrateConfigIfNeeded(file, parsed)
  assert.match(result.warnings[0] ?? '', /migrated from version 0 to 1/)
  assert.match(readFileSync(file, 'utf8'), /config_version: 1/, 'the written-back file carries the version stamp')
  assert.ok(existsSync(`${file}.pre-mig.bak`), 'the backup of the original file exists')
  assert.match(readFileSync(`${file}.pre-mig.bak`, 'utf8'), /listen:/, 'the backup is the original file')

  // Idempotent: running it again has no side effects (no rewrite, no backup overwrite, no warning)
  const again = migrateConfigIfNeeded(file, { config_version: 1, ...parsed })
  assert.deepEqual(again.warnings, [])
})

test('P0 regression: a version equal to CURRENT = zero side effects; a version ahead = fail-loud', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mig-cur-'))
  const file = join(dir, 'c.yaml')
  writeFileSync(file, 'config_version: 1\n', 'utf8')
  assert.deepEqual(migrateConfigIfNeeded(file, { config_version: CURRENT_CONFIG_VERSION }).warnings, [], 'CURRENT is not migrated')

  assert.throws(
    () => migrateConfigIfNeeded(file, { config_version: CURRENT_CONFIG_VERSION + 1 }),
    /newer than the supported/,
    'a config from the future is refused loudly',
  )
})
