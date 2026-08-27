#!/usr/bin/env bash
# One-command GrotFoxy install for Linux and macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/robertpfox/cursor/cursor/grotfoxy-self-hosted-ai-teammates-bd6b/grotfoxy/scripts/bootstrap.sh | bash
#
# Fetches the code into its own directory, checks Node, and runs the installer.
# Override the target with GROTFOXY_HOME=/opt/grotfoxy.

set -euo pipefail

REPO="${GROTFOXY_REPO:-https://github.com/robertpfox/cursor.git}"
BRANCH="${GROTFOXY_BRANCH:-cursor/grotfoxy-self-hosted-ai-teammates-bd6b}"
HOME_DIR="${GROTFOXY_HOME:-$HOME/GrotFoxy}"
PORT="${PORT:-8787}"

step() { printf '\n\033[36m==> %s\033[0m\n' "$1"; }
ok() { printf '    \033[32m✓ %s\033[0m\n' "$1"; }
die() { printf '    \033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

printf '\n  GrotFoxy bootstrap\n'

step "Checking prerequisites"
command -v git >/dev/null 2>&1 || die "git is not installed."

if command -v node >/dev/null 2>&1; then
  NODE_VERSION="$(node --version | sed 's/^v//')"
  NODE_MAJOR="${NODE_VERSION%%.*}"
  NODE_MINOR="$(echo "$NODE_VERSION" | cut -d. -f2)"
  if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 5 ]; }; then
    die "Node $NODE_VERSION is too old. GrotFoxy needs 22.5.0+ (it uses Node's built-in SQLite). Install Node 22 LTS from https://nodejs.org and re-run."
  fi
  ok "node $NODE_VERSION"
else
  die "Node.js is not installed. Get Node 22 LTS from https://nodejs.org, then re-run this."
fi

# A separate directory on purpose. Checking a feature branch out over an
# existing working copy would swap that repo's contents out from under you.
step "Fetching GrotFoxy into $HOME_DIR"
if [ -d "$HOME_DIR/.git" ]; then
  git -C "$HOME_DIR" remote set-url origin "$REPO"
  git -C "$HOME_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$HOME_DIR" checkout -B grotfoxy FETCH_HEAD >/dev/null 2>&1
  ok "updated existing checkout"
else
  [ -e "$HOME_DIR" ] && die "$HOME_DIR exists but is not a git checkout. Move it aside or set GROTFOXY_HOME."
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$HOME_DIR" >/dev/null 2>&1 \
    || die "Could not clone $REPO (branch $BRANCH)."
  ok "cloned"
fi

APP="$HOME_DIR/grotfoxy"
[ -d "$APP" ] || die "The checkout has no grotfoxy/ directory — wrong branch?"

step "Running the installer"
chmod +x "$APP/scripts/"*.sh
PORT="$PORT" "$APP/scripts/install-linux.sh"

printf '\n  Installed at %s\n' "$APP"
printf '  Open http://localhost:%s and create your owner account.\n\n' "$PORT"
