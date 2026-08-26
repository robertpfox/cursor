#!/usr/bin/env bash
# Idempotent environment bootstrap for the Cursor user-config repository.
#
# This repo contains only configuration (JSON/JSONC, Markdown skills &
# subagents) plus a Windows PowerShell helper. There are no application
# dependencies to compile, so this script only ensures the small toolset the
# config validator needs is present, then reports the versions.
set -euo pipefail

echo "==> Cursor config environment bootstrap"

missing=0
for tool in python3 jq git; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "ERROR: required tool '$tool' is not available on PATH" >&2
    missing=1
  fi
done
if [ "$missing" -ne 0 ]; then
  echo "ERROR: base image is missing required tooling; cannot continue." >&2
  exit 1
fi

# The validator parses YAML frontmatter with PyYAML. It ships in the default
# image; install it via apt only if it is somehow absent (keeps this idempotent
# and avoids PEP 668 externally-managed-environment errors from pip).
if ! python3 -c "import yaml" >/dev/null 2>&1; then
  echo "==> PyYAML missing; installing python3-yaml"
  sudo apt-get update -y
  sudo apt-get install -y python3-yaml
fi

echo "==> Tool versions"
echo "    python3: $(python3 --version 2>&1)"
echo "    pyyaml : $(python3 -c 'import yaml; print(yaml.__version__)')"
echo "    jq     : $(jq --version 2>&1)"
echo "    node   : $(node --version 2>&1 || echo 'n/a')"
echo "    git    : $(git --version 2>&1)"
if command -v pwsh >/dev/null 2>&1; then
  echo "    pwsh   : $(pwsh --version 2>&1)"
else
  echo "    pwsh   : not installed (PowerShell parse check will be skipped)"
fi

echo "==> Bootstrap complete."
