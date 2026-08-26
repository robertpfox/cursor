<#
.SYNOPSIS
    Removes the Cursor My Machines worker from the Den Computer.

.DESCRIPTION
    Stops and unregisters the CursorAgentWorker scheduled task. Logs and the
    CLI stay in place unless you pass -PurgeData.
#>

[CmdletBinding()]
param(
    [switch]$PurgeData
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$repoRoot = Get-AgentWorkerRepoRoot
$taskName = $script:AgentWorkerTaskName

Write-AgentWorkerStep "Stopping $taskName"
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Write-AgentWorkerOk 'task removed'

$launcher = Join-Path $PSScriptRoot 'run-agent-worker.cmd'
if (Test-Path -LiteralPath $launcher) {
    Remove-Item -LiteralPath $launcher -Force
    Write-AgentWorkerOk 'launcher removed'
}

if ($PurgeData) {
    $dataDir = Get-AgentWorkerDataDir $repoRoot
    if (Test-Path -LiteralPath $dataDir) {
        Remove-Item -LiteralPath $dataDir -Recurse -Force
        Write-AgentWorkerOk "purged $dataDir"
    }
} else {
    Write-Host ''
    Write-Host "  Logs and worker data were left in place. Re-run install-den.ps1 to come back online."
}
Write-Host ''
