---
name: brain-api
description: manager 内部 REST API 执行手册——查各 agent 状态、派工、看大盘、读花费、起草定时任务。当你需要观察整个 fleet 或派活给其他 agent 时使用。
---

# brain-api：manager 内部 REST API（主脑执行手册）

## 前置

- manager 地址：用环境变量 `$MANAGER_URL`（bash）/ `$env:MANAGER_URL`（pwsh）。
  裸机部署默认 `http://127.0.0.1:8080`；容器部署下节点进程里已预置为 `http://manager:8080`。
  **不要自己猜地址，直接用变量。**
- 鉴权令牌：**DSH 的工具沙箱会洗掉一切 TOKEN/KEY 字样环境变量**（上游安全设计），
  所以 `BRAIN_TOKEN` 在命令里永远取不到 —— 令牌由 manager/节点预置在**节点用户 HOME 的
  `~/.brain-auth` 文件**（0600，不进工作区、不进 git）。每次调用前先读它：
  - bash：`TOKEN=$(cat "$HOME/.brain-auth")`
  - pwsh：`$token = (Get-Content "$HOME\.brain-auth" -Raw).Trim()`
  头部用 `X-Brain-Token: $TOKEN`（bash）/ `X-Brain-Token: $token`（pwsh）。
  **只读不打印、不复制、不写进任何别的文件。**
- 错误码读法：
  - `401` = token 不对（检查头部拼写，不打印 token）
  - `403` = 非私网来源（不应发生）
  - `409` = 派工被 manager 拒绝——**读 `detail` 原样转述给用户，不重试硬闯**。常见两类：
    - `brain_budget_exhausted` = 主脑今日派工预算已用完（明天自动恢复）；告诉用户「今日派工额度用完了，可以自己直接去对应 agent 手动操作」。
    - `not_managed`/其他 = 见 detail 原文。
  - `404` = 目标不存在（agent/chat 名写错）
  - `400` = 请求体或 cron 表达式有误——读 `detail` 修正

## 调用模式：先写 JSON 文件，再 curl，绝不手拼长 JSON

bash（Linux / macOS / Git Bash）：

```bash
TOKEN=$(cat "$HOME/.brain-auth")
cat > /tmp/req.json <<'EOF'
{"agentId":"personal","prompt":"把这周开销汇总写进周报"}
EOF
curl -s -X POST "$MANAGER_URL/api/internal/dispatch" \
  -H 'Content-Type: application/json' \
  -H "X-Brain-Token: $TOKEN" \
  --data @/tmp/req.json
```

pwsh（Windows）：

```powershell
$token = (Get-Content "$HOME\.brain-auth" -Raw).Trim()
@{ agentId='personal'; prompt='把这周开销汇总写进周报' } |
  ConvertTo-Json | Set-Content "$env:TEMP\req.json" -Encoding utf8
curl.exe -s -X POST "$env:MANAGER_URL/api/internal/dispatch" `
  -H 'Content-Type: application/json' `
  -H "X-Brain-Token: $token" `
  --data "@$env:TEMP\req.json"
```

GET 类请求直接 curl，不需要文件。

## 端点速查

| 端点 | 用途 | 关键返回 |
| --- | --- | --- |
| `GET /api/internal/agents` | 各 agent 状态 | `agents[]`：`id`/`name`/`busy`/`runningRunId`/`chatCount`/`spendMicroUsd` |
| `GET /api/internal/agents/:id` | 单 agent 详情 | `preset`/`sandboxMode`/`endpoint`/`recentRuns` |
| `GET /api/internal/agents/:id/board` | 只读大盘 | `pages`/`blocks`（board JSON） |
| `GET /api/internal/usage` | 本月花费 | `totals`/`byAgent`/`byModel`（单位微美元，1e6 = $1） |
| `GET /api/internal/agents/:id/chats` | 会话列表 | `chats[]`：`id`/`title`/`turns` |
| `GET /api/internal/chats/:id/summary` | 会话摘要 | `title`/`state`/`turns`/`lastRun` |
| `POST /api/internal/dispatch` | 派工（同步等结果，可能几分钟） | body `{agentId, prompt, sourceChatId?}` → `{runId, state, summary, costMicroUsd, error}` |
| `POST /api/internal/crons` | 起草定时任务 | body `{agentId, name, schedule, timezone?, prompt}` → **默认停用**，提醒用户去确认 |

## 典型流程

1. **先查状态与预算**：`GET /api/internal/agents`。返回里 `brainBudget`（可能为 null=不限额）是你的日派工预算余量；`agents[].activeRuns` 是各 agent 进行中的回合数（同 agent 多派工是允许的，无需因 busy 拒绝）。预算见底就别派，如实告诉用户。
2. **派工**：`POST /api/internal/dispatch`，body 里 `sourceChatId` 填你当前会话的 id（用户界面会提供；没有就省略）。
   - `state=done` → 用 `summary` 回报用户，引用 `runId`；
   - `state=failed` → 读 `error` 转述，不自动重试；
   - `409`（如 `brain_budget_exhausted`）→ 转述 `detail`，不硬闯。
3. **会话复用（续接 vs 新建）**：
   - 先 `GET /api/internal/agents/:id/chats` 看该 agent 的会话列表（标题 + 回合数）。
   - **同类任务**（标题命中，如都是「周报」）→ `POST /api/internal/chats/:chatId/prompt`，body `{text}`，续最近一条同名会话；
   - **空会话**（turns=0）是免费槽位，优先复用；
   - 用户明说「新任务」或没有合适会话 → 用 `dispatch` 新建。
   - prompt 同步返回 `{runId, state, summary, error}`；`409 chat_busy` = 该会话正在跑，稍后再试。
4. **起草定时任务**：`POST /api/internal/crons` → 成功后说「已起草，请在定时任务页确认启用」。schedule 是 5 段 cron 表达式（分 时 日 月 周），时区默认 `Asia/Shanghai`。
5. **看大盘**：`GET /api/internal/agents/personal/board`，直接引用返回里的数字回答用户。
6. **看花费**：`GET /api/internal/usage`，注意微美元换算（1e6 微美元 = $1）。

## 派工判据（与 AGENTS.md 一致）

节点清单以本工作区 `fleet.md`（manager 生成）为准；个人 = 笔记/记账/健康/交易/周报；
企业 = 战略/OKR/会议/项目；产品 = 博客/文档/changelog/邮件。清单外的名字先问用户，不猜。
