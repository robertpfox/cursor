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

[CmdletBinding()]
param(
    [int]$Port = 8787,
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

if ($PurgeData) {
    Write-Host '==> Deleting data and workspace' -ForegroundColor Yellow
    foreach ($dir in @('data', 'workspace')) {
        $path = Join-Path $AppRoot $dir
        if (Test-Path $path) { Remove-Item -LiteralPath $path -Recurse -Force }
    }
    Write-Host '    purged' -ForegroundColor Green
} else {
    Write-Host ''
    Write-Host "  Your data is still at $AppRoot\data - re-running the installer picks up where you left off."
}
Write-Host ''
