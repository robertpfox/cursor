# GrotFoxy

Self-hosted autonomous AI teammates, running on hardware you already own.

GrotFoxy does what a Grok Bot–style desktop app does — you name a bot, describe
its job in plain language, and it goes off and does the work, coming back when
it finishes or needs your approval — except there is **no subscription**. No
seat fee, no plan tier, no weekly usage allowance, no metering service. You
bring your own model API key, or point it at a local model and pay nothing at
all.

It is designed to live on one always-on machine (the **Den Computer**) and be
driven from any browser on your network, phone included.

---

## Why this exists

Grok Bot is bundled into subscriptions that run from $40/seat/month to
$300/month, and it runs your teammates on someone else's cloud VM. GrotFoxy
keeps the same working model and moves the persistent computer into your house:

| | Grok Bot desktop | GrotFoxy |
|---|---|---|
| Cost to run | $40–$300 / month, bundled into a plan | $0. You pay your model provider directly, or nothing at all with a local model |
| Where bots run | xAI's cloud VM | Your Den Computer |
| Model choice | Automatic, not selectable | You pick the provider and the model, per bot |
| Where your keys live | Their infrastructure | Encrypted on your disk, with a key that never leaves the machine |
| Connectors | Their catalogue | Any MCP server, plus anything reachable over HTTP |
| Audit of bot actions | Announced, not shipped as of Aug 2026 | Full step-by-step timeline of every run, kept forever |
| Data | Their servers | One SQLite file you can copy |

## Feature parity

Everything the desktop app does, and the two things reviewers asked it for.

| Capability | How GrotFoxy does it |
|---|---|
| Name a bot, give it a job, context and boundaries | Bot editor: identity, job, context, hard boundaries |
| Bots work in the background on a persistent computer | Runs execute on the host; the browser is only a window onto them |
| Returns when finished, or when it needs approval | Approval gates pause the run and notify you; deciding resumes it |
| Connect apps with your own logins | Connectors are MCP servers (Gmail, Slack, GitHub, Notion, Linear, smart home, …) |
| Same experience on desktop and phone | One responsive web app, installable to a home screen |
| Dictation | Mic button on every task box, via the browser's speech API |
| Manage several bots at once | Dashboard grid with live status, plus a chief-of-staff template |
| Scheduled and recurring work | Per-bot cron schedules with a plain-English preview |
| Usage and spend visibility | Per-run token and cost accounting, 30-day rollups |
| **Choose the model** *(Grok Bot cannot)* | Any provider, any model, set per bot |
| **Trigger from anything** *(Grok Bot cannot)* | Tokenised webhook URL per bot, plus a REST API |

## Requirements

- **Node.js 22.5 or newer.** That is the whole dependency list — GrotFoxy has
  zero runtime npm packages and uses Node's built-in SQLite, so nothing
  compiles and `npm install` is a no-op.
