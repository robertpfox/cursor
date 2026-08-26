@echo off
rem Keep the Den Computer My Machines worker running inside WSL.
rem Native Windows agent worker currently crashes on exec-daemon.
wsl.exe -e bash -lc "export PATH=$HOME/.local/bin:$PATH; exec bash $HOME/cursor/scripts/agent-worker/wsl-worker-loop.sh"
