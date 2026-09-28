import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getTableColumns, getTableName } from 'drizzle-orm'
import { openDb, schema } from './index.js'

/**
 * Debt B3: the hand-written SQL migrations and the drizzle schema are two parallel definitions that
 * only comments keep in sync. This test runs all migrations on an empty database and compares it
 * table by table, column by column against the drizzle schema; either side out of sync turns it red
 * (seen red first: a temporary fake column on schema.user makes it fail).
 */

const SQLITE_TYPES: Record<string, string> = {
  string: 'TEXT',
  number: 'INTEGER',
  boolean: 'INTEGER',
  json: 'TEXT',
  buffer: 'BLOB',
  bigint: 'INTEGER',
}

test('Debt B3 regression: migration output and the drizzle schema agree table by table, column by column', () => {
  const { sqlite } = openDb(':memory:')

  const tables = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>
  const tableNames = new Set(tables.map((t) => t.name))

  for (const table of Object.values(schema)) {
    const tableName = getTableName(table)
    assert.ok(tableNames.has(tableName), `drizzle schema table ${tableName} was never created by the migrations (missing table)`)
    const actual = new Map<string, string>()
    for (const row of sqlite.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string; type: string }>) {
      actual.set(row.name, row.type.toUpperCase())
    }
    for (const column of Object.values(getTableColumns(table))) {
      const expected = SQLITE_TYPES[column.dataType] ?? 'TEXT'
      assert.ok(actual.has(column.name), `table ${tableName} is missing column ${column.name} (missing column)`)
      assert.equal(
        actual.get(column.name),
        expected,
        `type drift on ${tableName}.${column.name}: migration=${actual.get(column.name)} schema=${expected}`,
      )
    }
    // The other direction too: an extra migrated column must be reported (absent from the drizzle schema = queries never see it)
    const expectedCols = new Set(Object.values(getTableColumns(table)).map((c) => c.name))
    for (const [col] of actual) {
      if (!expectedCols.has(col)) assert.fail(`table ${tableName} has an extra migrated column ${col} that the drizzle schema does not declare (future queries will miss it)`)
    }
  }

  // The migration system's own schema_version table is not a business table, but it must exist
  assert.ok(tableNames.has('schema_version'), 'the schema_version table is missing')
})
