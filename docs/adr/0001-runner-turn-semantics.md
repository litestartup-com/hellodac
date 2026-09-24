# ADR-0001 · Turn-driving semantics (subscribe before send / bill only live frames / price per response / release the session)

- Status: accepted (fixed in review comments on 2026-09-12; behaviour unchanged since 0.1.1)
- Code: `src/runner.ts`, `src/runner/turn.ts`, `src/gateway/stream.ts`

## Context

How an agent turn is driven decides what gets billed, what gets relayed, and when the
session slot is returned. The early implementation carried this argument as a 35-line
design essay in the `runAgent` module comment: same lifetime as the code, drifting with
every refactor. After the E1 runner split the conclusions were fixed here, leaving one
line in the source that points at this file.

## Decision

1. **Subscribe before sending.** The stream must be subscribed before `prompt` /
   `sendMessage`. The gateway's `hello` frame replays the entire persisted history — a
   late subscriber cannot tell replay from live, and only live frames represent this
   turn's real consumption.
2. **Bill only live frames.** Usage accumulates from live `message` frames only. Counting
   the `hello` history would re-bill every earlier turn on each continuation, growing
   linearly with the length of the session.
3. **Price per response.** Each response is priced at its own moment, not once at the end
   of the turn. DeepSeek prices in peak/off-peak bands, and a long turn can cross a band
   boundary — a single end timestamp puts the whole turn on the wrong side of the clock.
4. **Release the session, do not delete it.** One-shot turns (cron, manual, capture)
   release their gateway slot by default; keeping it (`keepSession`) is an explicit
   requirement of conversational turns. The gateway's `maxSessions` is a hard ceiling, so
   one-shot turns that never release eventually block every conversation. Release does not
   delete the transcript: the session stays readable and can be adopted again.
5. **Silence timeout ≠ total timeout.** The total timeout must be generous (a normal turn
   can legitimately run 20 minutes); the silence timeout is the backstop — a working turn
   keeps emitting frames (deltas, tool calls), so a long stretch with no frames means
   "stuck", not "slow", typically waiting on an interactive question nobody can answer.
   They are independent: neither substitutes for the other, the silence backstop pauses
   while a human answer is pending (`awaitingHuman > 0`), and the total timeout still
   bounds everything.

## Consequences

- Billing correctness depends on telling `hello` apart from live. Any change to the frame
  path (the E8 zod discrimination, the E1 frame handlers) must preserve the
  "replayed history is never billed again / only live frames are relayed" cases in the
  runner and chat suites.
- A failure on the release path is only warned about, never allowed to swallow the turn
  result: the turn ran, the money was spent, and the result must not be lost to a cleanup
  error.
