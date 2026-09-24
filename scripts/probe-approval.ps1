# 探针 v5：审批流——shell 命令 → approval_pending → respond allowed-once → 断言回合完成。
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

Invoke-Rpc 'session.prompt' @{ sessionId = $sessionId; mode = 'queue'; content = @(@{ type = 'text'; text = '请在当前工作目录创建文件 dac-probe.txt，内容一行 hello。只做这一件事。' }) } | Out-Null

$pendingIds = @()
$deadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $deadline) {
  $h = Invoke-RestMethod -Uri 'http://127.0.0.1:3081/api-gw/v1/health' -Headers $headers -TimeoutSec 8
  $pendingIds = @($h.answererPendingIds)
  if ($pendingIds.Count -gt 0) {
    Write-Host ("审批挂起: {0} events={1}" -f ($pendingIds -join ','), ($h.answererWaterfallEvents -join ','))
    break
  }
  Start-Sleep -Seconds 2
}
if ($pendingIds.Count -eq 0) { Write-Host '❌ 90 秒内无审批挂起（权限模式可能不询问 shell）'; exit 1 }
$rpcId = $pendingIds[0]

$respBody = @{ type = 'client-response'; rpcId = $rpcId; result = @{ ok = $true; value = @{ sessionId = $sessionId; approvalId = $rpcId; outcome = 'allowed-once' } } } | ConvertTo-Json -Depth 8
$resp = Invoke-RestMethod -Uri "$base/respond" -Method Post -Headers $headers -ContentType 'application/json' -Body $respBody -TimeoutSec 30
Write-Host ("respond 回执: {0}" -f ($resp | ConvertTo-Json -Compress))

$deadline = (Get-Date).AddSeconds(120)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 5
  $hist = Invoke-Rpc 'session.history' @{ sessionId = $sessionId }
  $events = @($hist.result.value.events)
  $types = @($events | ForEach-Object { $_.event.type })
  $endIdx = [array]::IndexOf($types, 'turn/end')
  if ($endIdx -ge 0) {
    $endData = $events[$endIdx].event.data | ConvertTo-Json -Depth 6 -Compress
    $toolResult = $types -contains 'tool/result'
    Write-Host "回合结束: tool/result=$toolResult turn/end=$endData"
    if ($endData -match 'aborted') { Write-Host '❌ aborted'; exit 1 }
    if ($toolResult) { Write-Host '✅ 审批端到端通过：请求→允许→工具执行→回合完成' } else { Write-Host "⚠️ 完成但无工具结果: $($types -join ',')" }
    exit 0
  }
}
Write-Host '❌ 120 秒内回合未结束'
