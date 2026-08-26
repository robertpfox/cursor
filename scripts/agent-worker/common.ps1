# Shared helpers for the Den Computer My Machines worker scripts.
# Dot-source from install-den.ps1 / start.ps1 / uninstall-den.ps1.

$script:AgentWorkerTaskName = 'CursorAgentWorker'
$script:AgentWorkerDefaultName = 'den-computer'
$script:AgentWorkerManagementAddr = '127.0.0.1:18791'

function Get-AgentWorkerRepoRoot {
    return (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
}

function Write-AgentWorkerStep($message) { Write-Host "==> $message" -ForegroundColor Cyan }
function Write-AgentWorkerOk($message) { Write-Host "    $([char]0x2713) $message" -ForegroundColor Green }
function Write-AgentWorkerWarn($message) { Write-Host "    ! $message" -ForegroundColor Yellow }

function Test-AgentWorkerAdmin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    return ([Security.Principal.WindowsPrincipal]$identity).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-AgentWorkerEnvPath {
    param([string]$RepoRoot)
    $inRepo = Join-Path $RepoRoot '.cursor\agent-worker.env'
    if (Test-Path -LiteralPath $inRepo) { return $inRepo }
    $inHome = Join-Path $env:USERPROFILE '.cursor\agent-worker.env'
    if (Test-Path -LiteralPath $inHome) { return $inHome }
    return $inRepo
}

function Import-AgentWorkerEnv {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    Get-Content -LiteralPath $Path | ForEach-Object {
        $line = $_.Trim()
        if (-not $line -or $line.StartsWith('#')) { return }
        $parts = $line.Split('=', 2)
        if ($parts.Count -ne 2) { return }
        $name = $parts[0].Trim()
        $value = $parts[1].Trim().Trim('"').Trim("'")
        if (-not $name) { return }
        Set-Item -Path "Env:$name" -Value $value
    }
}

function Get-AgentWorkerDataDir {
    param([string]$RepoRoot)
    if ($env:CURSOR_DATA_DIR) { return $env:CURSOR_DATA_DIR }
    if ($env:LOCALAPPDATA) {
        return (Join-Path $env:LOCALAPPDATA 'cursor-agent-worker')
    }
    return (Join-Path $RepoRoot '.cursor\agent-worker-data')
}

function Get-AgentWorkerLogDir {
    param([string]$RepoRoot)
    $dir = Join-Path $RepoRoot 'logs'
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir | Out-Null
    }
    return $dir
}

function Find-AgentWorkerCli {
    # The CursorAgentWorker scheduled task is cmd.exe, so the path must be
    # agent.exe or agent.cmd — not agent.ps1 (Get-Command agent often returns that).
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'cursor-agent\agent.exe'),
        (Join-Path $env:LOCALAPPDATA 'cursor-agent\cursor-agent.exe'),
        (Join-Path $env:LOCALAPPDATA 'cursor-agent\agent.cmd'),
        (Join-Path $env:LOCALAPPDATA 'cursor-agent\cursor-agent.cmd'),
        (Join-Path $env:USERPROFILE '.local\bin\agent.exe'),
        (Join-Path $env:USERPROFILE '.local\bin\agent.cmd')
    )
    foreach ($path in $candidates) {
        if (Test-Path -LiteralPath $path) { return $path }
    }
    $localRoot = Join-Path $env:LOCALAPPDATA 'cursor-agent'
    if (Test-Path -LiteralPath $localRoot) {
        foreach ($filter in @('agent.exe', 'cursor-agent.exe', 'agent.cmd')) {
            $found = Get-ChildItem -Path $localRoot -Recurse -Filter $filter -ErrorAction SilentlyContinue |
                Where-Object { $_.FullName -notmatch '\\node_modules\\' } |
                Select-Object -First 1
            if ($found) { return $found.FullName }
        }
    }
    foreach ($name in @('agent.exe', 'cursor-agent.exe', 'agent.cmd')) {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue
        if ($cmd -and $cmd.Source -and ($cmd.Source -notmatch '\.ps1$')) {
            return $cmd.Source
        }
    }
    # Last resort: agent.ps1 is runnable from the PowerShell scheduled task.
    $ps1 = Get-Command agent -ErrorAction SilentlyContinue
    if ($ps1 -and $ps1.Source) { return $ps1.Source }
    return $null
}

function Install-AgentWorkerCli {
    $existing = Find-AgentWorkerCli
    if ($existing) { return $existing }

    Write-AgentWorkerStep 'Installing the Cursor agent CLI'
    $install = Invoke-RestMethod -Uri 'https://cursor.com/install?win32=true'
    Invoke-Expression $install

    $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = @($machinePath, $userPath, $env:Path) -join ';'

    $installed = Find-AgentWorkerCli
    if (-not $installed) {
        throw "The Cursor agent CLI installed but agent.exe is still not under %LOCALAPPDATA%\cursor-agent. Open a new PowerShell and re-run."
    }
    return $installed
}

function Get-AgentWorkerArgumentList {
    param(
        [string]$Name,
        [string]$WorkerDir,
        [string]$DataDir,
        [string]$ManagementAddr,
        [string]$ApiKey
    )
    # --api-key is a global `agent` flag. After `worker` the CLI rejects it.
    $args = @()
    if ($ApiKey) {
        $args += @('--api-key', $ApiKey)
    }
    $args += @(
        'worker',
        '--name', $Name,
        '--worker-dir', $WorkerDir,
        '--idle-release-timeout', '0',
        '--data-dir', $DataDir,
        '--management-addr', $ManagementAddr,
        '--debug',
        'start'
    )
    return $args
}

function Test-AgentWorkerAuth {
    param(
        [Parameter(Mandatory = $true)][string]$AgentPath,
        [string]$ApiKey
    )
    if ($ApiKey) { return $true }
    $statusJson = & $AgentPath 'status' '--format' 'json' 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $statusJson) { return $false }
    try {
        $status = $statusJson | ConvertFrom-Json
        return [bool]$status.isAuthenticated
    } catch {
        return $false
    }
}
