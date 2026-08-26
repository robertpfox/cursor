@echo off
title den-computer My Machines worker
echo.
echo Native Windows agent worker currently crashes (better-sqlite3 ABI).
echo Starting the Linux CLI inside WSL instead.
echo.
wsl.exe -e bash -lc "curl -fsSL https://raw.githubusercontent.com/robertpfox/cursor/cursor/agent-worker-start-4281/scripts/agent-worker/install-den-wsl.sh | bash"
set ERR=%ERRORLEVEL%
if not "%ERR%"=="0" (
  echo.
  echo If WSL is missing, run:  wsl --install -d Ubuntu
  echo Then reboot and double-click this file again.
)
echo.
pause
exit /b %ERR%
