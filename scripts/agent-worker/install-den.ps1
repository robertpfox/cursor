<#
.SYNOPSIS
    Install a long-lived Cursor My Machines worker on the Den Computer.

.DESCRIPTION
    `agent worker start` has to run on the machine you want Cloud Agents to
    use — not inside a Cursor-hosted Cloud Agent VM. This installer:

      1. Installs the Cursor agent CLI if it is missing.
      2. Checks auth (`agent login` or CURSOR_API_KEY / .cursor/agent-worker.env).
      3. Writes a restarting launcher.
      4. Registers a Scheduled Task named CursorAgentWorker.
      5. Starts it and prints how to pick the machine at cursor.com/agents.

    Re-running is safe: every step is idempotent.

    As Administrator, and with a personal API key in .cursor/agent-worker.env,
    the task starts at boot as SYSTEM so the worker stays up when nobody is
    signed in. Without elevation it starts at logon as you, using `agent login`.

.PARAMETER Name
    Display name in the Cloud Agent environment picker. Default den-computer.

.PARAMETER WorkerDir
    Git checkout to expose. Default: this repository root.

.PARAMETER NoAutoStart
    Register the task but do not start the worker now.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\agent-worker\install-den.ps1
#>

[CmdletBinding()]
param(
    [string]$Name = $env:CURSOR_WORKER_NAME,
    [string]$WorkerDir,
    [switch]$NoAutoStart
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$repoRoot = Get-AgentWorkerRepoRoot
if (-not $Name) { $Name = $script:AgentWorkerDefaultName }
if (-not $WorkerDir) { $WorkerDir = $repoRoot }
$taskName = $script:AgentWorkerTaskName
$envFile = Get-AgentWorkerEnvPath $repoRoot

Write-Host ''
Write-Host '  Cursor My Machines worker - Den Computer' -ForegroundColor White
Write-Host "  repo: $repoRoot"
Write-Host "  name: $Name"
Write-Host ''

Import-AgentWorkerEnv $envFile

if (Test-AgentWorkerWsl) {
    Write-AgentWorkerStep 'Windows native agent worker crashes on exec-daemon (better-sqlite3 ABI). Using WSL.'
    $wslInstaller = Join-Path $PSScriptRoot 'install-den-wsl.sh'
    $unixInstaller = $null
    $distro = Get-AgentWorkerWslDistro
    if ($distro) { Write-AgentWorkerOk "WSL distro $distro (skipping docker-desktop)" }
    if (Test-Path -LiteralPath $wslInstaller) {
        $unixInstaller = if ($distro) {
            (wsl.exe -d $distro wslpath -a $wslInstaller 2>$null)
        } else {
            (wsl.exe wslpath -a $wslInstaller 2>$null)
        }
        if ($unixInstaller) { $unixInstaller = [string]$unixInstaller.Trim() }
    }
    if ($unixInstaller) {
        $wslCode = Invoke-AgentWorkerWsl -WslArgs @('-e', 'bash', $unixInstaller)
    } else {
        $wslCode = Invoke-AgentWorkerWsl -WslArgs @(
            '-e', 'bash', '-lc',
            'curl -fsSL https://raw.githubusercontent.com/robertpfox/cursor/cursor/agent-worker-start-4281/scripts/agent-worker/install-den-wsl.sh -o /tmp/install-den-wsl.sh && bash /tmp/install-den-wsl.sh'
        )
    }

    Write-AgentWorkerStep 'Registering a logon task that keeps the WSL worker up'
    $launcherDir = Join-Path $env:LOCALAPPDATA 'CursorAgentWorker'
    New-Item -ItemType Directory -Path $launcherDir -Force | Out-Null
    $wslCmd = Join-Path $launcherDir 'start-den-wsl.cmd'
    $distroFlag = if ($distro) { "-d $distro " } else { '' }
    @(
        '@echo off',
        "wsl.exe ${distroFlag}-e bash -lc `"exec bash `$HOME/.local/share/cursor-agent-worker/wsl-worker-loop.sh`""
    ) | Set-Content -Path $wslCmd -Encoding ASCII
    $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existing) {
        Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    }
    $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$wslCmd`"" -WorkingDirectory $repoRoot
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -RestartCount 999 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -MultipleInstances IgnoreNew
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
        -Settings $settings -Description "Cursor My Machines worker ($Name) via WSL" | Out-Null
    Write-AgentWorkerOk 'task registered to start WSL worker when you sign in'

    if ($wslCode -ne 0) {
        Write-Host ''
        Write-Host '  WSL worker did not become healthy. Typical causes:' -ForegroundColor Yellow
        Write-Host '    - agent login was cancelled'
        Write-Host '    - wsl --install -d Ubuntu was never finished (reboot required)'
        Write-Host '    - git is missing inside WSL (sudo apt-get install -y git curl)'
        Write-Host ''
    }
    exit $wslCode
}

if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
    Write-AgentWorkerWarn 'WSL is not installed. Native Windows agent worker currently crashes (better-sqlite3 ABI).'
    Write-AgentWorkerWarn 'Install WSL, reboot, and re-run:  wsl --install -d Ubuntu'
    Write-AgentWorkerWarn 'Trying the native Windows CLI anyway in case Cursor has shipped a fix...'
}

# --- 1. CLI ------------------------------------------------------------------

Write-AgentWorkerStep 'Checking the Cursor agent CLI'
$agentPath = Install-AgentWorkerCli
$version = (& $agentPath '--version' 2>$null | Select-Object -First 1)
Write-AgentWorkerOk "agent $version at $agentPath"

# --- 2. Auth -----------------------------------------------------------------

Write-AgentWorkerStep 'Checking authentication'
$hasKey = [bool]$env:CURSOR_API_KEY
$loggedIn = Test-AgentWorkerAuth -AgentPath $agentPath -ApiKey $env:CURSOR_API_KEY
if (-not $loggedIn) {
    Write-AgentWorkerWarn 'Not signed in. Opening the Cursor login browser on this machine...'
    Remove-Item Env:NO_OPEN_BROWSER -ErrorAction SilentlyContinue
    & $agentPath login
    $loggedIn = Test-AgentWorkerAuth -AgentPath $agentPath -ApiKey $env:CURSOR_API_KEY
}
if (-not $loggedIn) {
    Write-Host ''
    Write-Host '  Sign-in did not complete. On this machine either finish `agent login`' -ForegroundColor Yellow
    Write-Host '  or create .cursor\agent-worker.env containing:'
    Write-Host '    CURSOR_API_KEY=key_...  (personal user key from https://cursor.com/dashboard/api)'
    Write-Host '  Team admin / org / service-account keys are rejected for My Machines.'
    Write-Host ''
    exit 1
}
if ($hasKey) {
    Write-AgentWorkerOk "personal API key loaded from env / $envFile"
} else {
    Write-AgentWorkerOk 'signed in via agent login'
}

$dataDir = Get-AgentWorkerDataDir $repoRoot
$logDir = Get-AgentWorkerLogDir $repoRoot
if (-not (Test-Path -LiteralPath $dataDir)) {
    New-Item -ItemType Directory -Path $dataDir | Out-Null
}
Write-AgentWorkerOk "data dir $dataDir"

# --- 3. Launcher -------------------------------------------------------------

Write-AgentWorkerStep 'Writing the restarting launcher'
$launcher = Join-Path $PSScriptRoot 'run-agent-worker.ps1'
$oldCmdLauncher = Join-Path $PSScriptRoot 'run-agent-worker.cmd'
if (Test-Path -LiteralPath $oldCmdLauncher) {
    Remove-Item -LiteralPath $oldCmdLauncher -Force
}
$logFile = Join-Path $logDir 'agent-worker.log'

function ConvertTo-AgentWorkerPsLiteral([string]$Value) {
    "'" + ($Value -replace "'", "''") + "'"
}

$litRepo = ConvertTo-AgentWorkerPsLiteral $repoRoot
$litName = ConvertTo-AgentWorkerPsLiteral $Name
$litWorkerDir = ConvertTo-AgentWorkerPsLiteral $WorkerDir
$litDataDir = ConvertTo-AgentWorkerPsLiteral $dataDir
$litEnvFile = ConvertTo-AgentWorkerPsLiteral $envFile
$litAgent = ConvertTo-AgentWorkerPsLiteral $agentPath
$litLog = ConvertTo-AgentWorkerPsLiteral $logFile
$litAddr = ConvertTo-AgentWorkerPsLiteral $script:AgentWorkerManagementAddr

@"
# Generated by install-den.ps1. Do not edit by hand; re-run the installer.
# PowerShell can invoke agent.exe, agent.cmd, and agent.ps1. cmd.exe cannot run agent.ps1.
`$ErrorActionPreference = 'Continue'
Set-Location -LiteralPath $litRepo
. (Join-Path `$PSScriptRoot 'common.ps1')
`$env:CURSOR_WORKER_NAME = $litName
`$env:CURSOR_DATA_DIR = $litDataDir
`$envFile = $litEnvFile
`$agentPath = $litAgent
`$logFile = $litLog
`$name = $litName
`$workerDir = $litWorkerDir
`$dataDir = $litDataDir
`$addr = $litAddr
while (`$true) {
    if (Test-Path -LiteralPath `$envFile) { Import-AgentWorkerEnv `$envFile }
    if (-not (Test-Path -LiteralPath `$agentPath)) {
        Add-Content -LiteralPath `$logFile -Value ("[{0}] CLI missing: {1}" -f (Get-Date), `$agentPath)
        Start-Sleep -Seconds 10
        continue
    }
    `$workerArgs = Get-AgentWorkerArgumentList -Name `$name -WorkerDir `$workerDir -DataDir `$dataDir -ManagementAddr `$addr -ApiKey `$env:CURSOR_API_KEY
    `$workerArgs += '--verbose'
    & `$agentPath @workerArgs >> `$logFile 2>&1
    Add-Content -LiteralPath `$logFile -Value ("[{0}] worker exited {1}, restarting in 10s" -f (Get-Date), `$LASTEXITCODE)
    Start-Sleep -Seconds 10
}
"@ | Set-Content -Path $launcher -Encoding UTF8
Write-AgentWorkerOk "launcher written to $launcher"

# --- 4. Scheduled task -------------------------------------------------------

Write-AgentWorkerStep 'Registering the startup task'
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-AgentWorkerOk 'removed the previous task'
}

$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`"" `
    -WorkingDirectory $repoRoot
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew

$asSystem = (Test-AgentWorkerAdmin) -and $hasKey
if ($asSystem) {
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
        -Principal $principal -Settings $settings `
        -Description "Cursor My Machines worker ($Name)" | Out-Null
    Write-AgentWorkerOk 'task registered to start at boot as SYSTEM'
} else {
    if (-not (Test-AgentWorkerAdmin)) {
        Write-AgentWorkerWarn 'Not running as Administrator — the task starts at logon, not at boot.'
    }
    if (-not $hasKey) {
        Write-AgentWorkerWarn 'No API key on disk, so the worker uses your interactive login. It starts when you sign in.'
    }
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
        -Settings $settings -Description "Cursor My Machines worker ($Name)" | Out-Null
    Write-AgentWorkerOk 'task registered to start when you sign in'
}

