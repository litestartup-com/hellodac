# DAC — one-click join for a Windows workstation (Capability four fleet: node-agent scheduled task)
# Usage (administrator PowerShell):
#   $env:MANAGER_URL="https://app.example.com"; $env:AGENT_JOIN_TOKEN="dac-join-xxx"; .\join.ps1
# Idempotent: rerunning does not register twice (the agent already stores its identity locally); it only touches %LOCALAPPDATA%\DacAgent and the scheduled task.
$ErrorActionPreference = 'Stop'
$managerUrl = $env:MANAGER_URL
$joinToken  = $env:AGENT_JOIN_TOKEN
if (-not $managerUrl -or -not $joinToken) { Write-Error 'MANAGER_URL and AGENT_JOIN_TOKEN environment variables are required'; exit 1 }
$agentDir = if ($env:AGENT_DIR) { $env:AGENT_DIR } else { Join-Path $env:LOCALAPPDATA 'DacAgent' }
$nodeBin = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeBin) { Write-Error 'Node ≥22.18 required (node is not on PATH)'; exit 1 }
# Measured in M2: the DSH 0.1.5 launcher depends on import.meta.main (Node ≥22.18); on 22.17
# the launcher exits 0 silently (the node dies the moment it is started, the log stays empty) --
# the version gate has to really check it.
$nodeVer = ((& node --version 2>$null) -replace '^v', '').Trim()
$verParts = $nodeVer -split '\.'
$nodeOk = $verParts.Length -ge 2 -and ([int]$verParts[0] -gt 22 -or ([int]$verParts[0] -eq 22 -and [int]$verParts[1] -ge 18))
if (-not $nodeOk) { Write-Error "Node ≥22.18 required (the DSH 0.1.5 launcher depends on import.meta.main) -- currently $nodeVer"; exit 1 }

New-Item -ItemType Directory -Force -Path $agentDir | Out-Null
Invoke-WebRequest -Uri "$managerUrl/assets/agent/runtime.mjs" -OutFile (Join-Path $agentDir 'runtime.mjs') -UseBasicParsing
Invoke-WebRequest -Uri "$managerUrl/assets/agent/agent.mjs"     -OutFile (Join-Path $agentDir 'agent.mjs')     -UseBasicParsing
Invoke-WebRequest -Uri "$managerUrl/assets/agent/update.mjs"    -OutFile (Join-Path $agentDir 'update.mjs')    -UseBasicParsing

$action = New-ScheduledTaskAction -Execute $nodeBin -Argument 'agent.mjs' -WorkingDirectory $agentDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'DacAgent' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

# Environment variables into the task: Register's -Action does not support env, and schtasks /xml is
# painful -- so just write a launcher batch file.
# M4-3: the batch file carries a restart loop -- the agent's self-update exits non-zero to swap in the
# new install, and 5s later the loop starts the new code; the scheduled task's RestartOnFailure is
# unreliable for demand-start instances (measured), so the loop is the backstop.
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
Write-Output "join.ps1: agent installed and started (AGENT_DIR=$agentDir). This machine should show up on the manager machines page."
