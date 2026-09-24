import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify } from 'yaml'
import { openDb } from '../db/index.js'
import { backfillCosts } from './backfill-cost.js'

/**
 * 债务 C2(重点):backfill-cost 是「写钱」的 CLI,此前零覆盖。
 * 红证:旧代码顶层直接执行 main() 且无 backfillCosts 导出(导入即炸/加载失败)。
 * 修复 = main 体抽成可注入路径的纯函数,isDirect 才执行(与 setup.ts 同模式)。
 */

// 债务 D5:loadConfig 的 env 校验要求 SESSION_SECRET——本地靠仓库根的 .env
// 掩盖,CI 干净 checkout 必炸(config.test/reconcile.test 同款兜底,此处补齐)。
if (process.env.SESSION_SECRET === undefined) process.env.SESSION_SECRET = 'x'.repeat(32)

const TEST_RATE_INPUT = 1 // 美元/百万 token
const TEST_RATE_OUTPUT = 2

const makeEnv = (): { dir: string; configPath: string; dbPath: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'backfill-'))
  const configPath = join(dir, 'manager.config.yaml')
  const dbPath = join(dir, 'manager.db')
  writeFileSync(
    configPath,
    stringify({
      listen: { host: '127.0.0.1', port: 8080 },
      endpoints: { A: { url: 'http://127.0.0.1:3080', driver: 'apiproxy' } },
      agents: { personal: { name: '个人', endpoint: 'A', workspace: dir } },
      database: { path: dbPath },
      pricing: {
        models: {
          'priced-model': { off_peak: { input: TEST_RATE_INPUT, output: TEST_RATE_OUTPUT } },
        },
      },
    }),
    'utf8',
  )
  return { dir, configPath, dbPath }
}

const seed = (dbPath: string): ReturnType<typeof openDb> => {
  const opened = openDb(dbPath)
  opened.sqlite
    .prepare(
      `INSERT INTO agent (id, name, workspace_path, endpoint, public, created_at)
       VALUES ('personal', '个人', '.', 'A', 0, 1750000000000)`,
    )
    .run()
  opened.sqlite
    .prepare(
      `INSERT INTO run (id, agent_id, trigger, state, started_at)
       VALUES ('r-priced', 'personal', 'manual', 'done', 1750000000000),
              ('r-unpriced', 'personal', 'manual', 'done', 1750000000000),
              ('r-done', 'personal', 'manual', 'done', 1750000000000)`,
    )
    .run()
  opened.sqlite
    .prepare(
      `INSERT INTO usage_record (run_id, provider, model, input_tokens, output_tokens, at)
       VALUES ('r-priced', 'p', 'priced-model', 1000, 2000, 1750000000000),
              ('r-unpriced', 'p', 'no-rate-model', 100, 200, 1750000000000),
              ('r-done', 'p', 'priced-model', 10, 20, 1750000000000)`,
    )
    .run()
  opened.sqlite.prepare(`UPDATE usage_record SET cost = 777, peak_cost = 0 WHERE run_id = 'r-done'`).run()
  return opened
}

test('债务 C2 回归: dry-run 不写;--apply 写入正确费用;无 rate 行跳过;已定价行不动', () => {
  const { dir, configPath, dbPath } = makeEnv()
  const opened = seed(dbPath)
  opened.sqlite.close()

  const dry = backfillCosts(configPath, false)
  assert.equal(dry.rows, 2, '只扫 cost IS NULL 的行(已定价行不在其中)')
  assert.equal(dry.priced, 1)
  assert.equal(dry.stillUnpriced, 1)
  {
    const { sqlite } = openDb(dbPath)
    const priced = sqlite.prepare(`SELECT cost FROM usage_record WHERE run_id = 'r-priced'`).get() as { cost: number | null }
    assert.equal(priced.cost, null, 'dry-run 绝不写钱')
    sqlite.close()
  }

  const applied = backfillCosts(configPath, true)
  assert.equal(applied.rows, 2)
  assert.equal(applied.priced, 1)
  assert.equal(applied.stillUnpriced, 1)
  {
    const { sqlite } = openDb(dbPath)
    const priced = sqlite.prepare(`SELECT cost, peak_cost FROM usage_record WHERE run_id = 'r-priced'`).get() as { cost: number; peak_cost: number }
    // off-peak:1000/1e6*1 + 2000/1e6*2 = 0.005 USD = 5000 micro-USD
    assert.equal(priced.cost, 5_000)
    assert.equal(priced.peak_cost, 0, '无峰值窗口 → peak_cost = 0')
    const unpriced = sqlite.prepare(`SELECT cost FROM usage_record WHERE run_id = 'r-unpriced'`).get() as { cost: number | null }
    assert.equal(unpriced.cost, null, '仍无 rate 的行绝不乱标')
    const done = sqlite.prepare(`SELECT cost FROM usage_record WHERE run_id = 'r-done'`).get() as { cost: number | null }
    assert.equal(done.cost, 777, '已定价的历史绝不重写')
    sqlite.close()
  }
  rmSync(dir, { recursive: true, force: true })
})

test('债务 C2 回归: 无未定价行时零操作', () => {
  const { dir, configPath, dbPath } = makeEnv()
  const opened = openDb(dbPath)
  opened.sqlite.prepare(`INSERT INTO agent (id, name, workspace_path, endpoint, public, created_at) VALUES ('personal', '个人', '.', 'A', 0, 1750000000000)`).run()
  opened.sqlite.prepare(`INSERT INTO run (id, agent_id, trigger, state, started_at) VALUES ('r-done2', 'personal', 'manual', 'done', 1750000000000)`).run()
  opened.sqlite.prepare(`INSERT INTO usage_record (run_id, provider, model, input_tokens, output_tokens, cost, at) VALUES ('r-done2', 'p', 'priced-model', 1, 2, 9, 1750000000000)`).run()
  opened.sqlite.close()
  const result = backfillCosts(configPath, true)
  assert.equal(result.rows, 0)
  assert.equal(result.priced, 0)
  rmSync(dir, { recursive: true, force: true })
})
