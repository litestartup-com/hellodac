# P0 验收链路冒烟（临时实例：独立目录 + 独立端口 + 独立库，不碰生产）。用后即删。
$ErrorActionPreference = 'Continue'
$root = (Get-Location).Path
$tmp = Join-Path $env:TEMP "dac-p0-smoke-$(Get-Random)"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

@"
listen:
  host: 127.0.0.1
  port: 18080
public_api:
  enabled: true
  host: 127.0.0.1
  port: 18081
endpoints:
  W:
    url: http://127.0.0.1:19999
    driver: gateway
    key_ref: GW_KEY_SMOKE
agents:
  worker-1:
    name: 坐席一
    endpoint: W
    workspace: $($tmp -replace '\\','/')/ws
    public: true
    preset: standard
services:
  - id: support
    label: 企业智能客服
    workers: [worker-1]
    surfaces: [tasks, conversations]
    knowledge:
      - host: /srv/knowledge/faq
        mount: /knowledge
runner:
  timeout_minutes: 15
  silence_timeout_minutes: 5
  max_consecutive_failures: 3
database:
  path: $($tmp -replace '\\','/')/manager.db
"@ | Set-Content -Path (Join-Path $tmp 'manager.config.yaml') -Encoding UTF8

$env:SESSION_SECRET = 'x' * 32
$env:GW_KEY_SMOKE = 'dummy-gateway-key'
$env:MANAGER_INITIAL_PASSWORD = 'smoke-initial-pass'
$env:DEEPSEEK_API_KEY = 'sk-dummy'

Write-Output '=== 1) 起临时 manager（含门面）==='
$log = Join-Path $tmp 'manager.log'
$proc = Start-Process -FilePath 'node' -ArgumentList (Join-Path $root 'dist\index.js') -WorkingDirectory $tmp -PassThru -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError (Join-Path $tmp 'manager.err')
Start-Sleep -Seconds 7
try {
  $health = Invoke-WebRequest -Uri 'http://127.0.0.1:18080/login' -TimeoutSec 6 -UseBasicParsing -SkipHttpErrorCheck
  Write-Output "  后台 /login => HTTP $($health.StatusCode)"
  $api = Invoke-WebRequest -Uri 'http://127.0.0.1:18081/v1/health' -TimeoutSec 6 -UseBasicParsing -SkipHttpErrorCheck
  Write-Output "  门面 /v1/health => HTTP $($api.StatusCode)  body=$($api.Content)"
} catch {
  Write-Output "  启动失败: $($_.Exception.Message)"
  Write-Output '  --- manager.log ---'
  if (Test-Path $log) { Get-Content $log -Tail 15 | ForEach-Object { "    $_" } }
  Write-Output '  --- manager.err ---'
  if (Test-Path (Join-Path $tmp 'manager.err')) { Get-Content (Join-Path $tmp 'manager.err') -Tail 15 | ForEach-Object { "    $_" } }
}

Write-Output '=== 2) 无钥匙访问受保护端点（期望 401）==='
$noKey = Invoke-WebRequest -Uri 'http://127.0.0.1:18081/v1/services' -TimeoutSec 6 -UseBasicParsing -SkipHttpErrorCheck
Write-Output "  HTTP $($noKey.StatusCode)  body=$($noKey.Content)"

Write-Output '=== 3) 用 CLI 发一把钥匙（临时库）==='
Push-Location $tmp
try {
  $out = (& node (Join-Path $root 'node_modules\tsx\dist\cli.mjs') (Join-Path $root 'src\cli\apikey.ts') create --name '冒烟' --services support --scopes 'services:read,usage:read' --quota 5 2>&1 | Out-String)
} finally { Pop-Location }
Write-Output ($out -split "`n" | Select-Object -First 6 | ForEach-Object { "  $_" })
$token = ([regex]::Match($out, 'dac_[0-9a-f]{12}_[A-Za-z0-9_-]{43}')).Value
Write-Output "  取到 token: $(if ($token) { '是' } else { '否 ✗' })"

Write-Output '=== 4) 带钥匙调用（期望 200 + 只看到自己的服务）==='
$ok = Invoke-WebRequest -Uri 'http://127.0.0.1:18081/v1/services' -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 6 -UseBasicParsing -SkipHttpErrorCheck
Write-Output "  /v1/services => HTTP $($ok.StatusCode)  body=$($ok.Content)"
$usage = Invoke-WebRequest -Uri 'http://127.0.0.1:18081/v1/usage' -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 6 -UseBasicParsing -SkipHttpErrorCheck
Write-Output "  /v1/usage    => HTTP $($usage.StatusCode)  body=$($usage.Content)"

Write-Output '=== 5) 会话 cookie 冒充钥匙（期望 401）==='
$cookie = Invoke-WebRequest -Uri 'http://127.0.0.1:18081/v1/services' -Headers @{ Cookie = "mgr_sid=$('z' * 43)" } -TimeoutSec 6 -UseBasicParsing -SkipHttpErrorCheck
Write-Output "  HTTP $($cookie.StatusCode)"

Write-Output '=== 6) 吊销后立即失效（期望 200 → 401）==='
$keyId = ([regex]::Match($out, 'id\s*:\s*([0-9a-f]{12})')).Groups[1].Value
Push-Location $tmp
try {
  $rev = (& node (Join-Path $root 'node_modules\tsx\dist\cli.mjs') (Join-Path $root 'src\cli\apikey.ts') revoke $keyId 2>&1 | Out-String).Trim()
} finally { Pop-Location }
Write-Output "  CLI: $rev"
$after = Invoke-WebRequest -Uri 'http://127.0.0.1:18081/v1/services' -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 6 -UseBasicParsing -SkipHttpErrorCheck
Write-Output "  吊销后 /v1/services => HTTP $($after.StatusCode)  body=$($after.Content)"

Write-Output '=== 7) 审计是否留痕（临时库）==='
$sql = @'
import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync(process.argv[2], { readOnly: true })
for (const r of db.prepare('SELECT kind, actor, detail FROM audit_log ORDER BY id').all()) console.log('  ', r.kind, '|', r.actor, '|', r.detail)
db.close()
'@
Set-Content -Path (Join-Path $tmp 'peek.mjs') -Value $sql -Encoding UTF8
node --experimental-sqlite (Join-Path $tmp 'peek.mjs') (Join-Path $tmp 'manager.db') 2>$null

Write-Output '=== 清理 ==='
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Write-Output "  临时实例已停、目录已删: $(-not (Test-Path $tmp))"
