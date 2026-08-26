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
$launcher = Join-Path $PSScriptRoot 'run-agent-worker.cmd'
$logFile = Join-Path $logDir 'agent-worker.log'
$quotedAgent = $agentPath

@"
@echo off
rem Launcher used by the CursorAgentWorker scheduled task. Do not edit by hand;
rem re-run install-den.ps1 to regenerate it.
cd /d "$repoRoot"
set "PATH=%USERPROFILE%\.local\bin;%PATH%"
set "CURSOR_WORKER_NAME=$Name"
set "CURSOR_DATA_DIR=$dataDir"
if exist "$envFile" (
  for /f "usebackq eol=# tokens=1,* delims==" %%A in ("$envFile") do (
    if not "%%A"=="" set "%%A=%%B"
  )
)
:loop
rem `call` is required when the CLI is agent.cmd; without it this batch file never returns to the restart loop.
call "$quotedAgent" worker --name "$Name" --worker-dir "$WorkerDir" --idle-release-timeout 0 --data-dir "$dataDir" --management-addr $($script:AgentWorkerManagementAddr) start --verbose >> "$logFile" 2>&1
echo [%date% %time%] worker exited %ERRORLEVEL%, restarting in 10s >> "$logFile"
timeout /t 10 /nobreak > nul
goto loop
"@ | Set-Content -Path $launcher -Encoding ASCII
Write-AgentWorkerOk "launcher written to $launcher"

# --- 4. Scheduled task -------------------------------------------------------

Write-AgentWorkerStep 'Registering the startup task'
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-AgentWorkerOk 'removed the previous task'
}

$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$launcher`"" -WorkingDirectory $repoRoot
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
    $debugJson = & $agentPath @('worker', 'debug', '--json') 2>$null
    if ($debugJson) {
        Write-Host $debugJson
    } else {
        & $agentPath @('worker', 'debug')
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
