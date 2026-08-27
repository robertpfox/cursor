#!/usr/bin/env bash
# Keeps GrotFoxy alive on a host that is not running systemd (a container, a
# WSL distro without systemd, a minimal VM). systemd does this better; this is
# the fallback the installer picks when systemd is not PID 1.
#
# Not called directly — `scripts/service.sh start` launches it detached.

set -uo pipefail

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$APP_ROOT/logs"
LOG_FILE="$LOG_DIR/grotfoxy.log"
mkdir -p "$LOG_DIR"

log() { printf '[%s] supervisor: %s\n' "$(date -Is)" "$1" >> "$LOG_FILE"; }

cleanup() {
  log "stopping (signal received)"
  if [ -n "${child:-}" ]; then
    kill "$child" 2>/dev/null
    wait "$child" 2>/dev/null
  fi
  exit 0
}
trap cleanup TERM INT

log "started, pid $$"

# Back off on a crash loop so a misconfigured install does not spin the CPU.
delay=2
while true; do
  started=$(date +%s)
  node --experimental-sqlite --no-warnings "$APP_ROOT/src/index.js" >> "$LOG_FILE" 2>&1 &
  child=$!
  wait "$child"
  code=$?
  child=""

  if [ $(( $(date +%s) - started )) -ge 60 ]; then
    delay=2   # it ran long enough to count as healthy; reset the backoff
  else
    delay=$(( delay * 2 ))
    [ "$delay" -gt 60 ] && delay=60
  fi

  log "exited with code $code, restarting in ${delay}s"
  sleep "$delay"
done
