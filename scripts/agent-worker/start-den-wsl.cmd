@echo off
rem Keep the Den Computer My Machines worker running inside Ubuntu WSL.
rem Native Windows agent worker currently crashes on exec-daemon.
rem Prefer Ubuntu so docker-desktop is not used as the default distro.
for %%D in (Ubuntu Ubuntu-24.04 Ubuntu-22.04 Ubuntu-20.04) do (
  wsl.exe -d %%D -e true >nul 2>&1
  if not errorlevel 1 (
    wsl.exe -d %%D -e bash -lc "exec bash $HOME/.local/share/cursor-agent-worker/wsl-worker-loop.sh"
    exit /b %ERRORLEVEL%
  )
)
echo No Ubuntu WSL distro found. Native Windows CLI currently crashes.
echo Install with:  wsl --install -d Ubuntu
exit /b 1
