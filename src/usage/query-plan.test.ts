import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../db/index.js'
import { dayRangeMs, monthRangeMs } from '../usage/store.js'

/**
 * Debt B5: usage aggregation bucketed and filtered everything with strftime -> the usage_at index went unused and
 * the whole table was scanned; brainSpendToday pulled rows into JS to sum them. The fix = epoch range filtering (uses
 * the index) + pushing the sum down into SQL. Red proof: the old code exported no monthRangeMs/dayRangeMs (this file
 * failed to load); after the fix the assertions below prove "range filter -> SEARCH on the index" vs "strftime -> SCAN".
 */

test('Debt B5 regression: the month/day range helpers turn local buckets into epoch half-open intervals', () => {
  const m = monthRangeMs('2026-09')
  assert.equal(m.start, new Date(2026, 8, 1).getTime(), 'local September 1, 00:00')
  assert.equal(m.end, new Date(2026, 9, 1).getTime(), 'local October 1, 00:00 (half-open upper bound)')
  const d = dayRangeMs('2026-09-30')
  assert.equal(d.start, new Date(2026, 8, 30).getTime())
  assert.equal(d.end, new Date(2026, 9, 1).getTime())
})

test('Debt B5 regression: range filtering uses the usage_at index while the strftime form really does scan the whole table (red baseline)', () => {
  const { sqlite } = openDb(':memory:')
  const scan = sqlite
    .prepare("EXPLAIN QUERY PLAN SELECT 1 FROM usage_record WHERE strftime('%Y-%m', at / 1000, 'unixepoch', 'localtime') = '2026-09'")
    .all()
  assert.match(JSON.stringify(scan), /SCAN/, 'strftime bucketing must be reported as a full table scan (otherwise the comparison baseline is meaningless)')

  const seek = sqlite
    .prepare('EXPLAIN QUERY PLAN SELECT 1 FROM usage_record WHERE at >= 1751328000000 AND at < 1754006400000')
    .all()
  assert.match(JSON.stringify(seek), /SEARCH .*usage_at|USING INDEX usage_at/, 'epoch range filtering must hit the usage_at index')
})

test('Debt B5 regression: the brain dispatch daily bill uses the run(trigger, started_at) index', () => {
  const { sqlite } = openDb(':memory:')
  const plan = sqlite
    .prepare("EXPLAIN QUERY PLAN SELECT COALESCE(SUM(cost), 0) FROM usage_record JOIN run ON run.id = usage_record.run_id WHERE run.trigger = 'brain' AND usage_record.at >= 1751328000000")
    .all()
  assert.match(JSON.stringify(plan), /SEARCH .*run_trigger_started|USING INDEX run_trigger_started/, 'the brain daily bill must hit the run(trigger, started_at) index')
})
