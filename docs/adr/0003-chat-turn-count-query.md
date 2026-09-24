# ADR-0003 · The chat list counts turns with a second grouped query, not a correlated subquery

- Status: accepted (fixed by an incident post-mortem; incident in early 2026-09, behaviour
  unchanged since the fix)
- Code: `src/chat/store.ts`, `listChats`

## The incident

An earlier version put the turn count into a correlated subquery in the select list — the
"clever" spelling — and was **silently wrong**: drizzle rendered a column interpolated into
a raw `sql` fragment as a bare `"id"`, producing

```sql
... (SELECT COUNT(*) FROM run WHERE run.chat_id = "id") FROM chat
```

The inner table (`run`) wins name resolution and `run` has an `id` column of its own, so the
predicate silently became `run.chat_id = run.id`, which is never true. Every count came back
as 0, **with no error**: the identifier did resolve — to the wrong table.

## Decision

Turn counts are always fetched by a second grouped query and merged in memory. No correlated
subqueries in the select list; if a raw SQL fragment is unavoidable, every column reference
must carry an explicit table qualifier.

## Consequences

- This is the concrete case behind "an unqualified column name means a silently wrong
  answer" — one of the reasons the E9 aggregation migration moved to the drizzle builder
  (which qualifies columns for you). Any hand-written raw SQL keeps this rule.
