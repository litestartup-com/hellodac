# Probe: reproduce the three chains at the manager layer (temporary instance → production facade 3081).
# Goes through the real API: login → create chat → capabilities → switch permission while fresh → send a message → switch again → model catalog/selection.
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

# Links the entry point and dependencies into $tmp via junctions (cwd is in $tmp, and the manager reads
# manager.config.yaml from the cwd); environment variables are set directly inside the script process.
cmd /c mklink /J "$tmp\node_modules" "$repo\node_modules" 2>&1 | Out-Null
cmd /c mklink /J "$tmp\src" "$repo\src" 2>&1 | Out-Null
$proc = Start-Process -FilePath 'node' -ArgumentList '--import','tsx','src/index.ts' -WorkingDirectory $tmp -PassThru -WindowStyle Hidden
try {
  $up = $false
  for ($i = 0; $i -lt 30 -and -not $up; $i++) {
    try { $r = Invoke-WebRequest -Uri "$base/healthz" -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { $up = $true } } catch { Start-Sleep -Seconds 1 }
  }
  if (-not $up) { 'manager did not start'; exit 1 }
  'manager is up'

  $login = Invoke-RestMethod -Uri "$base/api/login" -Method Post -ContentType 'application/json' -Body (@{ username = 'admin'; password = 'probe-pass-123' } | ConvertTo-Json) -SessionVariable sess -TimeoutSec 10
  $csrf = $sess.Cookies.GetCookies("$base")['dac_csrf'].Value
  $authHeaders = @{ 'x-csrf-token' = $csrf }
  'logged in'

  '--- forced password change on first login ---'
  $pw = Invoke-RestMethod -Uri "$base/api/account/password" -Method Post -Headers $authHeaders -ContentType 'application/json' -Body (@{ currentPassword = 'probe-pass-123'; newPassword = 'probe-pass-456' } | ConvertTo-Json) -WebSession $sess -TimeoutSec 10
  $csrf = $sess.Cookies.GetCookies("$base")['dac_csrf'].Value
  $authHeaders = @{ 'x-csrf-token' = $csrf }
  "password change ack: $($pw | ConvertTo-Json -Compress)"

  $chat = Invoke-RestMethod -Uri "$base/api/chats" -Method Post -Headers $authHeaders -ContentType 'application/json' -Body (@{ agentId = 'personal' } | ConvertTo-Json) -WebSession $sess -TimeoutSec 10
  $chatId = $chat.chat.id
  "chat: $chatId"

  $state = Invoke-RestMethod -Uri "$base/api/chats/$chatId" -Headers $authHeaders -WebSession $sess -TimeoutSec 15
  "sessionState=$($state.sessionState) capabilities=$($state.composer.capabilities | ConvertTo-Json -Compress)"

  '--- switch permission while fresh (409 no_session expected) ---'
  try {
    Invoke-RestMethod -Uri "$base/api/chats/$chatId/sandbox-mode" -Method Post -Headers $authHeaders -ContentType 'application/json' -Body (@{ mode = 'workspace-write' } | ConvertTo-Json) -WebSession $sess -TimeoutSec 10 | Out-Null
    'succeeded unexpectedly'
  } catch { "switch while fresh: HTTP $([int]$_.Exception.Response.StatusCode) $($_.ErrorDetails.Message)" }

  '--- send one message to bind the session ---'
  $msg = Invoke-RestMethod -Uri "$base/api/chats/$chatId/messages" -Method Post -Headers $authHeaders -ContentType 'application/json' -Body (@{ text = '你好' } | ConvertTo-Json) -WebSession $sess -TimeoutSec 10
  "message ack: $($msg | ConvertTo-Json -Compress)"
  $bound = $false
  for ($i = 0; $i -lt 10 -and -not $bound; $i++) {
    Start-Sleep -Seconds 3
    $st = Invoke-RestMethod -Uri "$base/api/chats/$chatId" -Headers $authHeaders -WebSession $sess -TimeoutSec 15
    $turnInfo = (@($st.turns) | ForEach-Object { ($_.state) + '/' + ($_.error) }) -join ', '
    "poll $($i+1): sessionState=$($st.sessionState) busyRunId=$($st.busyRunId) turns=$turnInfo"
    if ($st.sessionState -ne 'fresh') { $bound = $true }
  }

  '--- switch permission after the session is established (200 expected) ---'
  try {
    $sm = Invoke-RestMethod -Uri "$base/api/chats/$chatId/sandbox-mode" -Method Post -Headers $authHeaders -ContentType 'application/json' -Body (@{ mode = 'workspace-write' } | ConvertTo-Json) -WebSession $sess -TimeoutSec 10
    "permission switch ack: $($sm | ConvertTo-Json -Compress)"
  } catch { "permission switch failed: HTTP $([int]$_.Exception.Response.StatusCode) $($_.ErrorDetails.Message)" }

  '--- model catalog ---'
  try {
    $cat = Invoke-RestMethod -Uri "$base/api/chats/$chatId/models" -Headers $authHeaders -WebSession $sess -TimeoutSec 15
    $g = @($cat.catalog.groups)[0]
    $m = @($g.models)[0]
    "catalog: groups=$(@($cat.catalog.groups).Count) first=$($g.id)/$($m.id)"
    '--- model selection ---'
    $sel = Invoke-RestMethod -Uri "$base/api/chats/$chatId/model" -Method Post -Headers $authHeaders -ContentType 'application/json' -Body (@{ provider = $g.id; model = $m.id } | ConvertTo-Json) -WebSession $sess -TimeoutSec 15
    "selection ack: $($sel | ConvertTo-Json -Compress)"
  } catch { "model chain failed: HTTP $([int]$_.Exception.Response.StatusCode) $($_.ErrorDetails.Message)" }
} finally {
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
