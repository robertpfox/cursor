<#
.SYNOPSIS
    One-shot bootstrap: get this repo onto the Den Computer and start the
    My Machines worker.

.DESCRIPTION
    Safe to paste as:

      irm https://raw.githubusercontent.com/robertpfox/cursor/cursor/agent-worker-start-4281/scripts/agent-worker/bootstrap-den.ps1 | iex

    or to run from a clone of this repo. It:

      1. Finds or clones github.com/robertpfox/cursor
      2. Checks out the worker branch
      3. Runs install-den.ps1 (CLI + scheduled task + start)

    If this Windows user is not signed in, install-den.ps1 runs `agent login`
    (browser) before starting the worker.

.PARAMETER RepoUrl
    Git remote. Default: https://github.com/robertpfox/cursor.git

.PARAMETER Branch
    Branch that contains the worker scripts.

.PARAMETER WorkerDir
    Existing checkout. Detected automatically when omitted.
#>

[CmdletBinding()]
param(
    [string]$RepoUrl = 'https://github.com/robertpfox/cursor.git',
    [string]$Branch = 'cursor/agent-worker-start-4281',
    [string]$WorkerDir
)

$ErrorActionPreference = 'Stop'

function Write-BootStep($message) { Write-Host "==> $message" -ForegroundColor Cyan }
function Write-BootOk($message) { Write-Host "    $([char]0x2713) $message" -ForegroundColor Green }

function Test-CursorConfigRepo([string]$Path) {
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return $false }
    if (Test-Path -LiteralPath (Join-Path $Path 'scripts\agent-worker\install-den.ps1')) { return $true }
    if (-not (Test-Path -LiteralPath (Join-Path $Path '.git'))) { return $false }
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { return $false }
    Push-Location $Path
    try {
        $remote = (git remote get-url origin 2>$null)
        return [bool]($remote -and ($remote -match 'robertpfox/cursor'))
    } finally {
        Pop-Location
    }
}

function Install-FromGithubZip([string]$Dest) {
    $encoded = [uri]::EscapeDataString($Branch)
    $zipUrl = "https://github.com/robertpfox/cursor/archive/refs/heads/$encoded.zip"
    $zipPath = Join-Path $env:TEMP 'cursor-agent-worker.zip'
    $extractRoot = Join-Path $env:TEMP 'cursor-agent-worker-extract'
    Write-BootStep "Downloading $zipUrl"
    if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
    if (Test-Path -LiteralPath $extractRoot) { Remove-Item -LiteralPath $extractRoot -Recurse -Force }
    Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing
    Expand-Archive -Path $zipPath -DestinationPath $extractRoot -Force
    $installer = Get-ChildItem -Path $extractRoot -Recurse -Filter 'install-den.ps1' |
        Where-Object { $_.Directory.Name -eq 'agent-worker' } |
        Select-Object -First 1
    if (-not $installer) { throw "Zip from $zipUrl did not contain scripts\\agent-worker\\install-den.ps1" }
    $sourceRoot = $installer.Directory.Parent.Parent.FullName
    New-Item -ItemType Directory -Path $Dest -Force | Out-Null
    Copy-Item -Path (Join-Path $sourceRoot '*') -Destination $Dest -Recurse -Force
    return (Resolve-Path $Dest).Path
}

function Resolve-WorkerDir {
    param([string]$Hint)
    if ($Hint -and (Test-CursorConfigRepo $Hint)) { return (Resolve-Path $Hint).Path }

    $here = (Get-Location).Path
    if (Test-CursorConfigRepo $here) { return $here }

    $scriptDir = $PSScriptRoot
    if ($scriptDir) {
        $fromScript = (Resolve-Path (Join-Path $scriptDir '..\..')).Path
        if (Test-CursorConfigRepo $fromScript) { return $fromScript }
    }

    foreach ($candidate in @('C:\cursor', (Join-Path $env:USERPROFILE 'cursor'), (Join-Path $env:USERPROFILE 'src\cursor'))) {
        if (Test-CursorConfigRepo $candidate) { return $candidate }
    }

    $cloneTo = 'C:\cursor'
    if ((Test-Path -LiteralPath $cloneTo) -and -not (Test-Path -LiteralPath (Join-Path $cloneTo '.git'))) {
        $cloneTo = Join-Path $env:USERPROFILE 'cursor'
    }

    Write-BootStep "Fetching $RepoUrl ($Branch) -> $cloneTo"
    if (Get-Command git -ErrorAction SilentlyContinue) {
        if (Test-Path -LiteralPath (Join-Path $cloneTo '.git')) {
            return (Resolve-Path $cloneTo).Path
        }
        $parent = Split-Path $cloneTo
        if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
        git clone --branch $Branch --single-branch $RepoUrl $cloneTo
        return (Resolve-Path $cloneTo).Path
    }
    return Install-FromGithubZip $cloneTo
}

Write-Host ''
Write-Host '  Den Computer My Machines bootstrap' -ForegroundColor White
Write-Host ''

