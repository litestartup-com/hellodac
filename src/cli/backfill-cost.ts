import { pathToFileURL } from 'node:url'
import { loadConfig } from '../config.js'
import { openDb } from '../db/index.js'
import { computeCost, formatMicroUsd } from '../pricing.js'

/**
 * Prices `usage_record` rows that were written before their model had a rate.
 *
 * Normally cost is recorded at run time and never recomputed, so that a later
 * price change cannot rewrite history. This is the one deliberate exception:
 * these rows have no cost at all, and a row with no cost is not history worth
 * protecting.
 *
 * Two honest limits, both reported rather than hidden:
 *
 * - the pricing instant is `at`, the moment the run ended, so a turn that
 *   straddled a peak boundary is approximated by its ending side
 * - rows whose model still has no configured rate are left alone
 *
 * Dry run unless `--apply` is passed. Writing money figures is not something to
 * do as a side effect of curiosity.
 *
 * 债务 C2:main 体抽成可注入 configPath 的纯函数(写钱逻辑必须有测试);
 * 顶层只在直接执行时运行(与 setup.ts 同模式)。
 */

export interface BackfillResult {
  rows: number
  priced: number
  stillUnpriced: number
  total: number
}

export const backfillCosts = (configPath: string, apply: boolean): BackfillResult => {
  const config = loadConfig(configPath)
  const { db, sqlite } = openDb(config.databasePath)

  const rows = sqlite
    .prepare(
      `SELECT id, provider, model, input_tokens, output_tokens, cache_read, cache_write, at
       FROM usage_record WHERE cost IS NULL ORDER BY at ASC`,
    )
    .all() as {
    id: number
    provider: string | null
    model: string | null
    input_tokens: number
    output_tokens: number
    cache_read: number | null
    cache_write: number | null
    at: number
  }[]

  if (rows.length === 0) {
    console.log('no unpriced usage records; nothing to do')
    db.$client.close()
    return { rows: 0, priced: 0, stillUnpriced: 0, total: 0 }
  }

  const update = sqlite.prepare('UPDATE usage_record SET cost = ?, peak_cost = ? WHERE id = ?')
  let priced = 0
  let stillUnpriced = 0
  let total = 0

  const run = sqlite.transaction(() => {
    for (const row of rows) {
      const cost = computeCost(
        {
          inputTokens: row.input_tokens,
          outputTokens: row.output_tokens,
          ...(row.cache_read === null ? {} : { cacheReadTokens: row.cache_read }),
          ...(row.cache_write === null ? {} : { cacheWriteTokens: row.cache_write }),
        },
        row.provider,
        row.model,
        row.at,
        config.pricing,
      )

      if (cost === null) {
        stillUnpriced += 1
        console.log(`  skip  #${row.id}  ${row.provider ?? '?'}/${row.model ?? '?'}  (no configured rate)`)
        continue
      }

      priced += 1
      total += cost.microUsd
      const when = new Date(row.at).toISOString()
      console.log(
        `  price #${row.id}  ${row.model ?? '?'}  ${when}  ${cost.peak ? 'peak' : 'off-peak'}  ${formatMicroUsd(cost.microUsd)}`,
      )
      if (apply) update.run(cost.microUsd, cost.peak ? cost.microUsd : 0, row.id)
    }
  })
  run()

  console.log('')
  console.log(`${rows.length} unpriced record(s): ${priced} priced, ${stillUnpriced} still without a rate`)
  console.log(`total: ${formatMicroUsd(total)}`)
  if (!apply) console.log('\ndry run -- pass --apply to write these values')

  db.$client.close()
  return { rows: rows.length, priced, stillUnpriced, total }
}

const isDirect = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirect) backfillCosts('manager.config.yaml', process.argv.includes('--apply'))
