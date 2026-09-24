import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getTableColumns, getTableName } from 'drizzle-orm'
import { openDb, schema } from './index.js'

/**
 * 债务 B3:手写 SQL 迁移与 drizzle schema 是两份平行定义,只有注释约束同步。
 * 本测试 = 空库跑完全部迁移后,与 drizzle schema 逐表逐列比对——
 * 任何一侧漏同步即红(先红验证:临时给 schema.user 加假列,本测试必红)。
 */

const SQLITE_TYPES: Record<string, string> = {
  string: 'TEXT',
  number: 'INTEGER',
  boolean: 'INTEGER',
  json: 'TEXT',
  buffer: 'BLOB',
  bigint: 'INTEGER',
}

test('债务 B3 回归: 迁移产物与 drizzle schema 逐表逐列一致', () => {
  const { sqlite } = openDb(':memory:')

  const tables = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>
  const tableNames = new Set(tables.map((t) => t.name))

  for (const table of Object.values(schema)) {
    const tableName = getTableName(table)
    assert.ok(tableNames.has(tableName), `drizzle schema 表 ${tableName} 未在迁移中创建(迁移漏表)`)
    const actual = new Map<string, string>()
    for (const row of sqlite.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string; type: string }>) {
      actual.set(row.name, row.type.toUpperCase())
    }
    for (const column of Object.values(getTableColumns(table))) {
      const expected = SQLITE_TYPES[column.dataType] ?? 'TEXT'
      assert.ok(actual.has(column.name), `表 ${tableName} 缺列 ${column.name}(迁移漏列)`)
      assert.equal(
        actual.get(column.name),
        expected,
        `表 ${tableName}.${column.name} 类型漂移:迁移=${actual.get(column.name)} schema=${expected}`,
      )
    }
    // 反向:迁移多出的列也要报(drizzle schema 漏列 = 查询拿不到该列)
    const expectedCols = new Set(Object.values(getTableColumns(table)).map((c) => c.name))
    for (const [col] of actual) {
      if (!expectedCols.has(col)) assert.fail(`表 ${tableName} 迁移多出列 ${col},drizzle schema 未声明(未来查询会漏掉它)`)
    }
  }

  // 迁移系统自身的 schema_version 表不算业务表,但必须存在
  assert.ok(tableNames.has('schema_version'), 'schema_version 表缺失')
})
