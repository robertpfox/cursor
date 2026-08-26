#!/usr/bin/env python3
"""Static checks for the Den Computer My Machines worker scripts."""

from __future__ import annotations

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts" / "agent-worker"
REQUIRED = [
    "common.ps1",
    "start.ps1",
    "install-den.ps1",
    "uninstall-den.ps1",
    "bootstrap-den.ps1",
    "start-den-worker.cmd",
    "start-den-wsl.cmd",
    "Start-DenComputer-Worker.cmd",
    "install-den-wsl.sh",
    "wsl-worker-loop.sh",
    "start.sh",
    "README.md",
    "agent-worker.env.example",
]


def brace_balance(text: str, open_ch: str, close_ch: str) -> int:
    depth = 0
    for ch in text:
        if ch == open_ch:
            depth += 1
        elif ch == close_ch:
            depth -= 1
            if depth < 0:
                return depth
    return depth


def check_powershell(path: pathlib.Path) -> list[str]:
    errors: list[str] = []
    text = path.read_text(encoding="utf-8")
    if brace_balance(text, "{", "}") != 0:
        errors.append(f"{path.name}: curly braces are unbalanced")
    if brace_balance(text, "(", ")") != 0:
        errors.append(f"{path.name}: parentheses are unbalanced")
    return errors


