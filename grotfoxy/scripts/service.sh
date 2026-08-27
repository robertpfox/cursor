#!/usr/bin/env bash
# Start, stop and inspect GrotFoxy, whichever supervisor the installer chose.
#
#   ./scripts/service.sh start|stop|restart|status|logs
#
# On a systemd host this delegates to systemctl. Everywhere else it drives the
# fallback supervisor directly, so the commands you learn are the same either
# way.

set -uo pipefail

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="grotfoxy"
PID_FILE="$APP_ROOT/logs/supervisor.pid"
LOG_FILE="$APP_ROOT/logs/grotfoxy.log"

# The canonical test for "this host actually booted with systemd" — the binary
# being installed says nothing about it being PID 1.
has_systemd() { [ -d /run/systemd/system ]; }

supervisor_pid() {
  [ -f "$PID_FILE" ] || return 1
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || return 1
  printf '%s' "$pid"
}

port() {
  local value
  value="$(grep -E '^GROTFOXY_PORT=' "$APP_ROOT/.env" 2>/dev/null | tail -1 | cut -d= -f2)"
  printf '%s' "${value:-8787}"
}

start() {
  if has_systemd; then
    sudo systemctl start "$SERVICE_NAME"
    return
  fi
  if supervisor_pid >/dev/null; then
    echo "already running (supervisor pid $(supervisor_pid))"
    return
  fi
  mkdir -p "$APP_ROOT/logs"
  # setsid detaches from this shell so the service outlives the terminal.
  setsid nohup "$APP_ROOT/scripts/supervise.sh" >/dev/null 2>&1 &
  echo $! > "$PID_FILE"
  sleep 1
  echo "started (supervisor pid $(cat "$PID_FILE"))"
}

stop() {
  if has_systemd; then
    sudo systemctl stop "$SERVICE_NAME"
    return
  fi
  local pid
  if ! pid="$(supervisor_pid)"; then
    echo "not running"
    rm -f "$PID_FILE"
    return
  fi
  # Kill the process group so the supervisor and its node child both go.
  kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
  for _ in $(seq 1 20); do
    supervisor_pid >/dev/null || break
    sleep 0.5
  done
  if supervisor_pid >/dev/null; then
    kill -KILL -"$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null
  fi
  rm -f "$PID_FILE"
  echo "stopped"
}

status() {
  local p health
  p="$(port)"
  if has_systemd; then
    systemctl status "$SERVICE_NAME" --no-pager 2>&1 | head -12
  elif pid="$(supervisor_pid)"; then
    echo "supervisor running (pid $pid)"
  else
    echo "supervisor not running"
  fi
  health="$(curl -fsS -m 3 "http://127.0.0.1:$p/healthz" 2>/dev/null)"
  if [ -n "$health" ]; then
    echo "http://127.0.0.1:$p -> $health"
  else
    echo "http://127.0.0.1:$p -> not responding"
  fi
}

case "${1:-status}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  logs) tail -n "${2:-60}" -f "$LOG_FILE" ;;
  *)
    echo "usage: $0 {start|stop|restart|status|logs}" >&2
    exit 2
    ;;
esac
