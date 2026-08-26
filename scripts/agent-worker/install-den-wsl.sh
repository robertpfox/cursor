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

# `wsl -e bash` often lands in docker-desktop. A My Machines worker there is useless.
# Hop into Ubuntu so older one-liners (without -d Ubuntu) still work.
if [[ "${AGENT_WORKER_DISTRO_HOP:-}" != "1" ]]; then
  case "${WSL_DISTRO_NAME:-}" in
    docker-desktop|docker-desktop-data|podman-machine*|rancher-desktop*)
      wsl_exe="/mnt/c/Windows/System32/wsl.exe"
      installer_url="https://raw.githubusercontent.com/robertpfox/cursor/${BRANCH}/scripts/agent-worker/install-den-wsl.sh"
      if [[ -x "$wsl_exe" ]]; then
        names="$("$wsl_exe" -l -q 2>/dev/null | tr -d '\0\r' || true)"
        for d in Ubuntu Ubuntu-24.04 Ubuntu-22.04 Ubuntu-20.04; do
          hop=""
          while IFS= read -r line; do
            if [[ "$line" == "$d" ]]; then hop="$d"; break; fi
          done <<< "$names"
          if [[ -n "$hop" ]]; then
            echo "==> ${WSL_DISTRO_NAME} cannot host the worker. Re-running in $hop"
            exec env AGENT_WORKER_DISTRO_HOP=1 "$wsl_exe" -d "$hop" -e bash -lc "curl -fsSL $installer_url | bash"
          fi
        done
        echo "No Ubuntu WSL distro found. Install with: wsl --install -d Ubuntu" >&2
        exit 2
      fi
      ;;
  esac
fi

echo "==> Ensuring git and curl are installed"
if ! command -v curl >/dev/null 2>&1 || ! command -v git >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  if command -v apt-get >/dev/null 2>&1; then
    if [[ "$(id -u)" -eq 0 ]]; then
      apt-get update -y && apt-get install -y git curl ca-certificates || true
    elif sudo -n true 2>/dev/null; then
      sudo -n apt-get update -y && sudo -n apt-get install -y git curl ca-certificates || true
    else
      echo "    ! cannot install packages without a passwordless sudo; continuing"
    fi
  fi
fi

echo "==> Installing the Cursor agent CLI (Linux)"
if [[ ! -x "${HOME}/.local/bin/agent" ]]; then
  curl -fsSL https://cursor.com/install | bash
fi
export PATH="${HOME}/.local/bin:${PATH}"
AGENT="${HOME}/.local/bin/agent"
"$AGENT" --version || true

echo "==> Checkout $REPO_URL ($BRANCH) on the WSL filesystem"
# Clone before creating logs/ under $ROOT — git clone refuses a non-empty directory.
# Older installers mkdir'd logs first; treat a logs-only leftover as cloneable.
clone_repo() {
  git clone --branch "$BRANCH" --single-branch "$REPO_URL" "$ROOT"
}

if [[ -d "$ROOT/.git" ]]; then
  if command -v git >/dev/null 2>&1; then
    git -C "$ROOT" fetch origin "$BRANCH" || true
    git -C "$ROOT" checkout "$BRANCH" || true
    git -C "$ROOT" pull --ff-only origin "$BRANCH" || true
  fi
elif command -v git >/dev/null 2>&1 && [[ ! -e "$ROOT" ]]; then
  clone_repo || true
