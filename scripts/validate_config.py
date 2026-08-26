#!/usr/bin/env python3
"""Validate the Cursor configuration artifacts in this repository.

This repo is a Cursor user-configuration repository: JSON / JSONC settings,
Markdown skill & subagent definitions with YAML frontmatter, and a Windows
PowerShell helper script. There is no compiler, dev server, or test runner,
so "running the app" means validating that every config artifact is
well-formed and internally consistent.

The validator checks:
  * Strict JSON files parse (mcp.json, cli-config.json, ide_state.json,
    the skills manifest).
  * JSONC files parse after comments are stripped (argv.json).
  * mcp.json server entries are structurally valid (command+args or url).
  * The skills manifest references skill directories that actually exist.
  * Every subagent (.cursor/agents/*.md) and skill (SKILL.md) has YAML
    frontmatter with the required keys.
  * The PowerShell script has balanced braces / parentheses (and is parsed
    with `pwsh` when available).

Exit code is 0 when everything passes, 1 otherwise.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover - guarded by the install script
    print("ERROR: PyYAML is not installed. Run the environment install step "
          "(`bash scripts/cloud-agent-install.sh`) first.", file=sys.stderr)
    sys.exit(2)

REPO_ROOT = Path(__file__).resolve().parent.parent

GREEN = "\033[32m"
RED = "\033[31m"
YELLOW = "\033[33m"
DIM = "\033[2m"
RESET = "\033[0m"

# JSON files that intentionally allow // and /* */ comments (JSONC).
JSONC_FILES = {".cursor/argv.json"}

# Strict JSON config files that must always parse.
STRICT_JSON_FILES = [
    ".cursor/mcp.json",
    ".cursor/cli-config.json",
    ".cursor/ide_state.json",
    ".cursor/skills-cursor/.cursor-managed-skills-manifest.json",
]

# Required frontmatter keys.
AGENT_REQUIRED_KEYS = {"name", "description"}
SKILL_REQUIRED_KEYS = {"name", "description"}


class Results:
    def __init__(self) -> None:
        self.passed = 0
        self.failed = 0
        self.errors: list[str] = []

    def ok(self, label: str, detail: str = "") -> None:
        self.passed += 1
        extra = f" {DIM}{detail}{RESET}" if detail else ""
        print(f"  {GREEN}PASS{RESET} {label}{extra}")

    def fail(self, label: str, message: str) -> None:
        self.failed += 1
        self.errors.append(f"{label}: {message}")
        print(f"  {RED}FAIL{RESET} {label}\n       {RED}{message}{RESET}")

    def warn(self, label: str, message: str) -> None:
        print(f"  {YELLOW}WARN{RESET} {label} {DIM}{message}{RESET}")


def strip_jsonc(text: str) -> str:
    """Remove // line comments and /* */ block comments, ignoring those inside strings."""
    out = []
    i = 0
    n = len(text)
    in_string = False
    string_char = ""
    while i < n:
        ch = text[i]
        nxt = text[i + 1] if i + 1 < n else ""
        if in_string:
            out.append(ch)
            if ch == "\\":
                if nxt:
                    out.append(nxt)
                    i += 2
                    continue
            elif ch == string_char:
                in_string = False
            i += 1
            continue
        if ch in ('"', "'"):
            in_string = True
            string_char = ch
            out.append(ch)
            i += 1
            continue
        if ch == "/" and nxt == "/":
            while i < n and text[i] != "\n":
                i += 1
            continue
        if ch == "/" and nxt == "*":
            i += 2
            while i < n - 1 and not (text[i] == "*" and text[i + 1] == "/"):
                i += 1
            i += 2
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def rel(path: Path) -> str:
    return str(path.relative_to(REPO_ROOT))


def load_json_file(path: Path, allow_comments: bool) -> object:
    raw = path.read_text(encoding="utf-8")
    if allow_comments:
        raw = strip_jsonc(raw)
    return json.loads(raw)


