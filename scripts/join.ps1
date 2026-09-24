# DAC — Windows 工作机一键加入（能力四舰队：node-agent 计划任务）
# 用法（管理员 PowerShell）：
#   $env:MANAGER_URL="https://app.example.com"; $env:AGENT_JOIN_TOKEN="dac-join-xxx"; .\join.ps1
# 幂等：重跑不重复注册（agent 本地已存身份）；只动 %LOCALAPPDATA%\DacAgent 与计划任务。
$ErrorActionPreference = 'Stop'
$managerUrl = $env:MANAGER_URL
$joinToken  = $env:AGENT_JOIN_TOKEN
if (-not $managerUrl -or -not $joinToken) { Write-Error '需要 MANAGER_URL 与 AGENT_JOIN_TOKEN 环境变量'; exit 1 }
$agentDir = if ($env:AGENT_DIR) { $env:AGENT_DIR } else { Join-Path $env:LOCALAPPDATA 'DacAgent' }
$nodeBin = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeBin) { Write-Error '需要 Node ≥22.18（node 不在 PATH）'; exit 1 }
# M2 实测：DSH 0.1.5 启动器依赖 import.meta.main（Node ≥22.18），22.17 上
# 启动器静默退出 0（节点拉起来即死、日志空）——版本门禁必须真实校验。
$nodeVer = ((& node --version 2>$null) -replace '^v', '').Trim()
$verParts = $nodeVer -split '\.'
$nodeOk = $verParts.Length -ge 2 -and ([int]$verParts[0] -gt 22 -or ([int]$verParts[0] -eq 22 -and [int]$verParts[1] -ge 18))
if (-not $nodeOk) { Write-Error "需要 Node ≥22.18（DSH 0.1.5 启动器依赖 import.meta.main）——当前 $nodeVer"; exit 1 }

New-Item -ItemType Directory -Force -Path $agentDir | Out-Null
Invoke-WebRequest -Uri "$managerUrl/assets/agent/runtime.mjs" -OutFile (Join-Path $agentDir 'runtime.mjs') -UseBasicParsing
Invoke-WebRequest -Uri "$managerUrl/assets/agent/agent.mjs"     -OutFile (Join-Path $agentDir 'agent.mjs')     -UseBasicParsing
Invoke-WebRequest -Uri "$managerUrl/assets/agent/update.mjs"    -OutFile (Join-Path $agentDir 'update.mjs')    -UseBasicParsing

$action = New-ScheduledTaskAction -Execute $nodeBin -Argument 'agent.mjs' -WorkingDirectory $agentDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'DacAgent' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

# 环境变量塞进任务：用 Register 的 -Action 不支持 env，改 schtasks /xml 麻烦——直接写一个启动批处理。
# M4-3：批处理带重启循环——agent 自更新以非零码退出换装，5s 后循环拉起新代码；
# 计划任务的 RestartOnFailure 对 demand-start 实例不可靠（实测），循环兜底。
$launcher = Join-Path $agentDir 'agent-start.cmd'
@"
@echo off
set MANAGER_URL=$managerUrl
set AGENT_JOIN_TOKEN=$joinToken
set AGENT_DIR=$agentDir
:loop
"$nodeBin" "$agentDir\agent.mjs"
timeout /t 5 /nobreak >nul
goto loop
"@ | Set-Content -Path $launcher -Encoding ASCII
$action2 = New-ScheduledTaskAction -Execute $launcher -WorkingDirectory $agentDir
Register-ScheduledTask -TaskName 'DacAgent' -Action $action2 -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName 'DacAgent'
Write-Output "join.ps1: agent 已安装并启动（AGENT_DIR=$agentDir）。manager 机器页应出现本机。"
