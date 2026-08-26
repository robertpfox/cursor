#!/usr/bin/env bash
# Tiny Win+R entrypoint for the Den Computer My Machines worker.
# Safe to curl|bash: this file only downloads the real installer and execs it.
# Do not put interactive auth here — that would steal stdin from a pipe.
set -euo pipefail
BRANCH="${CURSOR_WORKER_BRANCH:-cursor/agent-worker-start-4281}"
URL="https://raw.githubusercontent.com/robertpfox/cursor/${BRANCH}/scripts/agent-worker/install-den-wsl.sh"
curl -fsSL "$URL" -o /tmp/install-den-wsl.sh
exec bash /tmp/install-den-wsl.sh