def validate_json_files(res: Results) -> dict:
    print(f"\n{YELLOW}JSON / JSONC configuration{RESET}")
    parsed: dict[str, object] = {}
    for relpath in STRICT_JSON_FILES:
        path = REPO_ROOT / relpath
        if not path.exists():
            res.fail(relpath, "file is missing")
            continue
        try:
            data = load_json_file(path, allow_comments=False)
            parsed[relpath] = data
            res.ok(relpath, "strict JSON")
        except json.JSONDecodeError as exc:
            res.fail(relpath, f"invalid JSON: {exc}")
    for relpath in sorted(JSONC_FILES):
        path = REPO_ROOT / relpath
        if not path.exists():
            res.fail(relpath, "file is missing")
            continue
        try:
            data = load_json_file(path, allow_comments=True)
            parsed[relpath] = data
            res.ok(relpath, "JSONC (comments stripped)")
        except json.JSONDecodeError as exc:
            res.fail(relpath, f"invalid JSONC: {exc}")
    return parsed


def validate_mcp(res: Results, parsed: dict) -> None:
    print(f"\n{YELLOW}MCP server definitions{RESET}")
    data = parsed.get(".cursor/mcp.json")
    if data is None:
        res.fail(".cursor/mcp.json", "not parsed; cannot validate structure")
        return
    servers = data.get("mcpServers") if isinstance(data, dict) else None
    if not isinstance(servers, dict) or not servers:
        res.fail(".cursor/mcp.json", "missing non-empty 'mcpServers' object")
        return
    for name, cfg in servers.items():
        label = f"mcpServers.{name}"
        if not isinstance(cfg, dict):
            res.fail(label, "server entry must be an object")
            continue
        has_command = isinstance(cfg.get("command"), str) and cfg["command"]
        has_url = isinstance(cfg.get("url"), str) and cfg["url"]
        if not (has_command or has_url):
            res.fail(label, "must define either 'command' or 'url'")
            continue
        if has_command and "args" in cfg and not isinstance(cfg["args"], list):
            res.fail(label, "'args' must be an array")
            continue
        kind = "url" if has_url else "command"
        res.ok(label, f"{kind}-based")


def validate_skills_manifest(res: Results, parsed: dict) -> None:
    print(f"\n{YELLOW}Skills manifest consistency{RESET}")
    key = ".cursor/skills-cursor/.cursor-managed-skills-manifest.json"
    data = parsed.get(key)
    if not isinstance(data, dict):
        res.fail(key, "not parsed; cannot validate references")
        return
    skills_dir = REPO_ROOT / ".cursor/skills-cursor"
    referenced = []
    for field in ("builtinSkillIds", "managedSkillIds"):
        ids = data.get(field, [])
        if not isinstance(ids, list):
            res.fail(f"{key}:{field}", "must be an array")
            continue
        referenced.extend(ids)
    for skill_id in referenced:
        skill_md = skills_dir / skill_id / "SKILL.md"
        if skill_md.exists():
            res.ok(f"manifest skill '{skill_id}'", "SKILL.md present")
        else:
            res.fail(f"manifest skill '{skill_id}'", f"missing {rel(skill_md)}")


def parse_frontmatter(path: Path):
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---"):
        return None, "no YAML frontmatter (must start with '---')"
    m = re.match(r"^---\s*\n(.*?)\n---\s*(\n|$)", text, re.DOTALL)
    if not m:
        return None, "frontmatter is not closed with '---'"
    try:
        data = yaml.safe_load(m.group(1))
    except yaml.YAMLError as exc:
        return None, f"invalid YAML frontmatter: {exc}"
    if not isinstance(data, dict):
        return None, "frontmatter did not parse to a mapping"
    return data, None