def main() -> int:
    errors: list[str] = []
    for name in REQUIRED:
        path = SCRIPTS / name
        if not path.is_file():
            errors.append(f"missing {path.relative_to(ROOT)}")

    for ps1 in SCRIPTS.glob("*.ps1"):
        errors.extend(check_powershell(ps1))

    start_sh = (SCRIPTS / "start.sh").read_text(encoding="utf-8")
    for needle in (
        "idle-release-timeout",
        "den-computer",
        "Refusing to start a My Machines worker",
        "--dry-run",
    ):
        if needle not in start_sh:
            errors.append(f"start.sh missing {needle!r}")

    start_ps1 = (SCRIPTS / "start.ps1").read_text(encoding="utf-8")
    if "AGENT_WORKER_ALLOW_NATIVE" not in start_ps1:
        errors.append("start.ps1 must refuse native Windows CLI unless AGENT_WORKER_ALLOW_NATIVE is set")
    if "den.sh" not in start_ps1:
        errors.append("start.ps1 must start via Ubuntu WSL while the native CLI is broken")

    install = (SCRIPTS / "install-den.ps1").read_text(encoding="utf-8")
    if "CursorAgentWorker" not in install:
        errors.append("install-den.ps1 missing scheduled task name CursorAgentWorker")
    if re.search(r"--pool\b", install):
        errors.append("install-den.ps1 must not pass --pool (My Machines, not pool)")
    if "agent login" not in install and "'login'" not in install:
        errors.append("install-den.ps1 must run agent login when unauthenticated")
    if "exit 1" not in install or "did not answer" not in install:
        errors.append("install-den.ps1 must fail if /healthz never answers")
    if "Den Computer worker is installed." in install:
        errors.append("install-den.ps1 must not claim success when the worker may be down")
    if "powershell.exe" not in install:
        errors.append("install-den.ps1 scheduled task must run powershell.exe so agent.ps1 works")
    if "run-agent-worker.ps1" not in install:
        errors.append("install-den.ps1 must write run-agent-worker.ps1")
    if "Get-AgentWorkerArgumentList" not in install:
        errors.append("install-den.ps1 launcher must reuse Get-AgentWorkerArgumentList")

    bootstrap = (SCRIPTS / "bootstrap-den.ps1").read_text(encoding="utf-8")
    if "archive/refs/heads" not in bootstrap:
        errors.append("bootstrap-den.ps1 must download a GitHub zip when git is missing")
    if 'throw "git is not on PATH' in bootstrap:
        errors.append("bootstrap-den.ps1 must not hard-fail when git is missing")
    if "worker --name den-computer" in bootstrap:
        errors.append("bootstrap-den.ps1 must not start the broken native Windows CLI")
    if "den.sh" not in bootstrap:
        errors.append("bootstrap-den.ps1 must exec den.sh inside Ubuntu WSL")
    if "Refusing to start the broken native Windows CLI" not in bootstrap:
        errors.append("bootstrap-den.ps1 must refuse native Windows CLI when Ubuntu WSL is missing")
    if "Trying the native Windows CLI anyway" in install:
        errors.append("install-den.ps1 must not try the broken native Windows CLI")
    if "AGENT_WORKER_ALLOW_NATIVE" not in install:
        errors.append("install-den.ps1 must refuse native start unless AGENT_WORKER_ALLOW_NATIVE is set")
    if "install-den-wsl.sh" not in bootstrap and "Test-AgentWorkerWsl" not in (SCRIPTS / "install-den.ps1").read_text(
        encoding="utf-8"
    ):
        errors.append("Windows installers must prefer WSL while the native worker is broken")
    wsl_install = (SCRIPTS / "install-den-wsl.sh").read_text(encoding="utf-8")
    if "better-sqlite3" not in wsl_install:
        errors.append("install-den-wsl.sh must document the Windows exec-daemon crash")
    if "/mnt/c" not in wsl_install:
        errors.append("install-den-wsl.sh must keep the worker-dir off /mnt/c")
    if "sudo -n" not in wsl_install:
        errors.append("install-den-wsl.sh must not hang on a sudo password prompt")
    if "git curl ca-certificates" not in wsl_install:
        errors.append("install-den-wsl.sh must still try to install git and curl")
    if "git clone" in wsl_install and 'mkdir -p "$ROOT" "$LOG_DIR"' in wsl_install:
        errors.append("install-den-wsl.sh must not mkdir logs under ROOT before git clone")
    if "git init" in wsl_install:
        errors.append("install-den-wsl.sh must not git-init a leftover ROOT; clone after removing logs-only leftovers")
    if "logs-only leftover" not in wsl_install:
        errors.append("install-den-wsl.sh must recover from a logs-only leftover ROOT")
    if "--wait --debug start --verbose" not in wsl_install:
        errors.append("install-den-wsl.sh fallback loop must pass --wait before start")
    if "CursorAgentWorker" not in wsl_install or "schtasks" not in wsl_install:
        errors.append("install-den-wsl.sh must register Windows logon task CursorAgentWorker via schtasks")
    if "WSL_DISTRO_NAME" not in wsl_install:
        errors.append("install-den-wsl.sh logon task must pin the current WSL distro")
    if ".local/share/cursor-agent-worker/wsl-worker-loop.sh" not in wsl_install:
        errors.append("install-den-wsl.sh must persist the restart loop outside /tmp")
    if "docker-desktop" not in wsl_install or "AGENT_WORKER_DISTRO_HOP" not in wsl_install:
        errors.append("install-den-wsl.sh must hop out of docker-desktop into Ubuntu")
    if "open-windows-browser" not in wsl_install or "BROWSER=" not in wsl_install:
        errors.append("install-den-wsl.sh must open agent login in the Windows browser from WSL")
    if "AGENT_WORKER_SELF_FILE" not in wsl_install or "/dev/tty" not in wsl_install:
        errors.append("install-den-wsl.sh must re-exec from a file so curl|bash cannot steal stdin from agent login")
    if "seq 1 180" not in wsl_install:
        errors.append("install-den-wsl.sh must wait up to 180s for /healthz on first start")

    common = (SCRIPTS / "common.ps1").read_text(encoding="utf-8")
    if "Get-AgentWorkerWslDistro" not in common or "docker-desktop" not in common:
        errors.append("common.ps1 must pick an Ubuntu WSL distro and skip docker-desktop")
    if "agent.exe" not in common or r"\.ps1$" not in common:
        errors.append("common.ps1 must prefer agent.exe/agent.cmd over agent.ps1 for the scheduled task")
    if "Get-ChildItem" not in common or "Recurse" not in common:
        errors.append("common.ps1 must search %LOCALAPPDATA%\\cursor-agent recursively for agent.exe")
    if "--idle-release-timeout" not in common:
        errors.append("common.ps1 must pass --idle-release-timeout")
    api_key_idx = common.find("if ($ApiKey)")
    worker_idx = common.find("'worker'")
    if api_key_idx < 0 or worker_idx < 0 or api_key_idx > worker_idx:
        errors.append("common.ps1 must pass --api-key as a global flag before the worker subcommand")

    key_line = start_sh.find("cmd+=(--api-key")
    worker_line = start_sh.find("\n  worker\n")
    if key_line < 0 or worker_line < 0 or key_line > worker_line:
        errors.append("start.sh must pass --api-key before the worker subcommand")
    uninstall = (SCRIPTS / "uninstall-den.ps1").read_text(encoding="utf-8")
    if "run-agent-worker.ps1" not in uninstall:
        errors.append("uninstall-den.ps1 must remove run-agent-worker.ps1")
    if "CursorAgentWorker" not in uninstall or "LocalAppData" not in uninstall:
        errors.append("uninstall-den.ps1 must remove the WSL logon launcher under LocalAppData")

    den_sh = ROOT / "den.sh"
    if not den_sh.is_file():
        errors.append("missing den.sh Win+R wrapper at repo root")
    else:
        den_text = den_sh.read_text(encoding="utf-8")
        if re.search(r"^\s*agent login\b", den_text, re.MULTILINE):
            errors.append("den.sh must not invoke agent login (curl|bash would steal stdin)")
        if "install-den-wsl.sh" not in den_text:
            errors.append("den.sh must download install-den-wsl.sh to a file and exec it")

    den_ps1 = ROOT / "den.ps1"
    if not den_ps1.is_file():
        errors.append("missing den.ps1 Win+R wrapper at repo root")
    else:
        den_ps1_text = den_ps1.read_text(encoding="utf-8")
        errors.extend(check_powershell(den_ps1))
        if re.search(r"^\s*agent login\b", den_ps1_text, re.MULTILINE):
            errors.append("den.ps1 must not invoke agent login")
        if re.search(r"\bagent(\.exe|\.cmd)?\s+worker\b", den_ps1_text):
            errors.append("den.ps1 must not start the broken native Windows CLI")
        if "docker-desktop" not in den_ps1_text or "Ubuntu-24.04" not in den_ps1_text:
            errors.append("den.ps1 must auto-pick Ubuntu WSL and skip docker-desktop")
        if "den.sh" not in den_ps1_text:
            errors.append("den.ps1 must exec den.sh inside the chosen WSL distro")

    readme = (SCRIPTS / "README.md").read_text(encoding="utf-8")
    vscode_tasks = ROOT / ".vscode" / "tasks.json"
    if not vscode_tasks.is_file() or "Start den-computer My Machines worker" not in vscode_tasks.read_text(
        encoding="utf-8"
    ):
        errors.append("Missing VS Code task to start the Den Computer WSL worker")
    if "den.sh" not in readme or "wsl -d Ubuntu" not in readme:
        errors.append("README must include the short den.sh Win+R one-liner targeting Ubuntu")
    if "den.ps1" not in readme:
        errors.append("README must lead with the den.ps1 Win+R one-liner that auto-picks Ubuntu")
    if "Start-DenComputer-Worker.cmd" not in readme:
        errors.append("README must mention the double-click WSL launcher")

    env_example = (SCRIPTS / "agent-worker.env.example").read_text(encoding="utf-8")
    if "CURSOR_API_KEY" not in env_example:
        errors.append("agent-worker.env.example missing CURSOR_API_KEY")

    if errors:
        print("FAIL")
        for error in errors:
            print(f"  {error}")
        return 1
    print(f"OK  {len(REQUIRED)} files, PowerShell brace check passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
