# One-shot diagnostic probe v2: direct to the personal node facade (3081), create a session → ask a question → watch the mux frames.
# Single-threaded version: the receive loop runs on the main thread (the Task::Run delegate version received no frames in practice), RPC and the frame pump interleave.
$ErrorActionPreference = 'Stop'
$envFile = Join-Path $PSScriptRoot '..\.env'
$key = ((Get-Content $envFile | Where-Object { $_ -like 'GW_KEY_A=*' }) -replace '^GW_KEY_A=', '')
if ([string]::IsNullOrEmpty($key)) { throw 'GW_KEY_A not found' }
$base = 'http://127.0.0.1:3081/api-gw/v1/proxy'
$headers = @{ 'X-API-Key' = $key }

function Invoke-Rpc([string]$method, $payload) {
  $body = @{ rpcId = ('r' + [guid]::NewGuid().ToString('N').Substring(0,12)); method = $method; payload = $payload } | ConvertTo-Json -Depth 8
  return Invoke-RestMethod -Uri "$base/$method" -Method Post -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 60
}

# ---- connect the mux WS ----
$ws = [System.Net.WebSockets.ClientWebSocket]::new()
$ws.Options.SetRequestHeader('X-API-Key', $key)
$ws.ConnectAsync([Uri]'ws://127.0.0.1:3081/api-gw/v1/proxy/events.mux', [System.Threading.CancellationToken]::None).GetAwaiter().GetResult()
Write-Host "mux connected state=$($ws.State)"
$buf = [byte[]]::new(65536)
$seg = [ArraySegment[byte]]::new($buf)

function Read-Frame([int]$timeoutMs) {
  $cts2 = [System.Threading.CancellationTokenSource]::new($timeoutMs)
  try {
    $res = $ws.ReceiveAsync($seg, $cts2.Token).GetAwaiter().GetResult()
    if ($res.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) { return $null }
    if ($res.Count -le 0) { return $null }
    return [System.Text.Encoding]::UTF8.GetString($buf, 0, $res.Count)
  } catch {
    return $null
  } finally {
    $cts2.Dispose()
  }
}

function Dump-Window([int]$seconds) {
  $end = (Get-Date).AddSeconds($seconds)
  $total = 0
  while ((Get-Date) -lt $end) {
    $text = Read-Frame 200
    if ($null -ne $text) {
      $total += 1
      try {
        $json = $text | ConvertFrom-Json
        if ($json.method -in @('question/requested','question/resolved','approval/requested','approval/resolved')) {
          Write-Host ("★ key frame: method={0} payload={1}" -f $json.method, (($json.payload | ConvertTo-Json -Depth 6 -Compress)))
        } elseif ($json.method -eq 'session/event' -and $json.payload.event.type -in @('approval/asked','approval/decided')) {
          Write-Host ("◎ session event: {0} data={1}" -f $json.payload.event.type, (($json.payload.event.data | ConvertTo-Json -Compress)))
        } elseif ($total -le 3) {
          Write-Host ("· sample frame: {0}" -f ($text.Substring(0, [Math]::Min(160, $text.Length))))
        }
      } catch { Write-Host ("· non-JSON frame: {0}" -f ($text.Substring(0, [Math]::Min(80, $text.Length)))) }
    }
  }
  Write-Host "received $total frames in this window"
}

try {
  $created = Invoke-Rpc 'session.create' @{ cwd = 'C:\Workplace\gitee\note-kaka' }
  $sessionId = $created.result.value.sessionId
  Write-Host "session: $sessionId"

  Write-Host '=== question probe ==='
  Invoke-Rpc 'session.prompt' @{ sessionId = $sessionId; mode = 'queue'; content = @(@{ type = 'text'; text = 'Please use only the question card tool (ask_user_question) to ask me one question: what do I want for lunch? Give me three options: rice, noodles, dumplings. Do nothing else, do not read or write any file.' }) } | Out-Null
  Dump-Window 75

  Write-Host '=== approval probe ==='
  Invoke-Rpc 'session.prompt' @{ sessionId = $sessionId; mode = 'queue'; content = @(@{ type = 'text'; text = 'Please run the shell command echo hello-probe, just this one, and do nothing else.' }) } | Out-Null
  Dump-Window 60

  Invoke-Rpc 'session.cancel' @{ sessionId = $sessionId } | Out-Null
  Write-Host "probe finished session=$sessionId"
} finally {
  try { $ws.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, 'done', [System.Threading.CancellationToken]::None).GetAwaiter().GetResult() | Out-Null } catch {}
}
