# 一次性诊断探针 v2：直连 personal 节点 facade（3081），建会话 → 提问 → 观察 mux 帧。
# 单线程版：接收循环跑在主线程（Task::Run 委托版实测收不到帧），RPC 与帧泵交错。
$ErrorActionPreference = 'Stop'
$envFile = Join-Path $PSScriptRoot '..\.env'
$key = ((Get-Content $envFile | Where-Object { $_ -like 'GW_KEY_A=*' }) -replace '^GW_KEY_A=', '')
if ([string]::IsNullOrEmpty($key)) { throw 'GW_KEY_A 未找到' }
$base = 'http://127.0.0.1:3081/api-gw/v1/proxy'
$headers = @{ 'X-API-Key' = $key }

function Invoke-Rpc([string]$method, $payload) {
  $body = @{ rpcId = ('r' + [guid]::NewGuid().ToString('N').Substring(0,12)); method = $method; payload = $payload } | ConvertTo-Json -Depth 8
  return Invoke-RestMethod -Uri "$base/$method" -Method Post -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 60
}

# ---- 连接 mux WS ----
$ws = [System.Net.WebSockets.ClientWebSocket]::new()
$ws.Options.SetRequestHeader('X-API-Key', $key)
$ws.ConnectAsync([Uri]'ws://127.0.0.1:3081/api-gw/v1/proxy/events.mux', [System.Threading.CancellationToken]::None).GetAwaiter().GetResult()
Write-Host "mux 已连接 state=$($ws.State)"
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
          Write-Host ("★ 关键帧: method={0} payload={1}" -f $json.method, (($json.payload | ConvertTo-Json -Depth 6 -Compress)))
        } elseif ($json.method -eq 'session/event' -and $json.payload.event.type -in @('approval/asked','approval/decided')) {
          Write-Host ("◎ 会话事件: {0} data={1}" -f $json.payload.event.type, (($json.payload.event.data | ConvertTo-Json -Compress)))
        } elseif ($total -le 3) {
          Write-Host ("· 样本帧: {0}" -f ($text.Substring(0, [Math]::Min(160, $text.Length))))
        }
      } catch { Write-Host ("· 非 JSON 帧: {0}" -f ($text.Substring(0, [Math]::Min(80, $text.Length)))) }
    }
  }
  Write-Host "本窗口共收 $total 帧"
}

try {
  $created = Invoke-Rpc 'session.create' @{ cwd = 'C:\Workplace\gitee\note-kaka' }
  $sessionId = $created.result.value.sessionId
  Write-Host "session: $sessionId"

  Write-Host '=== 提问探针 ==='
  Invoke-Rpc 'session.prompt' @{ sessionId = $sessionId; mode = 'queue'; content = @(@{ type = 'text'; text = '请只使用提问卡片工具（ask_user_question）问我一个问题：午饭想吃哪个？给我三个选项：米饭、面条、饺子。不要做任何其他事，不要读写任何文件。' }) } | Out-Null
  Dump-Window 75

  Write-Host '=== 审批探针 ==='
  Invoke-Rpc 'session.prompt' @{ sessionId = $sessionId; mode = 'queue'; content = @(@{ type = 'text'; text = '请执行 shell 命令 echo hello-probe，只执行这一条，不要做任何其他事。' }) } | Out-Null
  Dump-Window 60

  Invoke-Rpc 'session.cancel' @{ sessionId = $sessionId } | Out-Null
  Write-Host "探针结束 session=$sessionId"
} finally {
  try { $ws.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, 'done', [System.Threading.CancellationToken]::None).GetAwaiter().GetResult() | Out-Null } catch {}
}
