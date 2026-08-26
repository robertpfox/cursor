<#
.SYNOPSIS
    Start a Cursor My Machines worker in the foreground.

.DESCRIPTION
    Equivalent of `agent worker start` with Den Computer defaults:

      --name den-computer
      --worker-dir <this repo>
      --idle-release-timeout 0
      --management-addr 127.0.0.1:18791

    Run this on the Den Computer. Do not run it inside a Cursor-hosted Cloud
    Agent VM — that would register the ephemeral VM, not your machine.

    Auth is one of:
      - `agent login` (browser) already done in this Windows session
      - CURSOR_API_KEY in the environment
      - .cursor/agent-worker.env next to this repo (gitignored)

.PARAMETER Name
    Display name shown in cursor.com/agents. Default den-computer.

.PARAMETER WorkerDir
    Git checkout the worker exposes. Default: this repository root.

.PARAMETER DryRun
    Print the resolved command and exit without connecting.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\agent-worker\start.ps1
#>

[CmdletBinding()]
param(
    [string]$Name = $env:CURSOR_WORKER_NAME,
    [string]$WorkerDir,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$repoRoot = Get-AgentWorkerRepoRoot
if (-not $Name) { $Name = $script:AgentWorkerDefaultName }
if (-not $WorkerDir) { $WorkerDir = $repoRoot }

Import-AgentWorkerEnv (Get-AgentWorkerEnvPath $repoRoot)

if (Test-AgentWorkerWsl) {
    $den = "curl -fsSL https://raw.githubusercontent.com/robertpfox/cursor/cursor/agent-worker-start-4281/den.sh -o /tmp/den.sh && exec bash /tmp/den.sh"
    Write-Host "  wsl.exe -d $(Get-AgentWorkerWslDistro) -- bash -lic `"$den`""
    if ($DryRun) { exit 0 }
    Write-AgentWorkerStep 'Native Windows CLI currently crashes. Starting via Ubuntu WSL.'
    $code = Invoke-AgentWorkerWsl -WslArgs @('--', 'bash', '-lic', $den)
    exit $code
}

if (-not $env:AGENT_WORKER_ALLOW_NATIVE) {
    Write-Host 'Ubuntu WSL is required. The native Windows CLI currently crashes (better-sqlite3 ABI).' -ForegroundColor Yellow
    Write-Host '  wsl --install -d Ubuntu'
    Write-Host 'Or Win+R: powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/robertpfox/cursor/cursor/agent-worker-start-4281/den.ps1 | iex"'
    exit 1
}

$agentPath = Find-AgentWorkerCli
if (-not $agentPath) {
    throw "The Cursor agent CLI is not installed. Run scripts\agent-worker\install-den.ps1 or: irm 'https://cursor.com/install?win32=true' | iex"
}

$dataDir = Get-AgentWorkerDataDir $repoRoot
$argList = Get-AgentWorkerArgumentList `
    -Name $Name `
    -WorkerDir $WorkerDir `
    -DataDir $dataDir `
    -ManagementAddr $script:AgentWorkerManagementAddr `
    -ApiKey $env:CURSOR_API_KEY
$argList += '--verbose'

$displayArgs = foreach ($item in $argList) {
    if ($env:CURSOR_API_KEY -and $item -eq $env:CURSOR_API_KEY) { '<redacted>' } else { $item }
}

Write-Host "  $($agentPath) $($displayArgs -join ' ')"
Write-Host "  data dir: $dataDir"

if ($DryRun) { exit 0 }

if (-not (Test-AgentWorkerAuth -AgentPath $agentPath -ApiKey $env:CURSOR_API_KEY)) {
    Write-Host ''
    Write-Host 'Authentication required. On the Den Computer run one of:' -ForegroundColor Yellow
    Write-Host '  agent login'
    Write-Host '  or put a personal API key in .cursor\agent-worker.env as CURSOR_API_KEY=...'
    Write-Host '  (https://cursor.com/dashboard/api — a *personal* user key, not a team/org key)'
    exit 1
}

if (-not (Test-Path -LiteralPath $dataDir)) {
    New-Item -ItemType Directory -Path $dataDir | Out-Null
}

& $agentPath @argList
exit $LASTEXITCODE
