<#
.SYNOPSIS
    Removes the GrotFoxy service from the Den Computer.

.DESCRIPTION
    Stops and unregisters the scheduled task and removes the firewall rule.
    Your data folder is left alone unless you pass -PurgeData.

.PARAMETER Port
    Port used when installing, so the matching firewall rule can be found.

.PARAMETER PurgeData
    Also delete data\ (the database, master key and every transcript) and
    workspace\ (all bot files). There is no undo.
#>

[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '',
    Justification = 'Interactive uninstaller output is meant for a human console.')]
[CmdletBinding()]
param(
    [int]$Port = 8787,
    [string]$StateDir = (Join-Path $env:LOCALAPPDATA 'GrotFoxy'),
    [switch]$PurgeData
)

$ErrorActionPreference = 'Stop'
$TaskName = 'GrotFoxy'
$AppRoot = Split-Path -Parent $PSScriptRoot

Write-Host "==> Stopping $TaskName" -ForegroundColor Cyan
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Write-Host '    task removed' -ForegroundColor Green

Write-Host '==> Removing the firewall rule' -ForegroundColor Cyan
Get-NetFirewallRule -DisplayName "GrotFoxy ($Port)" -ErrorAction SilentlyContinue |
    Remove-NetFirewallRule -ErrorAction SilentlyContinue
Write-Host '    done' -ForegroundColor Green

Write-Host '==> Removing the generated launcher' -ForegroundColor Cyan
$launcher = Join-Path $AppRoot 'scripts\run-grotfoxy.cmd'
if (Test-Path $launcher) { Remove-Item -LiteralPath $launcher -Force }
Write-Host '    done' -ForegroundColor Green

if ($PurgeData) {
    Write-Host "==> Deleting $StateDir" -ForegroundColor Yellow
    if (Test-Path $StateDir) { Remove-Item -LiteralPath $StateDir -Recurse -Force }
    Write-Host '    purged' -ForegroundColor Green
} else {
    Write-Host ''
    Write-Host "  Your data is still at $StateDir - re-running the installer picks up where you left off."
}
Write-Host ''
