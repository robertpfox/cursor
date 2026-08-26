# Tiny Win+R entrypoint for the Den Computer My Machines worker.
# Safe to irm | iex. Auto-picks Ubuntu WSL and skips docker-desktop.
# Never starts the broken native Windows CLI.
$ErrorActionPreference = 'Stop'
$Branch = if ($env:CURSOR_WORKER_BRANCH) { $env:CURSOR_WORKER_BRANCH } else { 'cursor/agent-worker-start-4281' }
$Url = "https://raw.githubusercontent.com/robertpfox/cursor/$Branch/den.sh"

function Get-UbuntuWslDistro {
    if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) { return $null }
    $names = @()
    foreach ($line in (& wsl.exe -l -q 2>$null)) {
        $clean = (($line -replace "`0", '') -replace [char]0xFEFF, '').Trim()
        if ($clean) { $names += $clean }
    }
    $skip = [regex]'^(docker-desktop|docker-desktop-data|podman-machine|rancher-desktop)'
    $usable = @($names | Where-Object { $_ -and ($_ -notmatch $skip) })
    foreach ($want in @('Ubuntu', 'Ubuntu-24.04', 'Ubuntu-22.04', 'Ubuntu-20.04')) {
        $hit = $usable | Where-Object { $_ -eq $want } | Select-Object -First 1
        if ($hit) { return [string]$hit }
    }
    $ubuntu = $usable | Where-Object { $_ -like 'Ubuntu*' } | Select-Object -First 1
    if ($ubuntu) { return [string]$ubuntu }
    return $null
}

function Install-UbuntuWsl {
    Write-Host 'No Ubuntu WSL distro found. The native Windows CLI currently crashes.'
    Write-Host 'Installing Ubuntu WSL (UAC / reboot may be required). Then this script continues if Ubuntu is ready.'
    $installArgs = @('--install', '-d', 'Ubuntu')
    $wsl = Get-Command wsl.exe -ErrorAction SilentlyContinue
    if (-not $wsl) {
        Start-Process -FilePath "$env:SystemRoot\System32\wsl.exe" -ArgumentList $installArgs -Verb RunAs -Wait
        return
    }
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & wsl.exe @installArgs
    $code = $LASTEXITCODE
    $ErrorActionPreference = $prev
    if ($code -ne 0) {
        Start-Process -FilePath 'wsl.exe' -ArgumentList $installArgs -Verb RunAs -Wait
    }
}

$distro = Get-UbuntuWslDistro
if (-not $distro) {
    Install-UbuntuWsl
    $distro = Get-UbuntuWslDistro
}
if (-not $distro) {
    Write-Host 'Ubuntu WSL is not ready yet. Reboot if Windows asked, then re-run this same one-liner.'
    Write-Host '  powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/robertpfox/cursor/cursor/agent-worker-start-4281/den.ps1 | iex"'
    exit 1
}

Write-Host "Using WSL distro $distro (not docker-desktop)"
# Do not pipe den.sh into bash. A pipe steals stdin, so agent login has no TTY
# when this is launched from Win+R. Download, then exec in a login shell.
$inner = "curl -fsSL '$Url' -o /tmp/den.sh && exec bash /tmp/den.sh"
& wsl.exe -d $distro -- bash -lic $inner
exit $LASTEXITCODE
