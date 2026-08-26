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

$distro = Get-UbuntuWslDistro
if (-not $distro) {
    Write-Host 'No Ubuntu WSL distro found. The native Windows CLI currently crashes.'
    Write-Host 'Install Ubuntu, reboot, then re-run this:'
    Write-Host '  wsl --install -d Ubuntu'
    exit 1
}

Write-Host "Using WSL distro $distro (not docker-desktop)"
& wsl.exe -d $distro -e bash -lc "curl -fsSL $Url | bash"
exit $LASTEXITCODE