def validate_frontmatter(res: Results) -> None:
    print(f"\n{YELLOW}Subagent definitions (.cursor/agents/*.md){RESET}")
    agents_dir = REPO_ROOT / ".cursor/agents"
    for md in sorted(agents_dir.glob("*.md")):
        data, err = parse_frontmatter(md)
        if err:
            res.fail(rel(md), err)
            continue
        missing = AGENT_REQUIRED_KEYS - set(data.keys())
        if missing:
            res.fail(rel(md), f"missing frontmatter keys: {', '.join(sorted(missing))}")
        else:
            res.ok(rel(md), f"name='{data['name']}'")

    print(f"\n{YELLOW}Skill definitions (.cursor/skills-cursor/**/SKILL.md){RESET}")
    skills_dir = REPO_ROOT / ".cursor/skills-cursor"
    for md in sorted(skills_dir.glob("*/SKILL.md")):
        data, err = parse_frontmatter(md)
        if err:
            res.fail(rel(md), err)
            continue
        missing = SKILL_REQUIRED_KEYS - set(data.keys())
        if missing:
            res.fail(rel(md), f"missing frontmatter keys: {', '.join(sorted(missing))}")
        else:
            res.ok(f"{md.parent.name}/SKILL.md", f"name='{data['name']}'")


def check_balanced(text: str) -> str | None:
    """Return an error message if braces/parens/brackets are unbalanced (outside strings)."""
    pairs = {")": "(", "]": "[", "}": "{"}
    openers = set(pairs.values())
    stack = []
    in_string = False
    string_char = ""
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if in_string:
            if ch == "`":
                i += 2
                continue
            if ch == string_char:
                in_string = False
            i += 1
            continue
        if ch in ("'", '"'):
            in_string = True
            string_char = ch
        elif ch == "#":
            while i < n and text[i] != "\n":
                i += 1
            continue
        elif ch in openers:
            stack.append(ch)
        elif ch in pairs:
            if not stack or stack[-1] != pairs[ch]:
                return f"unbalanced '{ch}'"
            stack.pop()
        i += 1
    if stack:
        return f"unclosed '{stack[-1]}'"
    return None


def validate_powershell(res: Results) -> None:
    print(f"\n{YELLOW}PowerShell script{RESET}")
    script = REPO_ROOT / "finish-cursor-move.ps1"
    if not script.exists():
        res.warn("finish-cursor-move.ps1", "not present; skipping")
        return
    text = script.read_text(encoding="utf-8")
    err = check_balanced(text)
    if err:
        res.fail("finish-cursor-move.ps1", f"structural check: {err}")
    else:
        res.ok("finish-cursor-move.ps1", "balanced braces/quotes")

    pwsh = shutil.which("pwsh")
    if not pwsh:
        res.warn("finish-cursor-move.ps1", "pwsh not installed; skipped parse check")
        return
    ps_cmd = (
        "$ErrorActionPreference='Stop';"
        "$t=$null;$e=$null;"
        "[System.Management.Automation.Language.Parser]::ParseFile("
        f"'{script}',[ref]$t,[ref]$e) | Out-Null;"
        "if($e.Count -gt 0){$e | ForEach-Object { $_.Message }; exit 1} else {exit 0}"
    )
    proc = subprocess.run([pwsh, "-NoProfile", "-Command", ps_cmd],
                          capture_output=True, text=True)
    if proc.returncode == 0:
        res.ok("finish-cursor-move.ps1", "pwsh parse OK")
    else:
        res.fail("finish-cursor-move.ps1", f"pwsh parse errors: {proc.stdout.strip() or proc.stderr.strip()}")


def main() -> int:
    print(f"{YELLOW}Validating Cursor configuration in {REPO_ROOT}{RESET}")
    res = Results()
    parsed = validate_json_files(res)
    validate_mcp(res, parsed)
    validate_skills_manifest(res, parsed)
    validate_frontmatter(res)
    validate_powershell(res)

    print(f"\n{YELLOW}Summary{RESET}")
    total = res.passed + res.failed
    if res.failed == 0:
        print(f"  {GREEN}All {res.passed} checks passed.{RESET}")
        return 0
    print(f"  {RED}{res.failed} of {total} checks failed:{RESET}")
    for err in res.errors:
        print(f"    - {err}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
