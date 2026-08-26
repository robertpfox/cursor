#!/usr/bin/env bash
# Foreground Cursor My Machines worker (`agent worker start` with Den defaults).
#
# Run this on the machine you want Cloud Agents to use. This script refuses to
# start a worker inside a Cursor-hosted Cloud Agent VM unless you set
# AGENT_WORKER_ALLOW_NESTED=1.
#
# Usage:
#   scripts/agent-worker/start.sh
#   scripts/agent-worker/start.sh --dry-run
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$REPO_ROOT/.cursor/agent-worker.env"
DRY_RUN=0

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
  shift
fi

load_env() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      export "${BASH_REMATCH[1]}=${BASH_REMATCH[2]}"
    fi
  done < "$file"
}
load_env "$ENV_FILE"

NAME="${CURSOR_WORKER_NAME:-den-computer}"
WORKER_DIR="${CURSOR_WORKER_DIR:-$REPO_ROOT}"
IDLE="${CURSOR_WORKER_IDLE_RELEASE_TIMEOUT:-0}"
DATA_DIR="${CURSOR_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/cursor-agent-worker}"
MGMT="${CURSOR_WORKER_MANAGEMENT_ADDR:-127.0.0.1:18791}"

if [[ -x "$HOME/.local/bin/agent" ]]; then
  AGENT="$HOME/.local/bin/agent"
elif command -v agent >/dev/null 2>&1; then
  AGENT="$(command -v agent)"
else
  echo "The Cursor agent CLI is not installed." >&2
  echo "Install with: curl https://cursor.com/install -fsS | bash" >&2
  exit 1
fi

cmd=( "$AGENT" )
if [[ -n "${CURSOR_API_KEY:-}" ]]; then
  cmd+=(--api-key "$CURSOR_API_KEY")
fi
cmd+=(
  worker
  --name "$NAME"
  --worker-dir "$WORKER_DIR"
  --idle-release-timeout "$IDLE"
  --data-dir "$DATA_DIR"
  --management-addr "$MGMT"
  --debug
  start
  --verbose
)

redacted=("${cmd[@]}")
if [[ -n "${CURSOR_API_KEY:-}" ]]; then
  for i in "${!redacted[@]}"; do
    if [[ "${redacted[$i]}" == "$CURSOR_API_KEY" ]]; then
      redacted[$i]='<redacted>'
    fi
  done
fi

echo "  ${redacted[*]}"
echo "  data dir: $DATA_DIR"

if [[ "$DRY_RUN" -eq 1 ]]; then
  exit 0
fi

# Cursor-hosted Cloud Agent VMs already *are* the execution environment.
# Registering them as My Machines would attach an ephemeral VM, not the Den.
if [[ -n "${CURSOR_AGENT:-}" || -n "${CURSOR_AGENT_SOCKET:-}" ]]; then
  if [[ "${AGENT_WORKER_ALLOW_NESTED:-}" != "1" ]]; then
    echo "Refusing to start a My Machines worker inside a Cursor-hosted Cloud Agent VM." >&2
    echo >&2
    echo "Run this on the Den Computer (Windows):" >&2
    echo "  powershell -ExecutionPolicy Bypass -File .\\scripts\\agent-worker\\install-den.ps1" >&2
    echo >&2
    echo "Or a one-shot foreground start after \`agent login\`:" >&2
    echo "  powershell -ExecutionPolicy Bypass -File .\\scripts\\agent-worker\\start.ps1" >&2
    echo >&2
    echo "Docs: https://cursor.com/docs/cloud-agent/self-hosted-guides/my-machines" >&2
    exit 2
  fi
fi

exec "${cmd[@]}"
