# ADR-0002 · Two rules for the usage ledger (a missing rate is not zero / a month is local)

- Status: accepted (fixed in the `src/usage/store.ts` module comment on 2026-09-12)
- Code: `src/usage/store.ts`, `src/pricing.ts`

## Decision

1. **A missing rate is not zero.** Records whose model has no configured price are counted
   in `unpriced` and left out of the money totals. A total is therefore always reported as
   a floor *with a visible gap*, never as a confident number that happens to be too low.
   `SUM(cost)` skips NULL rows by nature — which is fine, but the sum itself cannot show
   whether anything is missing; that is what the `unpriced` counter exists for.
2. **A month is local.** Bucketing uses SQLite's `localtime` modifier (or the equivalent
   local-time half-open epoch range, debt B5). An evening run in UTC+8 lands in the month
   the operator thinks it did. The server's timezone is authoritative — one operator, one
   machine.

## Consequences

- The daily budget breaker depends on both rules. A guard that treats unknown cost as zero
  keeps spending while the bill is invisible — which is why `daySpend` returns `unpriced`
  and the caller (the cron scheduler) refuses to run on a non-zero gap instead of guessing.
- Index red line: bucket filters must hit the `usage_at` index (an `EXPLAIN` assertion in
  `query-plan.test.ts` guards it). No aggregation rewrite (the E9 drizzle-builder
  migration) may fall back to a full-table `strftime` scan.
