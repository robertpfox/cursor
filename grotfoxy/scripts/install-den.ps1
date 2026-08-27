<#
.SYNOPSIS
    Installs GrotFoxy as an always-on service on the Den Computer (Windows).

.DESCRIPTION
    Sets up GrotFoxy so it starts with the machine and keeps running whether or
    not anyone is signed in:

      1. Verifies Node.js 22.5+ (node:sqlite ships with it, so nothing compiles).
      2. Writes a .env with a stable port and a generated master secret.
      3. Registers a Scheduled Task that starts GrotFoxy at boot and restarts it
         if it ever exits.
      4. Opens the port on the private-network firewall profile so your phone
         and laptop on the same Wi-Fi can reach it.
      5. Starts it and prints the URLs to use.

    Re-running is safe: every step is idempotent.

.PARAMETER Port
    TCP port to listen on. Default 8787.

.PARAMETER BindAddress
    Interface to bind. Default 0.0.0.0 (all interfaces, so the LAN can reach it).
    Use 127.0.0.1 to keep it to this machine only.

.PARAMETER NoFirewall
    Skip the firewall rule.

.PARAMETER NoAutoStart
    Register the task but do not start GrotFoxy now.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\install-den.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\install-den.ps1 -Port 9000
#>

# Write-Host is the right call for an interactive installer: coloured progress
# on a console is the point, and nothing downstream consumes this output.
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '',
    Justification = 'Interactive installer output is meant for a human console.')]
[CmdletBinding()]
param(
    [int]$Port = 8787,
    [string]$BindAddress = '0.0.0.0',
    [string]$StateDir = (Join-Path $env:LOCALAPPDATA 'GrotFoxy'),
    [switch]$NoFirewall,
    [switch]$NoAutoStart
)

$ErrorActionPreference = 'Stop'
$TaskName = 'GrotFoxy'
$AppRoot = Split-Path -Parent $PSScriptRoot

function Write-Step($message) { Write-Host "==> $message" -ForegroundColor Cyan }
function Write-Ok($message) { Write-Host "    $([char]0x2713) $message" -ForegroundColor Green }
function Write-Warn2($message) { Write-Host "    ! $message" -ForegroundColor Yellow }

function Test-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    return ([Security.Principal.WindowsPrincipal]$identity).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

Write-Host ''
Write-Host '  GrotFoxy installer - Den Computer' -ForegroundColor White
Write-Host "  $AppRoot"
Write-Host ''

# --- 1. Node -----------------------------------------------------------------

Write-Step 'Checking Node.js'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    throw "Node.js is not installed or not on PATH. Install Node 22 LTS or newer from https://nodejs.org and re-run this script."
}
$versionText = (& node --version).TrimStart('v')
$version = [version]($versionText -replace '-.*$', '')
if ($version -lt [version]'22.5.0') {
    throw "Node $versionText is too old. GrotFoxy needs 22.5.0 or newer for the built-in SQLite module."
}
Write-Ok "node $versionText at $($node.Source)"

# GrotFoxy has no runtime dependencies, so there is nothing to install. Run it
# only if someone has added packages to a fork.
if (Test-Path (Join-Path $AppRoot 'package-lock.json')) {
    Write-Step 'Installing dependencies'
    Push-Location $AppRoot
    try { & npm install --omit=dev --no-audit --no-fund | Out-Null; Write-Ok 'dependencies ready' }
    finally { Pop-Location }
}

# --- 2. Configuration --------------------------------------------------------

# Deliberately outside the checkout: data\ is gitignored, so leaving the
# database in the repo means `git clean -xdf` silently destroys every bot,
# transcript and API key.
Write-Step 'Preparing the state directory'
foreach ($dir in @((Join-Path $StateDir 'data'), (Join-Path $StateDir 'workspace'), (Join-Path $AppRoot 'logs'))) {
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
}

$stamp = Get-Date -Format 'yyyyMMddHHmmss'
foreach ($legacy in @('data', 'workspace')) {
    $src = Join-Path $AppRoot $legacy
    $dest = Join-Path $StateDir $legacy
    $hasSource = (Test-Path $src) -and (Get-ChildItem -LiteralPath $src -Force -ErrorAction SilentlyContinue)
    $destEmpty = -not (Get-ChildItem -LiteralPath $dest -Force -ErrorAction SilentlyContinue)
    if ($hasSource -and $destEmpty) {
        Copy-Item -Path (Join-Path $src '*') -Destination $dest -Recurse -Force
        # The backup goes outside the repo too. It contains master.key, so
        # leaving it in a checkout is how a private key reaches a public commit.
        $backupRoot = Join-Path $StateDir 'backups'
        if (-not (Test-Path $backupRoot)) { New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null }
        Move-Item -LiteralPath $src -Destination (Join-Path $backupRoot "$legacy-$stamp")
        Write-Ok "migrated $legacy\ out of the checkout (backup in $backupRoot)"
    }
}
Write-Ok "state lives in $StateDir"

