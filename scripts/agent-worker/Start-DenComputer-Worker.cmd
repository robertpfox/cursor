@echo off
title den-computer My Machines worker
echo.
echo Native Windows agent worker currently crashes (better-sqlite3 ABI).
echo Starting the Linux CLI inside Ubuntu WSL (not docker-desktop).
echo.
set DISTRO=
for %%D in (Ubuntu Ubuntu-24.04 Ubuntu-22.04 Ubuntu-20.04) do (
  wsl.exe -d %%D -e true >nul 2>&1
  if not errorlevel 1 (
    set DISTRO=%%D
    goto :run
  )
)
:run
if defined DISTRO (
  echo Using WSL distro %DISTRO%
  wsl.exe -d %DISTRO% -e bash -lc "curl -fsSL https://raw.githubusercontent.com/robertpfox/cursor/cursor/agent-worker-start-4281/scripts/agent-worker/install-den-wsl.sh | bash"
) else (
  wsl.exe -e bash -lc "curl -fsSL https://raw.githubusercontent.com/robertpfox/cursor/cursor/agent-worker-start-4281/scripts/agent-worker/install-den-wsl.sh | bash"
)
set ERR=%ERRORLEVEL%
if not "%ERR%"=="0" (
  echo.
  echo If WSL is missing, run:  wsl --install -d Ubuntu
  echo Then reboot and double-click this file again.
)
echo.
pause
exit /b %ERR%
