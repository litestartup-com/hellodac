---
name: brain-api
description: The execution manual for manager's internal REST API -- check each agent's status, dispatch work, read the dashboard, read spend, draft scheduled tasks. Use it when you need to observe the whole fleet or hand work to another agent.
---

# brain-api: manager's internal REST API (the brain's execution manual)

## Prerequisites

- manager address: use the environment variable `$MANAGER_URL` (bash) / `$env:MANAGER_URL` (pwsh).
  A bare-metal deployment defaults to `http://127.0.0.1:8080`; under a container deployment the node process already has `http://manager:8080` preset.
  **Never guess the address yourself -- use the variable.**
- Auth token: **the DSH tool sandbox strips every environment variable whose name contains TOKEN/KEY** (an upstream safety design),
  so `BRAIN_TOKEN` can never be read inside a command -- manager/the node presets the token in the **node user's HOME at
  `~/.brain-auth`** (0600, not in the workspace, not in git). Read it before every call:
  - bash: `TOKEN=$(cat "$HOME/.brain-auth")`
  - pwsh: `$token = (Get-Content "$HOME\.brain-auth" -Raw).Trim()`
  Send it in the header as `X-Brain-Token: $TOKEN` (bash) / `X-Brain-Token: $token` (pwsh).
  **Read only -- never print it, never copy it, never write it into any other file.**
- How to read the error codes:
  - `401` = wrong token (check the header spelling; do not print the token)
  - `403` = not from the private network (should not happen)
  - `409` = manager refused the dispatch -- **read `detail` and relay it to the user verbatim; never retry by force**. Two common kinds:
    - `brain_budget_exhausted` = the brain's dispatch budget for today is used up (it resets automatically tomorrow); tell the user "today's dispatch allowance is gone, you can go to that agent and do it manually instead".
    - `not_managed`/anything else = see the `detail` text.
  - `404` = target does not exist (misspelled agent/chat name)
  - `400` = bad request body or cron expression -- read `detail` and fix it

## Call pattern: write the JSON to a file, then curl -- never hand-build a long JSON

bash (Linux / macOS / Git Bash):

```bash
TOKEN=$(cat "$HOME/.brain-auth")
cat > /tmp/req.json <<'EOF'
{"agentId":"personal","prompt":"summarise the expenses of this week into the weekly report"}
EOF
curl -s -X POST "$MANAGER_URL/api/internal/dispatch" \
  -H 'Content-Type: application/json' \
  -H "X-Brain-Token: $TOKEN" \
  --data @/tmp/req.json
```

pwsh (Windows):

```powershell
$token = (Get-Content "$HOME\.brain-auth" -Raw).Trim()
@{ agentId='personal'; prompt='summarise the expenses of this week into the weekly report' } |
  ConvertTo-Json | Set-Content "$env:TEMP\req.json" -Encoding utf8
curl.exe -s -X POST "$env:MANAGER_URL/api/internal/dispatch" `
  -H 'Content-Type: application/json' `
  -H "X-Brain-Token: $token" `
  --data "@$env:TEMP\req.json"
```

GET requests go straight to curl; no file needed.

## Endpoint cheat sheet

| Endpoint | Purpose | Key response fields |
| --- | --- | --- |
| `GET /api/internal/agents` | Status of every agent | `agents[]`: `id`/`name`/`busy`/`runningRunId`/`chatCount`/`spendMicroUsd` |
| `GET /api/internal/agents/:id` | One agent in detail | `preset`/`sandboxMode`/`endpoint`/`recentRuns` |
| `GET /api/internal/agents/:id/board` | Read-only dashboard | `pages`/`blocks` (board JSON) |
| `GET /api/internal/usage` | This month's spend | `totals`/`byAgent`/`byModel` (in micro-USD, 1e6 = $1) |
| `GET /api/internal/agents/:id/chats` | Chat list | `chats[]`: `id`/`title`/`turns` |
| `GET /api/internal/chats/:id/summary` | Chat summary | `title`/`state`/`turns`/`lastRun` |
| `POST /api/internal/dispatch` | Dispatch (waits synchronously for the result, may take minutes) | body `{agentId, prompt, sourceChatId?}` → `{runId, state, summary, costMicroUsd, error}` |
| `POST /api/internal/crons` | Draft a scheduled task | body `{agentId, name, schedule, timezone?, prompt}` → **disabled by default**, remind the user to confirm |

## Typical flow

1. **Check status and budget first**: `GET /api/internal/agents`. In the response, `brainBudget` (may be null = unlimited) is your remaining dispatch budget for the day; `agents[].activeRuns` is the number of turns in flight per agent (dispatching several jobs to the same agent is allowed, so never refuse because of busy). If the budget is bottomed out, do not dispatch -- tell the user plainly.
2. **Dispatch**: `POST /api/internal/dispatch`; in the body, set `sourceChatId` to the id of your current chat (the user interface supplies it; omit it if there is none).
   - `state=done` → report back to the user with `summary`, citing `runId`;
   - `state=failed` → read `error` and relay it; do not retry automatically;
   - `409` (such as `brain_budget_exhausted`) → relay `detail`; do not force your way in.
3. **Reusing chats (continue vs create)**:
   - First `GET /api/internal/agents/:id/chats` to see that agent's chat list (title + turn count).
   - **Same kind of task** (the title matches -- for example they are all "weekly report") → `POST /api/internal/chats/:chatId/prompt`, body `{text}`, continuing the most recent chat with that name;
   - **An empty chat** (turns=0) is a free slot -- prefer reusing it;
   - The user says it is a "new task", or no chat fits → create one with `dispatch`.
   - The prompt returns `{runId, state, summary, error}` synchronously; `409 chat_busy` = that chat is running, try again later.
4. **Drafting a scheduled task**: `POST /api/internal/crons` → once it succeeds, say "drafted -- please confirm and enable it on the scheduled-tasks page". The schedule is a 5-field cron expression (minute hour day month weekday), timezone defaults to `Asia/Shanghai`.
5. **Reading the dashboard**: `GET /api/internal/agents/personal/board` -- answer the user directly with the numbers in the response.
6. **Reading the spend**: `GET /api/internal/usage` -- mind the micro-USD conversion (1e6 micro-USD = $1).

## Dispatch criteria (same as AGENTS.md)

The node list is this workspace's `fleet.md` (generated by manager); personal = notes/expenses/health/trading/weekly report;
company = strategy/OKR/meetings/projects; product = blog/docs/changelog/email. Ask the user about a name that is not on the list; do not guess.