Write-Step 'Writing configuration'
$envFile = Join-Path $AppRoot '.env'
if (Test-Path $envFile) {
    Write-Ok ".env already exists - leaving it alone ($envFile)"
} else {
    $secretBytes = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($secretBytes)
    $secret = -join ($secretBytes | ForEach-Object { $_.ToString('x2') })

    @"
# GrotFoxy configuration - generated by install-den.ps1
GROTFOXY_HOST=$BindAddress
GROTFOXY_PORT=$Port

# Encrypts stored API keys. Changing it makes existing keys unreadable.
GROTFOXY_SECRET=$secret

GROTFOXY_DATA_DIR=$(Join-Path $StateDir 'data')
GROTFOXY_WORKSPACE_DIR=$(Join-Path $StateDir 'workspace')
GROTFOXY_LOG_LEVEL=info
"@ | Set-Content -Path $envFile -Encoding UTF8
    Write-Ok "created $envFile"
}

# --- 3. Scheduled task -------------------------------------------------------

Write-Step 'Registering the startup task'
if (-not (Test-Admin)) {
    Write-Warn2 'Not running as Administrator.'
    Write-Warn2 'The task will run at logon instead of at boot, and the firewall rule will be skipped.'
}

$launcher = Join-Path $AppRoot 'scripts\run-grotfoxy.cmd'
@"
@echo off
rem Launcher used by the GrotFoxy scheduled task. Keeps the server alive.
cd /d "%~dp0.."
:loop
node --experimental-sqlite --no-warnings src\index.js >> logs\grotfoxy.log 2>&1
echo [%date% %time%] GrotFoxy exited, restarting in 10s >> logs\grotfoxy.log
timeout /t 10 /nobreak > nul
goto loop
"@ | Set-Content -Path $launcher -Encoding ASCII
Write-Ok "launcher written to $launcher"

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Ok 'removed the previous task'
}

$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$launcher`"" -WorkingDirectory $AppRoot
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew

if (Test-Admin) {
    # S4U runs at boot, without you signed in, and without a stored password,
    # but as *you*, not SYSTEM. That matters: a bot with the run_command tool
    # executes with whatever rights this task has, and handing an autonomous
    # agent SYSTEM on your own machine is not a reasonable default.
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) `
        -LogonType S4U -RunLevel Limited
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
        -Principal $principal -Settings $settings `
        -Description 'GrotFoxy - self-hosted AI teammates' | Out-Null
    Write-Ok "task registered to start at boot as $($principal.UserId) (not SYSTEM)"
} else {
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
        -Settings $settings -Description 'GrotFoxy - self-hosted AI teammates' | Out-Null
    Write-Ok 'task registered to start when you sign in'
}

# --- 4. Firewall -------------------------------------------------------------

if (-not $NoFirewall -and (Test-Admin)) {
    Write-Step 'Opening the firewall on private networks'
    $ruleName = "GrotFoxy ($Port)"
    Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue |
        Remove-NetFirewallRule -ErrorAction SilentlyContinue
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow `
        -Protocol TCP -LocalPort $Port -Profile Private,Domain | Out-Null
    Write-Ok "TCP $Port allowed on private and domain networks (public stays blocked)"
} elseif (-not $NoFirewall) {
    Write-Warn2 "Skipped the firewall rule - re-run as Administrator, or allow TCP $Port manually."
}

# --- 5. Start ----------------------------------------------------------------

if (-not $NoAutoStart) {
    Write-Step 'Starting GrotFoxy'
    Start-ScheduledTask -TaskName $TaskName
    $ready = $false
    $lastError = 'no response'
    foreach ($attempt in 1..30) {
        Start-Sleep -Milliseconds 700
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 2
            if ($health.ok) { $ready = $true; break }
        } catch {
            # Expected while the service is still starting. Keep the last
            # failure so it can be reported if it never comes up.
            $lastError = $_.Exception.Message
        }
    }
    if ($ready) {
        Write-Ok 'GrotFoxy is responding'
    } else {
        Write-Warn2 "Nothing answering on port $Port after 21s. Last error: $lastError"
        Write-Warn2 "Check $AppRoot\logs\grotfoxy.log"
    }
}

# --- Done --------------------------------------------------------------------

$addresses = @(
    Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
        Select-Object -ExpandProperty IPAddress -Unique
)

Write-Host ''
Write-Host '  GrotFoxy is installed on the Den Computer.' -ForegroundColor Green
Write-Host ''
Write-Host "  On this machine:  http://localhost:$Port"
foreach ($address in $addresses) {
    Write-Host "  From your phone:  http://${address}:$Port"
}
Write-Host ''
Write-Host "  State:   $StateDir   (back this up)"
Write-Host ''
Write-Host '  Open it and create your owner account. Then add a model provider'
Write-Host '  in Settings - your own API key, or a local Ollama for zero cost.'
Write-Host ''
Write-Host '  Manage the service:'
Write-Host "    Start-ScheduledTask -TaskName $TaskName"
Write-Host "    Stop-ScheduledTask  -TaskName $TaskName"
Write-Host "    Get-Content $AppRoot\logs\grotfoxy.log -Tail 50 -Wait"
Write-Host ''