if (Get-Command wsl.exe -ErrorAction SilentlyContinue) {
    $names = @()
    foreach ($line in (& wsl.exe -l -q 2>$null)) {
        $clean = (($line -replace "`0", '')).Trim()
        if ($clean) { $names += $clean }
    }
    $usable = @($names | Where-Object { $_ -and ($_ -notmatch '^(docker-desktop|docker-desktop-data|podman-machine|rancher-desktop)') })
    $distro = $null
    foreach ($want in @('Ubuntu', 'Ubuntu-24.04', 'Ubuntu-22.04', 'Ubuntu-20.04')) {
        $hit = $usable | Where-Object { $_ -eq $want } | Select-Object -First 1
        if ($hit) { $distro = [string]$hit; break }
    }
    if (-not $distro) { $distro = $usable | Where-Object { $_ -like 'Ubuntu*' } | Select-Object -First 1 }
    if (-not $distro) { $distro = $usable | Select-Object -First 1 }
    $probe = if ($distro) { & wsl.exe -d $distro -e true 2>$null; $LASTEXITCODE } else { 1 }
    if ($probe -eq 0) {
        Write-BootStep 'WSL is ready; using the Linux CLI (Windows agent worker currently crashes)'
        if ($distro) { Write-BootOk "distro $distro (not docker-desktop)" }
        if ($distro) {
            wsl.exe -d $distro -e bash -lc "curl -fsSL https://raw.githubusercontent.com/robertpfox/cursor/$Branch/scripts/agent-worker/install-den-wsl.sh -o /tmp/install-den-wsl.sh && bash /tmp/install-den-wsl.sh"
        } else {
            wsl.exe -e bash -lc "curl -fsSL https://raw.githubusercontent.com/robertpfox/cursor/$Branch/scripts/agent-worker/install-den-wsl.sh -o /tmp/install-den-wsl.sh && bash /tmp/install-den-wsl.sh"
        }
        $wslCode = $LASTEXITCODE
        $taskName = 'CursorAgentWorker'
        $launcherDir = Join-Path $env:LOCALAPPDATA 'CursorAgentWorker'
        New-Item -ItemType Directory -Path $launcherDir -Force | Out-Null
        $cmdPath = Join-Path $launcherDir 'start-den-wsl.cmd'
        $distroFlag = if ($distro) { "-d $distro " } else { '' }
        @(
            '@echo off',
            "wsl.exe ${distroFlag}-e bash -lc `"exec bash `$HOME/.local/share/cursor-agent-worker/wsl-worker-loop.sh`""
        ) | Set-Content -Path $cmdPath -Encoding ASCII
        $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if ($existing) {
            Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        }
        $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$cmdPath`""
        $trigger = New-ScheduledTaskTrigger -AtLogOn
        $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
        Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
            -Description 'Cursor My Machines worker (den-computer) via WSL' | Out-Null
        Write-BootOk "scheduled task $taskName (WSL worker at logon)"
        exit $wslCode
    }
    Write-Host '    ! WSL exists but no distro is running. After `wsl --install -d Ubuntu` and a reboot, re-run this.' -ForegroundColor Yellow
} else {
    Write-Host '    ! WSL is not installed. Native Windows agent worker currently crashes (better-sqlite3 ABI).' -ForegroundColor Yellow
    Write-Host '      Install Ubuntu WSL, reboot, then paste this one-liner again:' -ForegroundColor Yellow
    Write-Host '        wsl --install -d Ubuntu' -ForegroundColor Yellow
}

try {
    $root = Resolve-WorkerDir -Hint $WorkerDir
    Write-BootOk "repo $root"

    Write-BootStep "Updating $Branch"
    if (Get-Command git -ErrorAction SilentlyContinue) {
        Push-Location $root
        try {
            if (Test-Path -LiteralPath (Join-Path $root '.git')) {
                git fetch origin $Branch
                git checkout $Branch
                git pull --ff-only origin $Branch
            } else {
                Write-BootStep 'No .git directory; refreshing from GitHub zip'
                $null = Install-FromGithubZip $root
            }
        } finally {
            Pop-Location
        }
    } else {
        $null = Install-FromGithubZip $root
    }
} catch {
    Write-Host "    ! repo fetch failed: $($_.Exception.Message)" -ForegroundColor Yellow
    $root = Join-Path $env:USERPROFILE 'cursor'
    New-Item -ItemType Directory -Path $root -Force | Out-Null
    if ((Get-Command git -ErrorAction SilentlyContinue) -and -not (Test-Path -LiteralPath (Join-Path $root '.git'))) {
        Push-Location $root
        try {
            git init | Out-Null
            git remote add origin $RepoUrl 2>$null
        } finally {
            Pop-Location
        }
    }
    Write-BootOk "fallback worker-dir $root (git remote origin=$RepoUrl)"
}

$installer = Join-Path $root 'scripts\agent-worker\install-den.ps1'
if (Test-Path -LiteralPath $installer) {
    Write-BootStep 'Running install-den.ps1'
    & $installer
    exit $LASTEXITCODE
}

Write-BootStep 'Installer not on disk; starting the worker in the foreground'
$install = Invoke-RestMethod -Uri 'https://cursor.com/install?win32=true'
Invoke-Expression $install
$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$env:Path = @($machinePath, $userPath, $env:Path) -join ';'
$agent = Get-Command agent.exe -ErrorAction SilentlyContinue
if (-not $agent) { $agent = Get-Command agent -ErrorAction SilentlyContinue }
if (-not $agent) { throw 'Cursor agent CLI is not on PATH after install.' }
& $agent.Source login
& $agent.Source worker --name den-computer --worker-dir $root --idle-release-timeout 0 --management-addr 127.0.0.1:18791 --debug start --verbose
exit $LASTEXITCODE
