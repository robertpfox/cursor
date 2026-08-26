#!/usr/bin/env bash
# Install and start the Den Computer My Machines worker inside WSL.
#
# Native Windows `agent worker start` currently crashes when starting
# exec-daemon (better-sqlite3 built for NODE_MODULE_VERSION 127, bundled
# Node requires 137). Cursor's documented workaround is the Linux CLI in
# WSL with the repo on the Linux filesystem, not /mnt/c.
#
# https://forum.cursor.com/t/168254
set -euo pipefail

BRANCH="${CURSOR_WORKER_BRANCH:-cursor/agent-worker-start-4281}"
REPO_URL="${CURSOR_WORKER_REPO:-https://github.com/robertpfox/cursor.git}"
NAME="${CURSOR_WORKER_NAME:-den-computer}"
ROOT="${HOME}/cursor"
LOG_DIR="${ROOT}/logs"
LOG="${LOG_DIR}/agent-worker.log"
MGMT="${CURSOR_WORKER_MANAGEMENT_ADDR:-127.0.0.1:18791}"
DATA_DIR="${CURSOR_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/cursor-agent-worker}"

echo
echo "  Den Computer My Machines worker via WSL"
echo "  Native Windows agent worker is broken (better-sqlite3 ABI)."
echo "  worker-dir: $ROOT"
echo

if [[ -n "${CURSOR_AGENT:-}" || -n "${CURSOR_AGENT_SOCKET:-}" ]]; then
  if [[ "${AGENT_WORKER_ALLOW_NESTED:-}" != "1" ]]; then
    echo "Refusing to start a My Machines worker inside a Cursor-hosted Cloud Agent VM." >&2
    exit 2
  fi
fi

echo "==> Ensuring git and curl are installed"
if ! command -v curl >/dev/null 2>&1 || ! command -v git >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  sudo apt-get update -y
  sudo apt-get install -y git curl ca-certificates
fi

echo "==> Installing the Cursor agent CLI (Linux)"
if [[ ! -x "${HOME}/.local/bin/agent" ]]; then
  curl -fsSL https://cursor.com/install | bash
fi
export PATH="${HOME}/.local/bin:${PATH}"
AGENT="${HOME}/.local/bin/agent"
"$AGENT" --version || true

echo "==> Checkout $REPO_URL ($BRANCH) on the WSL filesystem"
mkdir -p "$ROOT" "$LOG_DIR" "$DATA_DIR"
if [[ -d "$ROOT/.git" ]]; then
  git -C "$ROOT" fetch origin "$BRANCH" || true
  git -C "$ROOT" checkout "$BRANCH" || true
  git -C "$ROOT" pull --ff-only origin "$BRANCH" || true
else
  if ! git clone --branch "$BRANCH" --single-branch "$REPO_URL" "$ROOT"; then
    echo "    clone failed; initializing $ROOT with origin $REPO_URL"
    git -C "$ROOT" init
    git -C "$ROOT" remote add origin "$REPO_URL" 2>/dev/null || true
  fi
fi

echo "==> Authentication"
if [[ -z "${CURSOR_API_KEY:-}" ]]; then
  if ! "$AGENT" status --format json 2>/dev/null | grep -q '"isAuthenticated": true'; then
    echo "    Opening agent login in the browser..."
    "$AGENT" login
  fi
fi

LOOP="${ROOT}/scripts/agent-worker/wsl-worker-loop.sh"
if [[ ! -f "$LOOP" ]]; then
  LOOP="${TMPDIR:-/tmp}/wsl-worker-loop.sh"
  cat >"$LOOP" <<'EOF'
#!/usr/bin/env bash
set -u
ROOT="${CURSOR_WORKER_DIR:-$HOME/cursor}"
NAME="${CURSOR_WORKER_NAME:-den-computer}"
IDLE="${CURSOR_WORKER_IDLE_RELEASE_TIMEOUT:-0}"
DATA_DIR="${CURSOR_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/cursor-agent-worker}"
MGMT="${CURSOR_WORKER_MANAGEMENT_ADDR:-127.0.0.1:18791}"
LOG="${ROOT}/logs/agent-worker.log"
mkdir -p "$(dirname "$LOG")" "$DATA_DIR"
export PATH="${HOME}/.local/bin:${PATH}"
AGENT="${HOME}/.local/bin/agent"
cd "$ROOT" || exit 1
while true; do
  cmd=( "$AGENT" )
  if [[ -n "${CURSOR_API_KEY:-}" ]]; then cmd+=(--api-key "$CURSOR_API_KEY"); fi
  cmd+=( worker --name "$NAME" --worker-dir "$ROOT" --idle-release-timeout "$IDLE" --data-dir "$DATA_DIR" --management-addr "$MGMT" --debug start --verbose )
  "${cmd[@]}" >>"$LOG" 2>&1
  echo "$(date -Is) worker exited $?, restarting in 10s" >>"$LOG"
  sleep 10
done
EOF
  chmod +x "$LOOP"
fi

echo "==> Starting $NAME (restart loop)"
pid_file="${LOG_DIR}/wsl-worker-loop.pid"
if [[ -f "$pid_file" ]]; then
  old_pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [[ -n "${old_pid:-}" ]] && kill -0 "$old_pid" 2>/dev/null; then
    kill "$old_pid" 2>/dev/null || true
    sleep 1
  fi
fi
nohup bash "$LOOP" >/dev/null 2>&1 &
echo $! >"$pid_file"

ready=0
for _ in $(seq 1 60); do
  if curl -sf --max-time 2 "http://${MGMT}/healthz" >/dev/null; then
    ready=1
    break
  fi
  sleep 1
done

if [[ "$ready" -ne 1 ]]; then
  echo
  echo "  Worker did not answer http://${MGMT}/healthz within 60s. It is NOT connected." >&2
  echo "  Last log lines ($LOG):" >&2
  tail -40 "$LOG" 2>/dev/null || echo "  (no log file yet)" >&2
  exit 1
fi

echo "    worker is answering http://${MGMT}/healthz"
echo "==> Asking Cursor whether it can see this machine"
debug=( "$AGENT" )
if [[ -n "${CURSOR_API_KEY:-}" ]]; then debug+=(--api-key "$CURSOR_API_KEY"); fi
debug+=( worker debug --json )
"${debug[@]}" || "${debug[@]:0:${#debug[@]}-1}" debug || true

echo
echo "  Local worker process is up in WSL as \"$NAME\"."
echo "  Confirm it in Cursor before considering this done:"
echo
echo "  1. Open https://cursor.com/agents"
echo "  2. In the environment / Run on dropdown, pick \"$NAME\" under My Machines"
echo "  3. If the name is missing, the worker is not connected — check $LOG"
echo
echo "  Slack / GitHub / Linear:  worker=den-computer"
echo