elif command -v git >/dev/null 2>&1 && [[ -d "$ROOT" ]]; then
  leftover_ok=1
  shopt -s nullglob dotglob
  for entry in "$ROOT"/*; do
    base="$(basename "$entry")"
    case "$base" in
      .|..|logs) ;;
      *) leftover_ok=0 ;;
    esac
  done
  shopt -u nullglob dotglob
  if [[ "$leftover_ok" -eq 1 ]]; then
    echo "    removing logs-only leftover at $ROOT so clone can proceed"
    rm -rf "$ROOT"
    clone_repo || true
  else
    echo "    leaving existing $ROOT (not a git checkout); worker start still proceeds"
  fi
else
  echo "    git is not installed; starting the worker without a clone"
fi
mkdir -p "$LOG_DIR" "$DATA_DIR"

echo "==> Authentication"
if [[ -x /mnt/c/Windows/System32/cmd.exe ]]; then
  mkdir -p "${HOME}/.local/bin"
  cat >"${HOME}/.local/bin/open-windows-browser" <<'EOF'
#!/bin/sh
url="$1"
[ -n "$url" ] || exit 0
exec /mnt/c/Windows/System32/cmd.exe /c start "" "$url"
EOF
  chmod +x "${HOME}/.local/bin/open-windows-browser"
  export BROWSER="${HOME}/.local/bin/open-windows-browser"
  unset NO_OPEN_BROWSER || true
fi
if [[ -z "${CURSOR_API_KEY:-}" ]]; then
  if ! "$AGENT" status --format json 2>/dev/null | grep -q '"isAuthenticated": true'; then
    echo "    Opening agent login in the Windows browser (WSL has no GUI)..."
    "$AGENT" login
  fi
fi

# Always install the restart loop under DATA_DIR so a failed git clone
# (or a later WSL tmp wipe) cannot lose the worker.
LOOP="${DATA_DIR}/wsl-worker-loop.sh"
if [[ -f "${ROOT}/scripts/agent-worker/wsl-worker-loop.sh" ]]; then
  cp -f "${ROOT}/scripts/agent-worker/wsl-worker-loop.sh" "$LOOP"
else
  cat >"$LOOP" <<'EOF'
#!/usr/bin/env bash
set -u
ROOT="${CURSOR_WORKER_DIR:-$HOME/cursor}"
NAME="${CURSOR_WORKER_NAME:-den-computer}"
IDLE="${CURSOR_WORKER_IDLE_RELEASE_TIMEOUT:-0}"
DATA_DIR="${CURSOR_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/cursor-agent-worker}"
MGMT="${CURSOR_WORKER_MANAGEMENT_ADDR:-127.0.0.1:18791}"
ENV_FILE="${ROOT}/.cursor/agent-worker.env"
LOG="${ROOT}/logs/agent-worker.log"
mkdir -p "$ROOT" "$(dirname "$LOG")" "$DATA_DIR"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi
export PATH="${HOME}/.local/bin:${PATH}"
AGENT="${HOME}/.local/bin/agent"
cd "$ROOT" || exit 1
while true; do
  cmd=( "$AGENT" )
  if [[ -n "${CURSOR_API_KEY:-}" ]]; then cmd+=(--api-key "$CURSOR_API_KEY"); fi
  cmd+=( worker --name "$NAME" --worker-dir "$ROOT" --idle-release-timeout "$IDLE" --data-dir "$DATA_DIR" --management-addr "$MGMT" --wait --debug start --verbose )
  "${cmd[@]}" >>"$LOG" 2>&1
  echo "$(date -Is) worker exited $?, restarting in 10s" >>"$LOG"
  sleep 10
done
EOF
fi
chmod +x "$LOOP"

register_windows_logon_task() {
  local schtasks cmd_exe win_profile win_profile_unix launcher_dir launcher_win
  schtasks="/mnt/c/Windows/System32/schtasks.exe"
  cmd_exe="/mnt/c/Windows/System32/cmd.exe"
  if [[ ! -x "$schtasks" || ! -x "$cmd_exe" ]]; then
    echo "    (not Windows WSL; skipping CursorAgentWorker logon task)"
    return 0
  fi
  win_profile="$("$cmd_exe" /c "echo %USERPROFILE%" 2>/dev/null | tr -d '\r' | tail -n 1 || true)"
  if [[ -z "${win_profile:-}" || "${win_profile}" == *'%USERPROFILE%'* ]]; then
    echo "    ! could not resolve %USERPROFILE%; skipping logon task"
    return 0
  fi
  win_profile_unix="$(wslpath -u "$win_profile" 2>/dev/null || true)"
  if [[ -z "${win_profile_unix:-}" ]]; then
    echo "    ! wslpath failed for $win_profile; skipping logon task"
    return 0
  fi
  launcher_dir="${win_profile_unix}/AppData/Local/CursorAgentWorker"
  mkdir -p "$launcher_dir"
  cat >"${launcher_dir}/start-den-wsl.cmd" <<EOF
@echo off
wsl.exe ${WSL_DISTRO_NAME:+-d ${WSL_DISTRO_NAME} }-e bash -lc "exec bash \$HOME/.local/share/cursor-agent-worker/wsl-worker-loop.sh"
EOF
  launcher_win="$(wslpath -w "${launcher_dir}/start-den-wsl.cmd" 2>/dev/null || true)"
  if [[ -z "${launcher_win:-}" ]]; then
    echo "    ! wslpath failed for launcher; skipping logon task"
    return 0
  fi
  if "$schtasks" /Create /F /TN CursorAgentWorker /SC ONLOGON /RL LIMITED /TR "cmd.exe /c \"${launcher_win}\"" >/dev/null 2>&1; then
    echo "    registered Windows logon task CursorAgentWorker"
  else
    echo "    ! schtasks could not create CursorAgentWorker (not fatal; worker still started)"
  fi
}

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
register_windows_logon_task

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
