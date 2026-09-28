# Probe v4: ask a question → poll pendingIds → take the real question id from the session log → respond with an answer → assert the turn completes.
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

Invoke-Rpc 'session.prompt' @{ sessionId = $sessionId; mode = 'queue'; content = @(@{ type = 'text'; text = 'Please use only the question card tool (ask_user_question) to ask me one question: what do I want for lunch? Give me three options: rice, noodles, dumplings. Do nothing else, do not read or write any file.' }) } | Out-Null

$pendingIds = @()
$deadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $deadline) {
  $h = Invoke-RestMethod -Uri 'http://127.0.0.1:3081/api-gw/v1/health' -Headers $headers -TimeoutSec 8
  $pendingIds = @($h.answererPendingIds)
  if ($pendingIds.Count -gt 0) {
    Write-Host ("pending appeared: {0} broadcasts={1} sockets={2}" -f ($pendingIds -join ','), $h.answererBroadcasts, $h.answererLastBroadcastSockets)
    break
  }
  Start-Sleep -Seconds 2
}
if ($pendingIds.Count -eq 0) { Write-Host '❌ nothing pending within 90 seconds'; exit 1 }
$rpcId = $pendingIds[0]

# find the real question id of ask_user_question in the history
$hist = Invoke-Rpc 'session.history' @{ sessionId = $sessionId }
$questionId = $null
foreach ($ev in $hist.result.value.events) {
  $e = $ev.event
  if ($e.type -eq 'tool/call' -and $e.data.name -eq 'ask_user_question') {
    try {
      $args = $e.data.arguments | ConvertFrom-Json
      $questionId = $args.questions[0].id
      Write-Host "real question id: $questionId"
    } catch { Write-Host "failed to parse tool/call arguments: $($e.data.arguments)" }
    break
  }
}
if ($null -eq $questionId) { Write-Host '❌ no ask_user_question call found in the session log'; exit 1 }

$respBody = @{ type = 'client-response'; rpcId = $rpcId; result = @{ ok = $true; value = @{ sessionId = $sessionId; answer = @{ answers = @(@{ id = $questionId; selected = @('面条'); custom = '' }) } } } } | ConvertTo-Json -Depth 8
$resp = Invoke-RestMethod -Uri "$base/respond" -Method Post -Headers $headers -ContentType 'application/json' -Body $respBody -TimeoutSec 30
Write-Host ("respond ack: {0}" -f ($resp | ConvertTo-Json -Compress))

# assert the turn continues: after tool/result come assistant/message and turn/end (not aborted)
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
    Write-Host "turn finished: tool/result=$toolResultSeen assistant/message=$answerSeen turn/end=$endData"
    if ($endData -match 'aborted') { Write-Host '❌ the turn ended as aborted' ; exit 1 }
    if ($toolResultSeen -and $answerSeen) { Write-Host '✅ end to end: question→answer→the turn runs on to completion' } else { Write-Host "⚠️ finished but the state is incomplete: types=$($types -join ',')" }
    exit 0
  }
}
Write-Host '❌ the turn did not finish within 120 seconds'
