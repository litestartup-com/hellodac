# 探针：manager 层三链路复现（临时实例 → 生产 facade 3081）。
# 走真实 API：登录 → 建 chat → capabilities → fresh 时切权限 → 发消息 → 再切 → 模型目录/选择。
$ErrorActionPreference = 'Stop'
$repo = 'C:\Users\Administrator\Documents\deepseek-workspace\dsh-agent-manager'
$key = ((Get-Content "$repo\.env" | Where-Object { $_ -like 'GW_KEY_A=*' }) -replace '^GW_KEY_A=', '')
$tmp = Join-Path $env:TEMP ("dac-mgr-probe-" + [guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Path (Join-Path $tmp 'data') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $tmp 'workspaces') -Force | Out-Null
$port = 18999
$base = "http://127.0.0.1:$port"

@"
listen:
  host: 127.0.0.1
  port: $port
endpoints:
  personal:
    url: http://127.0.0.1:3081
    driver: apiproxy
    prefix: /api-gw/v1/proxy
    key_ref: GW_KEY_A
    sandbox_base: http://127.0.0.1:3081/api-gw/v1
    sandbox_key_ref: GW_KEY_A
agents:
  personal:
    name: 个人
    endpoint: personal
    workspace: $(($tmp + '\workspaces').Replace('\','/'))
    preset: standard
    sandbox_mode: workspace-write
database:
  path: $($tmp.Replace('\','/'))/data/manager.db
"@ | Set-Content (Join-Path $tmp 'manager.config.yaml') -Encoding utf8

$env:GW_KEY_A = $key
$env:SESSION_SECRET = 'probe-secret-0123456789abcdef0123456789abcdef'
$env:MANAGER_USERNAME = 'admin'
$env:MANAGER_INITIAL_PASSWORD = 'probe-pass-123'
$env:LOG_LEVEL = 'warn'

# 入口与依赖经 junction 链接进 $tmp（cwd 在 $tmp，manager 读 cwd 下的
# manager.config.yaml）；环境变量在脚本进程内直接设置。
cmd /c mklink /J "$tmp\node_modules" "$repo\node_modules" 2>&1 | Out-Null
cmd /c mklink /J "$tmp\src" "$repo\src" 2>&1 | Out-Null
$proc = Start-Process -FilePath 'node' -ArgumentList '--import','tsx','src/index.ts' -WorkingDirectory $tmp -PassThru -WindowStyle Hidden
try {
  $up = $false
  for ($i = 0; $i -lt 30 -and -not $up; $i++) {
    try { $r = Invoke-WebRequest -Uri "$base/healthz" -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { $up = $true } } catch { Start-Sleep -Seconds 1 }
  }
  if (-not $up) { 'manager 未起'; exit 1 }
  'manager 已起'

  $login = Invoke-RestMethod -Uri "$base/api/login" -Method Post -ContentType 'application/json' -Body (@{ username = 'admin'; password = 'probe-pass-123' } | ConvertTo-Json) -SessionVariable sess -TimeoutSec 10
  $csrf = $sess.Cookies.GetCookies("$base")['dac_csrf'].Value
  $authHeaders = @{ 'x-csrf-token' = $csrf }
  '已登录'

  '--- 首登改密 ---'
  $pw = Invoke-RestMethod -Uri "$base/api/account/password" -Method Post -Headers $authHeaders -ContentType 'application/json' -Body (@{ currentPassword = 'probe-pass-123'; newPassword = 'probe-pass-456' } | ConvertTo-Json) -WebSession $sess -TimeoutSec 10
  $csrf = $sess.Cookies.GetCookies("$base")['dac_csrf'].Value
  $authHeaders = @{ 'x-csrf-token' = $csrf }
  "改密回执: $($pw | ConvertTo-Json -Compress)"

  $chat = Invoke-RestMethod -Uri "$base/api/chats" -Method Post -Headers $authHeaders -ContentType 'application/json' -Body (@{ agentId = 'personal' } | ConvertTo-Json) -WebSession $sess -TimeoutSec 10
  $chatId = $chat.chat.id
  "chat: $chatId"

  $state = Invoke-RestMethod -Uri "$base/api/chats/$chatId" -Headers $authHeaders -WebSession $sess -TimeoutSec 15
  "sessionState=$($state.sessionState) capabilities=$($state.composer.capabilities | ConvertTo-Json -Compress)"

  '--- fresh 时切权限（预期 409 no_session） ---'
  try {
    Invoke-RestMethod -Uri "$base/api/chats/$chatId/sandbox-mode" -Method Post -Headers $authHeaders -ContentType 'application/json' -Body (@{ mode = 'workspace-write' } | ConvertTo-Json) -WebSession $sess -TimeoutSec 10 | Out-Null
    '意外成功'
  } catch { "fresh 切换: HTTP $([int]$_.Exception.Response.StatusCode) $($_.ErrorDetails.Message)" }

  '--- 发一条消息绑定会话 ---'
  $msg = Invoke-RestMethod -Uri "$base/api/chats/$chatId/messages" -Method Post -Headers $authHeaders -ContentType 'application/json' -Body (@{ text = '你好' } | ConvertTo-Json) -WebSession $sess -TimeoutSec 10
  "消息回执: $($msg | ConvertTo-Json -Compress)"
  $bound = $false
  for ($i = 0; $i -lt 10 -and -not $bound; $i++) {
    Start-Sleep -Seconds 3
    $st = Invoke-RestMethod -Uri "$base/api/chats/$chatId" -Headers $authHeaders -WebSession $sess -TimeoutSec 15
    $turnInfo = (@($st.turns) | ForEach-Object { ($_.state) + '/' + ($_.error) }) -join ', '
    "轮询 $($i+1): sessionState=$($st.sessionState) busyRunId=$($st.busyRunId) turns=$turnInfo"
    if ($st.sessionState -ne 'fresh') { $bound = $true }
  }

  '--- 会话建立后再切权限（预期 200） ---'
  try {
    $sm = Invoke-RestMethod -Uri "$base/api/chats/$chatId/sandbox-mode" -Method Post -Headers $authHeaders -ContentType 'application/json' -Body (@{ mode = 'workspace-write' } | ConvertTo-Json) -WebSession $sess -TimeoutSec 10
    "切权限回执: $($sm | ConvertTo-Json -Compress)"
  } catch { "切权限失败: HTTP $([int]$_.Exception.Response.StatusCode) $($_.ErrorDetails.Message)" }

  '--- 模型目录 ---'
  try {
    $cat = Invoke-RestMethod -Uri "$base/api/chats/$chatId/models" -Headers $authHeaders -WebSession $sess -TimeoutSec 15
    $g = @($cat.catalog.groups)[0]
    $m = @($g.models)[0]
    "目录: groups=$(@($cat.catalog.groups).Count) 首个=$($g.id)/$($m.id)"
    '--- 模型选择 ---'
    $sel = Invoke-RestMethod -Uri "$base/api/chats/$chatId/model" -Method Post -Headers $authHeaders -ContentType 'application/json' -Body (@{ provider = $g.id; model = $m.id } | ConvertTo-Json) -WebSession $sess -TimeoutSec 15
    "选择回执: $($sel | ConvertTo-Json -Compress)"
  } catch { "模型链路失败: HTTP $([int]$_.Exception.Response.StatusCode) $($_.ErrorDetails.Message)" }
} finally {
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
