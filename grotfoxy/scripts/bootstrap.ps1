<#
.SYNOPSIS
    One-command GrotFoxy install for Windows.

.DESCRIPTION
    Run this in PowerShell and it will:

      1. Check for git and Node 22.5+, offering to install either via winget.
      2. Clone GrotFoxy into its own folder (C:\GrotFoxy by default).
      3. Run the service installer.
      4. Open the app in your browser.

    It deliberately does NOT touch an existing checkout such as C:\cursor —
    checking a feature branch out over your live Cursor config would swap that
    repo's contents out from under you.

.PARAMETER Home
    Where to put GrotFoxy. Default C:\GrotFoxy.

.PARAMETER Port
    Port to serve on. Default 8787.

.EXAMPLE
    irm https://raw.githubusercontent.com/robertpfox/cursor/cursor/grotfoxy-self-hosted-ai-teammates-bd6b/grotfoxy/scripts/bootstrap.ps1 | iex

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\bootstrap.ps1 -Home D:\GrotFoxy -Port 9000
#>

[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '',
    Justification = 'Interactive bootstrap output is meant for a human console.')]
[CmdletBinding()]
param(
    [string]$InstallHome = 'C:\GrotFoxy',
    [int]$Port = 8787,
    [string]$Repo = 'https://github.com/robertpfox/cursor.git',
    [string]$Branch = 'cursor/grotfoxy-self-hosted-ai-teammates-bd6b'
)

$ErrorActionPreference = 'Stop'

function Write-Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Write-Ok($m) { Write-Host "    $([char]0x2713) $m" -ForegroundColor Green }
function Write-Bad($m) { Write-Host "    $([char]0x2717) $m" -ForegroundColor Red }

function Install-WithWinget($id, $label) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Write-Bad "$label is missing and winget is not available to install it."
        Write-Host "    Install $label manually, then re-run this script."
        exit 1
    }
    Write-Host "    installing $label via winget..."
    winget install --id $id --exact --accept-source-agreements --accept-package-agreements --silent
    # winget updates PATH for new processes only; refresh this one.
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                [Environment]::GetEnvironmentVariable('Path', 'User')
}

Write-Host ''
Write-Host '  GrotFoxy bootstrap' -ForegroundColor White

# --- prerequisites ------------------------------------------------------------

Write-Step 'Checking prerequisites'

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Install-WithWinget 'Git.Git' 'Git'
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        Write-Bad 'Git still not on PATH. Open a new PowerShell window and re-run.'
        exit 1
    }
}
Write-Ok "git $((git --version) -replace 'git version ','')"

$needNode = $true
if (Get-Command node -ErrorAction SilentlyContinue) {
    $raw = (& node --version).TrimStart('v')
    $version = [version]($raw -replace '-.*$', '')
    if ($version -ge [version]'22.5.0') { $needNode = $false; Write-Ok "node $raw" }
    else { Write-Host "    node $raw is too old (need 22.5.0+ for the built-in SQLite module)" }
}
if ($needNode) {
    Install-WithWinget 'OpenJS.NodeJS.LTS' 'Node.js LTS'
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Bad 'Node still not on PATH. Open a new PowerShell window and re-run this script.'
        exit 1
    }
    Write-Ok "node $((& node --version).TrimStart('v'))"
}

# --- fetch --------------------------------------------------------------------

Write-Step "Fetching GrotFoxy into $InstallHome"
if (Test-Path (Join-Path $InstallHome '.git')) {
    git -C $InstallHome remote set-url origin $Repo
    git -C $InstallHome fetch --depth 1 origin $Branch 2>&1 | Out-Null
    git -C $InstallHome checkout -B grotfoxy FETCH_HEAD 2>&1 | Out-Null
    Write-Ok 'updated existing checkout'
} elseif (Test-Path $InstallHome) {
    Write-Bad "$InstallHome exists but is not a git checkout. Move it aside or pass -InstallHome."
    exit 1
} else {
    git clone --depth 1 --branch $Branch $Repo $InstallHome 2>&1 | Out-Null
    if (-not (Test-Path (Join-Path $InstallHome '.git'))) {
        Write-Bad "Could not clone $Repo (branch $Branch)."
        exit 1
    }
    Write-Ok 'cloned'
}

$app = Join-Path $InstallHome 'grotfoxy'
if (-not (Test-Path $app)) {
    Write-Bad "The checkout has no grotfoxy folder - wrong branch?"
    exit 1
}

# --- install ------------------------------------------------------------------

Write-Step 'Running the installer'
& (Join-Path $app 'scripts\install-den.ps1') -Port $Port

Start-Process "http://localhost:$Port"
Write-Host "  Installed at $app"
Write-Host ''
