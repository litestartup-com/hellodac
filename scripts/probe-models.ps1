# 探针：模型选择 / 访问模式 三链路实测（直连生产 personal 节点 facade 3081）。
$ErrorActionPreference = 'Stop'
$envFile = Join-Path $PSScriptRoot '..\.env'
$key = ((Get-Content $envFile | Where-Object { $_ -like 'GW_KEY_A=*' }) -replace '^GW_KEY_A=', '')
$base = 'http://127.0.0.1:3081/api-gw/v1/proxy'
$headers = @{ 'X-API-Key' = $key }

function Invoke-Rpc([string]$method, $payload) {
  $body = @{ rpcId = ('r' + [guid]::NewGuid().ToString('N').Substring(0,12)); method = $method; payload = $payload } | ConvertTo-Json -Depth 8
  return Invoke-RestMethod -Uri "$base/$method" -Method Post -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 30
}

$created = Invoke-Rpc 'session.create' @{ cwd = 'C:\Workplace\gitee\note-kaka' }
$sessionId = $created.result.value.sessionId
Write-Host "session: $sessionId"

Write-Host '--- 1) 访问模式: POST /sessions/{id}/sandbox-mode {workspace-write} ---'
try {
  $sm = Invoke-RestMethod -Uri "http://127.0.0.1:3081/api-gw/v1/sessions/$sessionId/sandbox-mode" -Method Post -Headers $headers -ContentType 'application/json' -Body (@{ mode = 'workspace-write' } | ConvertTo-Json) -TimeoutSec 15
  Write-Host ("回执: {0}" -f ($sm | ConvertTo-Json -Compress))
} catch {
  $r = $_.Exception.Response
  if ($r) {
    $body = $_.ErrorDetails.Message
    Write-Host "sandbox-mode 失败 HTTP $([int]$r.StatusCode): $body"
  } else { Write-Host "sandbox-mode 连接失败: $($_.Exception.Message)" }
}

Write-Host '--- 2) 模型目录: session.models ---'
try {
  $cat = Invoke-Rpc 'session.models' @{}
  $value = $cat.result.value
  $groups = @($value.groups)
  Write-Host "groups=$($groups.Count) current=$($value.current.provider)/$($value.current.model)"
  $firstModel = $null
  foreach ($g in $groups) {
    foreach ($m in @($g.models)) {
      if ($m.id -and $m.name) { Write-Host "  [$($g.id)] $($m.name) ($($m.id))"; if (-not $firstModel) { $firstModel = @{ provider = $g.id; model = $m.id } } }
    }
  }
  if ($firstModel) {
    Write-Host "--- 3) 模型选择: session.selectModel -> $($firstModel.provider)/$($firstModel.model) ---"
    $sel = Invoke-Rpc 'session.selectModel' @{ sessionId = $sessionId; provider = $firstModel.provider; model = $firstModel.model }
    Write-Host ("回执: {0}" -f ($sel.result.value | ConvertTo-Json -Depth 5 -Compress))
  } else { Write-Host '目录里没有可用模型' }
} catch { Write-Host "模型链路失败: $($_.Exception.Message)" }

Invoke-Rpc 'session.cancel' @{ sessionId = $sessionId } | Out-Null
Write-Host "结束 session=$sessionId"