# --- 5. Start ----------------------------------------------------------------

if (-not $NoAutoStart) {
    Write-AgentWorkerStep "Starting $taskName"
    Start-ScheduledTask -TaskName $taskName
    $ready = $false
    $healthUrl = "http://$($script:AgentWorkerManagementAddr)/healthz"
    foreach ($attempt in 1..60) {
        Start-Sleep -Seconds 1
        try {
            $response = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 2
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
                $ready = $true
                break
            }
        } catch { }
    }
    if (-not $ready) {
        Write-Host ''
        Write-Host "  Worker did not answer $healthUrl within 60s. It is NOT connected." -ForegroundColor Red
        Write-Host "  Last log lines ($logFile):" -ForegroundColor Yellow
        if (Test-Path -LiteralPath $logFile) {
            Get-Content -LiteralPath $logFile -Tail 40
        } else {
            Write-Host '  (no log file yet)'
        }
        Write-Host ''
        Write-Host '  Typical causes:' -ForegroundColor Yellow
        Write-Host '    - agent login was cancelled or used a different Cursor account'
        Write-Host '    - CURSOR_API_KEY is a team/org/service-account key (My Machines needs a personal user key)'
        Write-Host '    - outbound HTTPS to api2.cursor.sh is blocked'
        Write-Host ''
        Write-Host "    Get-Content $logFile -Tail 50 -Wait"
        Write-Host ''
        exit 1
    }
    Write-AgentWorkerOk "worker is answering $healthUrl"

    Write-AgentWorkerStep 'Asking Cursor whether it can see this machine'
    $debugArgs = @()
    if ($env:CURSOR_API_KEY) { $debugArgs += @('--api-key', $env:CURSOR_API_KEY) }
    $debugArgs += @('worker', 'debug', '--json')
    $debugJson = & $agentPath @debugArgs 2>$null
    if ($debugJson) {
        Write-Host $debugJson
    } else {
        $debugArgs[-1] = 'debug'
        & $agentPath @debugArgs
    }
}

Write-Host ''
Write-Host "  Local worker process is up on this machine as `"$Name`"." -ForegroundColor Green
Write-Host '  Confirm it in Cursor before considering this done:'
Write-Host ''
Write-Host "  1. Open https://cursor.com/agents"
Write-Host "  2. In the environment / Run on dropdown, pick `"$Name`" under My Machines"
Write-Host '  3. If the name is missing, the worker is not connected — check the log above.'
Write-Host ''
Write-Host '  Slack / GitHub / Linear:  worker=den-computer'
Write-Host ''
Write-Host '  Manage:'
Write-Host "    Start-ScheduledTask -TaskName $taskName"
Write-Host "    Stop-ScheduledTask  -TaskName $taskName"
Write-Host "    Get-Content $logFile -Tail 50 -Wait"
Write-Host ''
Write-Host '  Docs: https://cursor.com/docs/cloud-agent/self-hosted-guides/my-machines'
Write-Host ''
