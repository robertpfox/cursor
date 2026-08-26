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
    if "--idle-release-timeout" not in install:
        errors.append("install-den.ps1 missing --idle-release-timeout")
    if re.search(r"--pool\b", install):
        errors.append("install-den.ps1 must not pass --pool (My Machines, not pool)")

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
