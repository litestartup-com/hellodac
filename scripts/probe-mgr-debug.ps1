# 调试：前台启动临时 manager（cwd=$tmp），15 秒后杀，打印输出。
$repo = 'C:\Users\Administrator\Documents\deepseek-workspace\dsh-agent-manager'
$key = ((Get-Content "$repo\.env" | Where-Object { $_ -like 'GW_KEY_A=*' }) -replace '^GW_KEY_A=', '')
$tmp = Join-Path $env:TEMP 'dac-mgr-boot-test'
New-Item -ItemType Directory -Path (Join-Path $tmp 'data') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $tmp 'workspaces') -Force | Out-Null
@"
listen:
  host: 127.0.0.1
  port: 18999
endpoints:
  personal:
    url: http://127.0.0.1:3081/api-gw/v1/proxy
    driver: apiproxy
    prefix: /api-gw/v1/proxy
    key_ref: GW_KEY_A
    sandbox_base: http://127.0.0.1:3081/api-gw/v1
    sandbox_key_ref: GW_KEY_A
agents:
  personal:
    name: 个人
    endpoint: personal
    workspace: $($tmp.Replace('\','/'))/workspaces
    preset: standard
    sandbox_mode: workspace-write
database:
  path: $($tmp.Replace('\','/'))/data/manager.db
"@ | Set-Content (Join-Path $tmp 'manager.config.yaml') -Encoding utf8

$env:GW_KEY_A = $key
$env:SESSION_SECRET = 'probe-secret-0123456789abcdef0123456789abcdef'
$env:MANAGER_USERNAME = 'admin'
$env:MANAGER_INITIAL_PASSWORD = 'probe-pass-123'
$env:LOG_LEVEL = 'info'

$job = Start-Job -ScriptBlock {
  param($loader, $entry, $dir)
  Set-Location $dir
  node --import $loader $entry 2>&1
} -ArgumentList 'file:///C:/Users/Administrator/Documents/deepseek-workspace/dsh-agent-manager/node_modules/tsx/dist/loader.mjs', 'file:///C:/Users/Administrator/Documents/deepseek-workspace/dsh-agent-manager/src/index.ts', $tmp
Start-Sleep -Seconds 12
$out = Receive-Job $job
Stop-Job $job; Remove-Job $job -Force
$out | Select-Object -First 30