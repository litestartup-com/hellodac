import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify } from 'yaml'
import { openDb } from '../db/index.js'
import { backfillCosts } from './backfill-cost.js'

/**
 * Debt C2 (the important one): backfill-cost is a CLI that writes money, and it had zero coverage.
 * Red proof: the old code ran main() at the top level and exported no backfillCosts (importing it blew up / failed to load).
 * The fix = the body of main became a pure function with an injectable path, executed only under isDirect (the same pattern as setup.ts).
 */

// Debt D5: loadConfig's env validation requires SESSION_SECRET -- the .env at the repo root hides that
// locally, and a clean CI checkout blows up (the same fallback as config.test/reconcile.test, added here).
if (process.env.SESSION_SECRET === undefined) process.env.SESSION_SECRET = 'x'.repeat(32)

const TEST_RATE_INPUT = 1 // dollars per million tokens
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
      agents: { personal: { name: 'Personal', endpoint: 'A', workspace: dir } },
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
       VALUES ('personal', 'Personal', '.', 'A', 0, 1750000000000)`,
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

test('Debt C2 regression: dry-run writes nothing; --apply writes the right cost; rows without a rate are skipped; already priced rows stay put', () => {
  const { dir, configPath, dbPath } = makeEnv()
  const opened = seed(dbPath)
  opened.sqlite.close()

  const dry = backfillCosts(configPath, false)
  assert.equal(dry.rows, 2, 'only rows with cost IS NULL are scanned (priced rows are not among them)')
  assert.equal(dry.priced, 1)
  assert.equal(dry.stillUnpriced, 1)
  {
    const { sqlite } = openDb(dbPath)
    const priced = sqlite.prepare(`SELECT cost FROM usage_record WHERE run_id = 'r-priced'`).get() as { cost: number | null }
    assert.equal(priced.cost, null, 'dry-run never writes money')
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
    assert.equal(priced.peak_cost, 0, 'no peak window -> peak_cost = 0')
    const unpriced = sqlite.prepare(`SELECT cost FROM usage_record WHERE run_id = 'r-unpriced'`).get() as { cost: number | null }
    assert.equal(unpriced.cost, null, 'a row still without a rate is never given a made-up cost')
    const done = sqlite.prepare(`SELECT cost FROM usage_record WHERE run_id = 'r-done'`).get() as { cost: number | null }
    assert.equal(done.cost, 777, 'already priced history is never rewritten')
    sqlite.close()
  }
  rmSync(dir, { recursive: true, force: true })
})

test('Debt C2 regression: no unpriced rows means no operation at all', () => {
  const { dir, configPath, dbPath } = makeEnv()
  const opened = openDb(dbPath)
  opened.sqlite.prepare(`INSERT INTO agent (id, name, workspace_path, endpoint, public, created_at) VALUES ('personal', 'Personal', '.', 'A', 0, 1750000000000)`).run()
  opened.sqlite.prepare(`INSERT INTO run (id, agent_id, trigger, state, started_at) VALUES ('r-done2', 'personal', 'manual', 'done', 1750000000000)`).run()
  opened.sqlite.prepare(`INSERT INTO usage_record (run_id, provider, model, input_tokens, output_tokens, cost, at) VALUES ('r-done2', 'p', 'priced-model', 1, 2, 9, 1750000000000)`).run()
  opened.sqlite.close()
  const result = backfillCosts(configPath, true)
  assert.equal(result.rows, 0)
  assert.equal(result.priced, 0)
  rmSync(dir, { recursive: true, force: true })
})
