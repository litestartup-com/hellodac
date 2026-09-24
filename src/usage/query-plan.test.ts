import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../db/index.js'
import { dayRangeMs, monthRangeMs } from '../usage/store.js'

/**
 * 债务 B5:usage 聚合此前全部 strftime 分桶过滤 → usage_at 索引用不上,全表扫;
 * brainSpendToday 把行拉到 JS 里求和。修复 = epoch 范围过滤(走索引)+ 求和下推 SQL。
 * 红证:旧代码无 monthRangeMs/dayRangeMs 导出(本文件加载失败);修复后以下断言
 * 证明「范围过滤 → SEARCH 索引」而「strftime → SCAN 全表扫」。
 */

test('债务 B5 回归: 月/日范围函数把本地分桶换算成 epoch 半开区间', () => {
  const m = monthRangeMs('2026-09')
  assert.equal(m.start, new Date(2026, 8, 1).getTime(), '本地 9 月 1 日 00:00')
  assert.equal(m.end, new Date(2026, 9, 1).getTime(), '本地 10 月 1 日 00:00(半开上界)')
  const d = dayRangeMs('2026-09-30')
  assert.equal(d.start, new Date(2026, 8, 30).getTime())
  assert.equal(d.end, new Date(2026, 9, 1).getTime())
})

test('债务 B5 回归: 范围过滤走 usage_at 索引,strftime 写法确实全表扫(对照红基线)', () => {
  const { sqlite } = openDb(':memory:')
  const scan = sqlite
    .prepare("EXPLAIN QUERY PLAN SELECT 1 FROM usage_record WHERE strftime('%Y-%m', at / 1000, 'unixepoch', 'localtime') = '2026-09'")
    .all()
  assert.match(JSON.stringify(scan), /SCAN/, 'strftime 分桶必须被判定为全表扫(否则对照基线失真)')

  const seek = sqlite
    .prepare('EXPLAIN QUERY PLAN SELECT 1 FROM usage_record WHERE at >= 1751328000000 AND at < 1754006400000')
    .all()
  assert.match(JSON.stringify(seek), /SEARCH .*usage_at|USING INDEX usage_at/, 'epoch 范围过滤必须命中 usage_at 索引')
})

test('债务 B5 回归: brain 派工日账单走 run(trigger, started_at) 索引', () => {
  const { sqlite } = openDb(':memory:')
  const plan = sqlite
    .prepare("EXPLAIN QUERY PLAN SELECT COALESCE(SUM(cost), 0) FROM usage_record JOIN run ON run.id = usage_record.run_id WHERE run.trigger = 'brain' AND usage_record.at >= 1751328000000")
    .all()
  assert.match(JSON.stringify(plan), /SEARCH .*run_trigger_started|USING INDEX run_trigger_started/, 'brain 日账单必须命中 run(trigger, started_at) 索引')
})
