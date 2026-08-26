# Cursor My Machines worker (Den Computer)

`agent worker start` registers **this machine** as a [My Machines](https://cursor.com/docs/cloud-agent/self-hosted-guides/my-machines) worker. The agent loop still runs in Cursor's cloud; terminal, file edits, browser, and stdio MCP run here. No inbound ports.

**Do not run that command inside a Cursor-hosted Cloud Agent.** That registers the ephemeral VM. Run it on the Den Computer.

**Windows native `agent worker start` currently crashes** when starting exec-daemon (`better-sqlite3` NODE_MODULE_VERSION 127 vs 137). Cursor’s workaround is the Linux CLI inside **WSL**, with the repo on the WSL filesystem (not `/mnt/c`). This installer does that when WSL is available.

## Windows (Den Computer)

Native Windows `agent worker start` currently crashes. Win+R this PowerShell line — it picks Ubuntu / Ubuntu-24.04 / Ubuntu-22.04 and skips docker-desktop:

```text
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/robertpfox/cursor/cursor/agent-worker-start-4281/den.ps1 | iex"
```

If you already know the distro is named `Ubuntu`:

```text
wsl -d Ubuntu -e bash -lc "curl -fsSL https://raw.githubusercontent.com/robertpfox/cursor/cursor/agent-worker-start-4281/den.sh | bash"
```

`den.sh` only downloads the real installer to a file, then runs it. Do not pipe `install-den-wsl.sh` itself into bash. Do not rely on the default WSL distro — Docker Desktop often is.

If that fails with a WSL error, install Ubuntu then reboot:

```text
wsl --install -d Ubuntu
```

PowerShell one-liner (detects WSL, otherwise falls back):

```powershell
irm https://raw.githubusercontent.com/robertpfox/cursor/cursor/agent-worker-start-4281/scripts/agent-worker/bootstrap-den.ps1 | iex
```

From an existing clone of this repo:

```powershell
git fetch origin cursor/agent-worker-start-4281
git checkout cursor/agent-worker-start-4281
powershell -ExecutionPolicy Bypass -File .\scripts\agent-worker\install-den.ps1
```

Or download and double-click `scripts\agent-worker\Start-DenComputer-Worker.cmd` (no clone required). From a clone of this branch, Terminal → Run Task → **Start den-computer My Machines worker (WSL)**.

For boot-without-sign-in, put a *personal* user API key (https://cursor.com/dashboard/api) in `.cursor\agent-worker.env` as `CURSOR_API_KEY=key_...` before running the installer.

The installer registers a Scheduled Task named `CursorAgentWorker`. With WSL it starts `wsl.exe` at logon. Native Windows start is refused while the CLI crash remains (override only with `AGENT_WORKER_ALLOW_NATIVE=1`).

The installer **exits 1** unless `http://127.0.0.1:18791/healthz` answers within 60 seconds. A green "installed" line without that health check is not enough — `den-computer` must also appear under **Run on → My Machines** at [cursor.com/agents](https://cursor.com/agents).

Foreground (no task):

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\agent-worker\start.ps1
```

Remove:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\agent-worker\uninstall-den.ps1
```

## After it is running

1. Open [cursor.com/agents](https://cursor.com/agents).
2. In the environment / **Run on** dropdown, pick **den-computer**.
3. Send a task.

Slack / GitHub / Linear: `worker=den-computer` (the `--name`, your Cursor user, and this repo's git remote must all match).

## Flags this wrapper always sets

| Flag | Why |
|---|---|
| `--name den-computer` | Stable name for `worker=` routing |
| `--worker-dir <repo>` | Checkout Cloud Agents edit |
| `--idle-release-timeout 0` | Stay connected (CLI default is 3600s) |
| `--management-addr 127.0.0.1:18791` | Local `/healthz` for the installer |

`--pool` is **not** used. That is a team Self-Hosted Pool (Enterprise + service-account key). My Machines works on any plan that has Cloud Agents.

## Auth

My Machines needs a **personal** credential:

- `agent login`, or
- `--api-key` / `CURSOR_API_KEY` from [Dashboard → API Keys](https://cursor.com/dashboard/api)

Team admin keys, organization keys, and service-account keys are rejected for My Machines.

## Networking

Outbound HTTPS only:

- `api2.cursor.sh` and `api2direct.cursor.sh`
- `cloud-agent-artifacts.s3.us-east-1.amazonaws.com` (artifact uploads)

Preflight: `agent worker debug`
