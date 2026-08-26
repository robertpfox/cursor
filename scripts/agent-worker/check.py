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
    if "repo fetch failed" not in bootstrap:
        errors.append("bootstrap-den.ps1 must still start a worker if GitHub clone/zip fails")
    if "install-den-wsl.sh" not in bootstrap and "Test-AgentWorkerWsl" not in (SCRIPTS / "install-den.ps1").read_text(
        encoding="utf-8"
    ):
        errors.append("Windows installers must prefer WSL while the native worker is broken")
    wsl_install = (SCRIPTS / "install-den-wsl.sh").read_text(encoding="utf-8")
    if "better-sqlite3" not in wsl_install:
        errors.append("install-den-wsl.sh must document the Windows exec-daemon crash")
    if "/mnt/c" not in wsl_install:
        errors.append("install-den-wsl.sh must keep the worker-dir off /mnt/c")
    if "pkill -f" in wsl_install:
        errors.append("install-den-wsl.sh must not pkill by pattern")

    common = (SCRIPTS / "common.ps1").read_text(encoding="utf-8")
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

    readme = (SCRIPTS / "README.md").read_text(encoding="utf-8")
    if "install-den-wsl.sh" not in readme or "wsl -e bash" not in readme:
        errors.append("README must lead with the WSL curl|bash one-liner")
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
