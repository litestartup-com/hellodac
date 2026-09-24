import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify } from 'yaml'
import { CONFIG_MIGRATIONS, CURRENT_CONFIG_VERSION, migrateConfigIfNeeded } from './migrations.js'

test('P0 回归: 迁移链覆盖 0..CURRENT 且逐级 +1（check-docs 同款断言）', () => {
  for (let v = 0; v < CURRENT_CONFIG_VERSION; v += 1) {
    assert.ok(CONFIG_MIGRATIONS.some((m) => m.from === v), `缺 ${v} → ${v + 1} 的迁移`)
  }
  for (const m of CONFIG_MIGRATIONS) {
    assert.equal(m.to, m.from + 1, `迁移 {from:${m.from},to:${m.to}} 必须是 +1 升链`)
  }
})

test('P0 回归: 老配置（无 config_version）迁移后盖上版本戳且原字段不动', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mig-'))
  const file = join(dir, 'c.yaml')
  const doc = { listen: { host: '127.0.0.1', port: 8080 }, endpoints: { A: { url: 'http://x' } } }
  writeFileSync(file, stringify(doc), 'utf8')
  const result = migrateConfigIfNeeded(file, doc)
  assert.equal(result.doc.config_version, 1)
  assert.deepEqual((result.doc as { listen: unknown }).listen, { host: '127.0.0.1', port: 8080 }, '原字段不动')
})

test('P0 回归: migrateConfigIfNeeded 写回 + 备份原文件 + 警告说明 + 幂等', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mig-file-'))
  const file = join(dir, 'config.yaml')
  writeFileSync(file, 'listen:\n  host: 127.0.0.1\n  port: 8080\nendpoints:\n  A:\n    url: http://x\n', 'utf8')
  const parsed = { listen: { host: '127.0.0.1', port: 8080 }, endpoints: { A: { url: 'http://x' } } }
  const result = migrateConfigIfNeeded(file, parsed)
  assert.match(result.warnings[0] ?? '', /migrated from version 0 to 1/)
  assert.match(readFileSync(file, 'utf8'), /config_version: 1/, '写回文件带版本戳')
  assert.ok(existsSync(`${file}.pre-mig.bak`), '原文件备份存在')
  assert.match(readFileSync(`${file}.pre-mig.bak`, 'utf8'), /listen:/, '备份是原文件')

  // 幂等：再跑一次 = 无副作用（不重写、不覆盖备份、无警告）
  const again = migrateConfigIfNeeded(file, { config_version: 1, ...parsed })
  assert.deepEqual(again.warnings, [])
})

test('P0 回归: 版本等于 CURRENT = 零副作用；版本超前 = fail-loud', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mig-cur-'))
  const file = join(dir, 'c.yaml')
  writeFileSync(file, 'config_version: 1\n', 'utf8')
  assert.deepEqual(migrateConfigIfNeeded(file, { config_version: CURRENT_CONFIG_VERSION }).warnings, [], 'CURRENT 不迁移')

  assert.throws(
    () => migrateConfigIfNeeded(file, { config_version: CURRENT_CONFIG_VERSION + 1 }),
    /newer than the supported/,
    '来自未来的配置大声拒绝',
  )
})
