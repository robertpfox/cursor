#!/usr/bin/env bash
# Restart loop for the Den Computer My Machines worker inside WSL.
# Native Windows agent worker currently crashes on exec-daemon
# (better-sqlite3 NODE_MODULE_VERSION 127 vs 137).
set -u
ROOT="${CURSOR_WORKER_DIR:-$HOME/cursor}"
NAME="${CURSOR_WORKER_NAME:-den-computer}"
IDLE="${CURSOR_WORKER_IDLE_RELEASE_TIMEOUT:-0}"
DATA_DIR="${CURSOR_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/cursor-agent-worker}"
MGMT="${CURSOR_WORKER_MANAGEMENT_ADDR:-127.0.0.1:18791}"
ENV_FILE="${ROOT}/.cursor/agent-worker.env"
LOG_DIR="${ROOT}/logs"
mkdir -p "$LOG_DIR" "$DATA_DIR"
LOG="${LOG_DIR}/agent-worker.log"

if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a
  # shellcheck disable=SC1091
  source "$ENV_FILE"
  set +a
fi

export PATH="${HOME}/.local/bin:${PATH}"
AGENT="${HOME}/.local/bin/agent"
if [[ ! -x "$AGENT" ]]; then
  echo "$(date -Is) agent CLI missing at $AGENT" >>"$LOG"
  exit 1
fi

cd "$ROOT" || exit 1

while true; do
  cmd=( "$AGENT" )
  if [[ -n "${CURSOR_API_KEY:-}" ]]; then
    cmd+=(--api-key "$CURSOR_API_KEY")
  fi
    cmd+=(
      worker
      --name "$NAME"
      --worker-dir "$ROOT"
      --idle-release-timeout "$IDLE"
      --data-dir "$DATA_DIR"
      --management-addr "$MGMT"
      --wait
      --debug
      start
      --verbose
    )
  "${cmd[@]}" >>"$LOG" 2>&1
  echo "$(date -Is) worker exited $?, restarting in 10s" >>"$LOG"
  sleep 10
done
