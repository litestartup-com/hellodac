# 探针 v4：提问 → 轮询 pendingIds → 从会话日志取真实问题 id → respond 回答 → 断言回合完成。
$ErrorActionPreference = 'Stop'
$envFile = Join-Path $PSScriptRoot '..\.env'
$key = ((Get-Content $envFile | Where-Object { $_ -like 'GW_KEY_A=*' }) -replace '^GW_KEY_A=', '')
$base = 'http://127.0.0.1:3081/api-gw/v1/proxy'
$headers = @{ 'X-API-Key' = $key }

function Invoke-Rpc([string]$method, $payload) {
  $body = @{ rpcId = ('r' + [guid]::NewGuid().ToString('N').Substring(0,12)); method = $method; payload = $payload } | ConvertTo-Json -Depth 8
  return Invoke-RestMethod -Uri "$base/$method" -Method Post -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 60
}

$created = Invoke-Rpc 'session.create' @{ cwd = 'C:\Workplace\gitee\note-kaka' }
$sessionId = $created.result.value.sessionId
Write-Host "session: $sessionId"

Invoke-Rpc 'session.prompt' @{ sessionId = $sessionId; mode = 'queue'; content = @(@{ type = 'text'; text = '请只使用提问卡片工具（ask_user_question）问我一个问题：午饭想吃哪个？给我三个选项：米饭、面条、饺子。不要做任何其他事，不要读写任何文件。' }) } | Out-Null

$pendingIds = @()
$deadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $deadline) {
  $h = Invoke-RestMethod -Uri 'http://127.0.0.1:3081/api-gw/v1/health' -Headers $headers -TimeoutSec 8
  $pendingIds = @($h.answererPendingIds)
  if ($pendingIds.Count -gt 0) {
    Write-Host ("挂起出现: {0} broadcasts={1} sockets={2}" -f ($pendingIds -join ','), $h.answererBroadcasts, $h.answererLastBroadcastSockets)
    break
  }
  Start-Sleep -Seconds 2
}
if ($pendingIds.Count -eq 0) { Write-Host '❌ 90 秒内无挂起'; exit 1 }
$rpcId = $pendingIds[0]

# 从 history 找 ask_user_question 的真实问题 id
$hist = Invoke-Rpc 'session.history' @{ sessionId = $sessionId }
$questionId = $null
foreach ($ev in $hist.result.value.events) {
  $e = $ev.event
  if ($e.type -eq 'tool/call' -and $e.data.name -eq 'ask_user_question') {
    try {
      $args = $e.data.arguments | ConvertFrom-Json
      $questionId = $args.questions[0].id
      Write-Host "真实问题 id: $questionId"
    } catch { Write-Host "tool/call 参数解析失败: $($e.data.arguments)" }
    break
  }
}
if ($null -eq $questionId) { Write-Host '❌ 会话日志里没找到 ask_user_question 调用'; exit 1 }

$respBody = @{ type = 'client-response'; rpcId = $rpcId; result = @{ ok = $true; value = @{ sessionId = $sessionId; answer = @{ answers = @(@{ id = $questionId; selected = @('面条'); custom = '' }) } } } } | ConvertTo-Json -Depth 8
$resp = Invoke-RestMethod -Uri "$base/respond" -Method Post -Headers $headers -ContentType 'application/json' -Body $respBody -TimeoutSec 30
Write-Host ("respond 回执: {0}" -f ($resp | ConvertTo-Json -Compress))

# 断言回合继续：tool/result 后出现 assistant/message 与 turn/end（非 aborted）
$deadline = (Get-Date).AddSeconds(120)
$final = $null
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 5
  $hist = Invoke-Rpc 'session.history' @{ sessionId = $sessionId }
  $events = @($hist.result.value.events)
  $types = @($events | ForEach-Object { $_.event.type })
  $toolResultSeen = $types -contains 'tool/result'
  $answerSeen = $types -contains 'assistant/message'
  $endIdx = [array]::IndexOf($types, 'turn/end')
  if ($endIdx -ge 0) {
    $endData = $events[$endIdx].event.data | ConvertTo-Json -Depth 6 -Compress
    Write-Host "回合结束: tool/result=$toolResultSeen assistant/message=$answerSeen turn/end=$endData"
    if ($endData -match 'aborted') { Write-Host '❌ 回合以 aborted 结束' ; exit 1 }
    if ($toolResultSeen -and $answerSeen) { Write-Host '✅ 端到端通过：提问→回答→回合继续完成' } else { Write-Host "⚠️ 结束但状态不全: types=$($types -join ',')" }
    exit 0
  }
}
Write-Host '❌ 120 秒内回合未结束'
