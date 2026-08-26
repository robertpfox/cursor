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
    if (-not (Test-Path -LiteralPath (Join-Path $Path '.git'))) { return $false }
    Push-Location $Path
    try {
        $remote = (git remote get-url origin 2>$null)
        return [bool]($remote -and ($remote -match 'robertpfox/cursor'))
    } finally {
        Pop-Location
    }
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

    Write-BootStep "Cloning $RepoUrl -> $cloneTo"
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        throw "git is not on PATH. Install Git for Windows, then re-run this script."
    }
    if (Test-Path -LiteralPath (Join-Path $cloneTo '.git')) {
        return (Resolve-Path $cloneTo).Path
    }
    New-Item -ItemType Directory -Path (Split-Path $cloneTo) -Force | Out-Null
    git clone --branch $Branch --single-branch $RepoUrl $cloneTo
    return (Resolve-Path $cloneTo).Path
}

Write-Host ''
Write-Host '  Den Computer My Machines bootstrap' -ForegroundColor White
Write-Host ''

$root = Resolve-WorkerDir -Hint $WorkerDir
Write-BootOk "repo $root"

Write-BootStep "Updating $Branch"
Push-Location $root
try {
    git fetch origin $Branch
    git checkout $Branch
    git pull --ff-only origin $Branch
} finally {
    Pop-Location
}

$installer = Join-Path $root 'scripts\agent-worker\install-den.ps1'
if (-not (Test-Path -LiteralPath $installer)) {
    throw "Installer missing at $installer. Is branch $Branch pushed?"
}

Write-BootStep 'Running install-den.ps1'
& $installer
exit $LASTEXITCODE