- A model to think with, either:
  - **Free and local:** [Ollama](https://ollama.com) or LM Studio on the same
    machine. No account, no key, no per-token cost.
  - **Bring your own key:** OpenAI, xAI (Grok), Anthropic, OpenRouter, Groq,
    DeepSeek, or any OpenAI-compatible endpoint. You pay that provider
    directly, at their list price.

---

## Install on the Den Computer

### One command

GrotFoxy currently lives on a feature branch, so a `git pull` on an existing
checkout of the default branch will not have it. The bootstrap fetches the code
into its own folder, checks git and Node, and runs the platform installer. It
never touches an existing checkout such as `C:\cursor`.

**Windows** (PowerShell):

```powershell
irm https://raw.githubusercontent.com/robertpfox/cursor/cursor/grotfoxy-self-hosted-ai-teammates-bd6b/grotfoxy/scripts/bootstrap.ps1 | iex
```

**Linux / macOS**:

```bash
curl -fsSL https://raw.githubusercontent.com/robertpfox/cursor/cursor/grotfoxy-self-hosted-ai-teammates-bd6b/grotfoxy/scripts/bootstrap.sh | bash
```

Both land the app in `C:\GrotFoxy` / `~/GrotFoxy`, install it as a service, and
print the URL. Override with `-InstallHome D:\GrotFoxy` or `GROTFOXY_HOME=...`.

### Windows, from a checkout

```powershell
cd C:\GrotFoxy\grotfoxy
powershell -ExecutionPolicy Bypass -File .\scripts\install-den.ps1
```

Run it from an elevated PowerShell and GrotFoxy starts at boot and keeps working
when nobody is signed in, using an S4U scheduled task — as you, not SYSTEM, and
with no stored password. That distinction matters: a bot with the `run_command`
tool runs with whatever rights the task holds. Without elevation it installs as
a start-at-logon task instead. The installer also:

- generates a `.env` with a random encryption secret,
- registers a scheduled task that restarts GrotFoxy if it ever exits,
- opens TCP 8787 on the **private** firewall profile only,
- prints the LAN URL to open on your phone.

To remove it: `.\scripts\uninstall-den.ps1` (add `-PurgeData` to delete the
database too).

### Linux

```bash
sudo ./scripts/install-linux.sh
```

On a systemd host this installs a hardened unit (`ProtectSystem=full`,
`ProtectHome=read-only`, writes confined to the app tree) and enables it at
boot.

On a host that is not running systemd — a container, WSL without systemd, a
minimal VM — the installer says so and falls back to a supervised background
process that restarts GrotFoxy if it exits, with exponential backoff on a crash
loop. Boot persistence is not possible there, so start it yourself after a
reboot. No sudo is needed in that mode.

Either way the same commands control it:

```bash
./scripts/service.sh status
./scripts/service.sh restart
./scripts/service.sh logs
```

### Docker

```bash
GROTFOXY_SECRET=$(openssl rand -hex 32) docker compose up -d
```

### Just run it

```bash
npm start
```

Then open the printed URL, create your owner account, and add a model provider
in **Settings → Models**.

---

## First five minutes

1. Open `http://<den-computer>:8787` and create the owner account. The first
   visitor claims the instance; after that it is password-protected.
2. **Settings → Models** — add a provider. Pick the *Ollama (local, free)*
   preset if you have Ollama running, or paste an API key for a hosted one.
   Hit **Test** to confirm it is reachable and list its models.
3. **Dashboard → From template** — pick Chief of Staff, Research Analyst, Inbox
   Triage, Home Ops or Night Shift Engineer, then edit anything before saving.
4. Type a task, or hold the mic and say it. The run opens and streams its work
   live.
5. When it wants to do something sensitive it stops and asks. Approve or deny,
   and it carries on from exactly that point.

---

## How a bot is configured

Five tabs, matching how you would brief a person:

- **Identity** — name, icon, the job, standing context, and hard boundaries.
- **Brain** — provider, model, temperature, and when to notify you.
- **Tools** — which built-in tools it may use, which connectors it may reach,
  how eagerly it should ask permission, and whether it may call several tools
  in one turn.
- **Limits** — max steps, max seconds and max spend per run; allowed HTTP
  hosts; allowed and blocked shell commands. The seconds budget counts time the
  run spends *working*, not wall clock, so a run parked on an approval
  overnight still has its full budget when you get to it in the morning.
- **Triggers** — cron schedule and the standing task to run on it.

### Built-in tools

| Group | Tools | Approval by default |
|---|---|---|
| Core | `get_current_time`, `ask_user` | `ask_user` always pauses |
| Memory | `remember`, `recall`, `forget` | no |
| Notify | `notify_user` | no |
| Files | `list_files`, `read_file`, `write_file`, `append_file`, `delete_file` | writes and deletes, yes |
| Web | `web_search`, `fetch_page`, `http_request` | `http_request`, yes |
| Shell | `run_command` | yes |

Boundaries are enforced, not merely requested. File tools resolve every path
inside the bot's own workspace folder and reject anything that escapes it.
Shell commands pass an allow list, a deny list, and a built-in block on the
classics (`rm -rf /`, `mkfs`, fork bombs). Web tools honour a per-bot host
allow list.

### Keeping smaller models honest

Local models are the whole point of running your own box, and small ones fail
in two specific ways that GrotFoxy handles rather than passes on to you.

**They ask for two tools at once when the second depends on the first.** A bot
that calls `get_current_time` and `write_file` in the same turn has no time to
write yet, so it writes the literal text `[current_time]` to your disk. Tool
calls therefore run one per turn by default; the deferred call comes back with
a note saying what already ran and what to request next. Turn on *Allow several
tool calls in one turn* under **Tools** for a model that handles it.

**They answer as if a tool had run when it did not.** If a run reaches its final
answer with a deferred call still outstanding, GrotFoxy pushes back once and
tells the model to either run it or say plainly that it could not. If the model
does neither, the run finishes as **Stopped early** rather than Done, with a
note naming the tool that never ran. You get an amber card and an honest
warning instead of a green tick over a guess.

### Connectors

A connector is an MCP server, which is how GrotFoxy reaches the outside world
without shipping its own integration catalogue. Add one in
**Settings → Connectors**, or click **Import mcp.json** to pull in every server
from an existing Cursor or Claude Desktop config in one go. Imported servers
arrive disabled so you can check their paths before switching them on.

Both transports work: a local `stdio` command, or a remote HTTP endpoint.

---

## Triggers

Besides typing a task and cron schedules, every bot can have a webhook:

```bash
curl -X POST http://den-computer:8787/hooks/<botId>/<token> \
  -H 'content-type: application/json' \
  -d '{"task": "Check whether the front door is locked and tell me"}'
```

The whole JSON body is handed to the bot, so an alerting system or a Home
Assistant automation can pass its payload straight through. Create the URL on
the bot page under **Triggers**; it is shown once.

For scripts, mint an API token in **Settings → Security** and call the REST API
with `Authorization: Bearer <token>`.

---

## Runs survive restarts

The full model transcript is written to SQLite after every turn. If the Den
Computer reboots mid-run — or you approve something the next morning — the run
rehydrates from disk and continues from the exact tool call it stopped at. A
run waiting on you costs nothing while it waits.

## Where things live

State lives **outside the checkout**, because `data/` is gitignored and a
`git clean -xdf` in the repo would otherwise wipe every bot, transcript and API
key. The installers set this up and migrate any existing in-repo state.

```
~/.grotfoxy/data/grotfoxy.db     everything: bots, runs, transcripts, memories, settings
~/.grotfoxy/data/master.key      encrypts provider keys at rest (owner-readable only)
~/.grotfoxy/workspace/<botId>/   each bot's private file area — the jail for file tools
<checkout>/logs/grotfoxy.log     service output
```

On Windows the state directory is `%LOCALAPPDATA%\GrotFoxy`. Override either
with `GROTFOXY_DATA_DIR` and `GROTFOXY_WORKSPACE_DIR` in `.env`.

Back up by copying the state directory. Move to a new machine by copying it
across and re-running the installer.

## Configuration

Environment variables, or a `.env` beside `package.json`:

| Variable | Default | Purpose |
|---|---|---|
| `GROTFOXY_HOST` | `0.0.0.0` | Interface to bind. `127.0.0.1` keeps it local-only |
| `GROTFOXY_PORT` | `8787` | Port |
| `GROTFOXY_SECRET` | generated | Encrypts stored API keys |
| `GROTFOXY_DATA_DIR` | `~/.grotfoxy/data` | Database and master key |
| `GROTFOXY_WORKSPACE_DIR` | `~/.grotfoxy/workspace` | Bot file areas |
| `GROTFOXY_MAX_CONCURRENT_RUNS` | `3` | Runs executing at once |
| `GROTFOXY_SCHEDULER` | `true` | Set false to disable cron |
| `GROTFOXY_ALLOW_SETUP` | `true` | Set false once the owner exists |
| `GROTFOXY_LAN_ONLY` | `true` | Serve only callers on your own network |
| `GROTFOXY_DISABLE_TOOLS` | *(none)* | Comma list of tools no bot may use |
| `GROTFOXY_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

## CLI

```bash
npm run doctor          # check providers, connectors and config
npm run reset-password  # reset a password and sign out every session
node bin/grotfoxy.js create-owner
```

## Staying on your own network

GrotFoxy answers only callers on your own network, and this is enforced by the
server rather than left to configuration you have to remember. A request is
served when the socket peer is a private address **and**, if it arrived through
a proxy, the original client in `X-Forwarded-For` was private too. Anything else
gets a 403.

Both halves matter. Binding `0.0.0.0` so your phone can reach the Den Computer
also answers a port forward or a tunnel, and a tunnel daemon running on the host
connects over loopback — so a socket check on its own would wave the entire
internet through. A forged `X-Forwarded-For` cannot grant access either, because
the socket still has to be private.

Private means loopback, `10/8`, `172.16/12`, `192.168/16`, link-local,
`fc00::/7`, and `100.64/10` so Tailscale works.

Turn it off only when something in front of GrotFoxy is doing real access
control:

```
GROTFOXY_LAN_ONLY=false
```

### Locking tools down

`GROTFOXY_DISABLE_TOOLS=run_command,delete_file` removes tools instance-wide.
It is enforced in the runtime, not in each bot's configuration, so it still
holds if someone with your password edits a bot and ticks the box back on. Worth
setting on any instance reachable by anyone but you.

### Other notes

If you do put it on the internet, use a reverse proxy with TLS, set
`GROTFOXY_ALLOW_SETUP=false` once your account exists, and remember that a bot
with `run_command` can do anything you can do on that box.

Provider keys are encrypted with AES-256-GCM. Passwords are scrypt-hashed.
Session and webhook tokens are stored only as SHA-256 digests. Nothing is
reported anywhere: no telemetry, no license check, no phone-home.

## Development

```bash
npm run dev    # watch mode
npm test       # node:test suite, no network required
```

## Licence

MIT.
