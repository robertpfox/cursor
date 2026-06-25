# Completes moving C:\Users\IT\.cursor -> C:\cursor\.cursor
# IMPORTANT: Fully quit Cursor before running (File -> Exit, or close all windows).

$ErrorActionPreference = 'Stop'
$src = 'C:\Users\IT\.cursor'
$dest = 'C:\cursor\.cursor'

if (-not (Test-Path -LiteralPath $dest)) {
    Write-Error "Destination missing: $dest"
}

$item = Get-Item -LiteralPath $src -Force -ErrorAction SilentlyContinue
if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    Write-Host "Already complete: $src -> $((Get-Item $src).Target)"
    exit 0
}

# Sync any last changes from old location into C:\cursor\.cursor
Write-Host "Syncing $src -> $dest ..."
robocopy $src $dest /E /COPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy sync failed with exit $LASTEXITCODE" }

Write-Host "Removing $src ..."
Remove-Item -LiteralPath $src -Recurse -Force

Write-Host "Creating junction $src -> $dest"
cmd /c "mklink /J `"$src`" `"$dest`"" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "mklink failed with exit $LASTEXITCODE" }

Write-Host ""
Write-Host "Success. Your Cursor config now lives at C:\cursor\.cursor"
Write-Host "C:\Users\IT\.cursor is a junction so Cursor keeps working normally."
Get-Item -LiteralPath $src | Format-List FullName, LinkType, Target
