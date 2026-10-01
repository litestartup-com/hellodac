# DAC — one-command install for Windows (bare-metal form: manager + brain + personal, running right on this machine).
#
# Recommended (download and read it first):
#   irm https://raw.githubusercontent.com/litestartup-com/hellodac/v1.1.0/install.ps1 -OutFile install.ps1
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
# One-liner for the impatient (runs straight away; parameters cannot be passed):
#   irm https://raw.githubusercontent.com/litestartup-com/hellodac/v1.1.0/install.ps1 | iex
#
# Idempotent: Node/git/pnpm/DSH already installed at the right version = skipped; repo/config already there = not overwritten.
# Plan first: DRY_RUN=1 only looks, it does not execute; -Yes skips the confirmation. The only manual input = the DeepSeek API key
# (preset through -ApiKey or the DEEPSEEK_API_KEY environment variable and the whole run is automatic).
param(
  [string]$ApiKey = $env:DEEPSEEK_API_KEY,
  [string]$WorkspaceDir = "$env:USERPROFILE\dac",
  [switch]$Service,
  [switch]$Yes,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$DSH_VERSION = '0.2.0-rc.2' # keep in sync with src/dsh-version.ts

function Step([string]$Msg) { Write-Host "[install] $Msg" -ForegroundColor Cyan }
function Plan([string]$Msg) { Write-Host "[plan] $Msg" -ForegroundColor DarkGray }
function Confirm-Step([string]$Msg) {
  if ($Yes) { return }
  if ($DryRun) { Plan "DRY: $Msg"; return }
  $Ans = Read-Host "$Msg [y/N]"
  if ($Ans -notmatch '^[yY]') { Write-Host '[install] cancelled.'; exit 0 }
}
function Have([string]$Cmd) { return $null -ne (Get-Command $Cmd -ErrorAction SilentlyContinue) }

# ---- plan first ----
Plan 'Probe and fill in Node/git/DSH (already installed at the right version = skipped; node dependencies are pulled on the fly by npx pnpm@9) -> ask for the API key -> clone -> npm install -> setup (self-check table) -> build -> start'
if (-not $DryRun) { Confirm-Step 'Continue with the plan?' }

# ---- Node ----
if (-not (Have 'node')) {
  Step 'Installing Node LTS (winget)...'
  if (-not $DryRun) {
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    # Node installed by winget is not on this session's PATH -- refresh the machine-level and user-level PATH (review: medium risk)
    $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')
  }
  if (-not (Have 'npm')) {
    Step 'Node is installed but this terminal PATH is not refreshed -- reopen the terminal and re-run this script (idempotent, what is already installed is skipped).'
    exit 1
  }
} else {
  $NodeV = (node --version) 2>$null
  Step "Node present ($NodeV), skipping."
}

# ---- git ----
if (-not (Have 'git')) {
  Step 'Installing git (winget)...'
  if (-not $DryRun) { winget install -e --id Git.Git --accept-source-agreements --accept-package-agreements }
} else { Step 'git present, skipping.' }

# ---- DSH (pinned version) ----
$DshOk = $false
if (Have 'dsh') {
  $V = (& dsh --version) 2>$null
  if ("$V".Trim() -eq $DSH_VERSION) { Step "DSH present at the right version ($V), skipping."; $DshOk = $true }
  else { Step "DSH present but version mismatch ($V != $DSH_VERSION), upgrading to the pinned version..." }
}
if (-not $DshOk) {
  if (-not $DryRun) { npm install -g "@deepseek-ai/dsh@$DSH_VERSION" }
}

# ---- API key (the only manual input) ----
if ([string]::IsNullOrEmpty($ApiKey)) {
  if (-not $DryRun) { $ApiKey = Read-Host 'DeepSeek API key (leave empty to skip if credentials are already configured)' }
}
if (-not [string]::IsNullOrEmpty($ApiKey)) {
  $CredsDir = Join-Path $env:USERPROFILE '.dsh'
  if ($DryRun) { Plan "DRY: write $CredsDir\.credentials.yaml" }
  else {
    New-Item -ItemType Directory -Force -Path $CredsDir | Out-Null
    Set-Content -Path (Join-Path $CredsDir '.credentials.yaml') -Value "version: 1`nrefs:`n  DEEPSEEK_API_KEY: $ApiKey" -Encoding utf8
    Step 'DSH credentials written (no need to open the DSH GUI).'
  }
}

# ---- clone (GitHub direct connection fails -> fall back to the codeload zip: on Chinese networks github.com is often reset or times out) ----
if (Test-Path (Join-Path $WorkspaceDir 'package.json')) {
  Step "Repository already present ($WorkspaceDir), skipping the clone."
} else {
  Step 'Cloning hellodac...'
  $cloned = $false
  if ($DryRun) { $cloned = $true }
  else {
    # PS5.1 pit (measured twice): never add a redirection on this line -- 2> or 2>&1 makes PS intercept
    # native stderr and raise NativeCommandError, which hits ErrorActionPreference=Stop at the top and
    # kills the script outright; without a redirection stderr goes straight to the console (noisy but safe),
    # and the package.json check below takes over the fallback once it fails.
    git clone https://github.com/litestartup-com/hellodac.git $WorkspaceDir
    if (Test-Path (Join-Path $WorkspaceDir 'package.json')) { $cloned = $true }
    else {
      Step 'GitHub direct connection failed, falling back to the codeload zip (usable once installed; npm run update needs a git repo, so it is not) ...'
      try {
        $zip = Join-Path $env:TEMP 'dac-master.zip'
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -UseBasicParsing -Uri 'https://codeload.github.com/litestartup-com/hellodac/zip/refs/heads/master' -OutFile $zip
        $extract = Join-Path $env:TEMP ('dac-extract-' + [guid]::NewGuid().ToString('N'))
        Expand-Archive -Path $zip -DestinationPath $extract
        $inner = Get-ChildItem $extract -Directory | Select-Object -First 1
        # A failed clone can leave a broken .git behind -- remove it wholesale and recreate, so no half-broken repo survives
        if (Test-Path $WorkspaceDir) { Remove-Item $WorkspaceDir -Recurse -Force }
        New-Item -ItemType Directory -Force -Path $WorkspaceDir | Out-Null
        Copy-Item -Path (Join-Path $inner.FullName '*') -Destination $WorkspaceDir -Recurse -Force
        Remove-Item $extract -Recurse -Force
        Remove-Item $zip -Force
        $cloned = Test-Path (Join-Path $WorkspaceDir 'package.json')
      } catch {
        $cloned = $false
      }
    }
  }
  if (-not $cloned) {
    Step 'Clone and zip fallback both failed -- check the network and re-run this script (idempotent, what is already installed is skipped).'
    exit 1
  }
}

# ---- install + setup + build + start ----
Push-Location $WorkspaceDir
try {
  if (Test-Path 'manager.config.yaml') {
    Step 'manager.config.yaml already exists -- skipping setup (edit the config directly; re-run with npm run setup -- --force).'
  } else {
    Step 'npm install + npm run setup (self-check table: node/pnpm/git/dsh each clearly red or green)...'
    if (-not $DryRun) {
      npm install
      if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
      npm run setup
      # Release lesson: the setup self-check exits 2 on red text, but the old script ignored the exit code and reported
      # "done" -- a false success must be stopped dead (no half-success state).
      if ($LASTEXITCODE -ne 0) { throw 'npm run setup failed (read the red lines of the self-check table above, fix them and re-run, idempotent)' }
    }
  }
  Step 'npm run build…'
  if (-not $DryRun) { npm run build }

  if ($Service) {
    Step 'Installing the boot service...'
    if (-not $DryRun) { npm run service -- install }
  }

  Step 'Starting the manager (it brings up the brain + personal node)...'
  if ($DryRun) { Plan 'DRY: npm start + open the browser' }
  else {
    Start-Process -FilePath 'npm.cmd' -ArgumentList 'start' -WorkingDirectory $WorkspaceDir -WindowStyle Hidden
    Step 'Done: http://127.0.0.1:8080 (initial password in .env as MANAGER_INITIAL_PASSWORD; the first login forces a password change)'
    Start-Process 'http://127.0.0.1:8080'
  }
} finally {
  Pop-Location
}
