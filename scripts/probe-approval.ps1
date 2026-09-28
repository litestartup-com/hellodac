# Probe v5: the approval flow -- shell command → approval_pending → respond allowed-once → assert the turn completes.
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

Invoke-Rpc 'session.prompt' @{ sessionId = $sessionId; mode = 'queue'; content = @(@{ type = 'text'; text = 'Please create a file dac-probe.txt in the current working directory, containing one line: hello. Do only this one thing.' }) } | Out-Null

$pendingIds = @()
$deadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $deadline) {
  $h = Invoke-RestMethod -Uri 'http://127.0.0.1:3081/api-gw/v1/health' -Headers $headers -TimeoutSec 8
  $pendingIds = @($h.answererPendingIds)
  if ($pendingIds.Count -gt 0) {
    Write-Host ("approval pending: {0} events={1}" -f ($pendingIds -join ','), ($h.answererWaterfallEvents -join ','))
    break
  }
  Start-Sleep -Seconds 2
}
if ($pendingIds.Count -eq 0) { Write-Host '❌ no approval pending within 90 seconds (the permission mode may not ask about shell)'; exit 1 }
$rpcId = $pendingIds[0]

$respBody = @{ type = 'client-response'; rpcId = $rpcId; result = @{ ok = $true; value = @{ sessionId = $sessionId; approvalId = $rpcId; outcome = 'allowed-once' } } } | ConvertTo-Json -Depth 8
$resp = Invoke-RestMethod -Uri "$base/respond" -Method Post -Headers $headers -ContentType 'application/json' -Body $respBody -TimeoutSec 30
Write-Host ("respond ack: {0}" -f ($resp | ConvertTo-Json -Compress))

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
    Write-Host "turn finished: tool/result=$toolResult turn/end=$endData"
    if ($endData -match 'aborted') { Write-Host '❌ aborted'; exit 1 }
    if ($toolResult) { Write-Host '✅ approval end to end: request→allow→tool run→turn complete' } else { Write-Host "⚠️ finished but no tool result: $($types -join ',')" }
    exit 0
  }
}
Write-Host '❌ the turn did not finish within 120 seconds'
