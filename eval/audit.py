"""Audit a pilot run's logs for routes to the answer outside the task.

    python audit.py [run_dir ...]      # default: every results/pilot-*

Findings (any one makes a run not clean):
  web       Claude WebFetch/WebSearch, Codex web_search, or a shell command that
            reaches the web (gh, curl, wget, git clone/fetch, urllib/requests
            with an http URL). Package installs are recorded as notes only.
  outside   a command or file tool that touches this repo outside the agent's
            own workspace: the c2c project, its docs, AGENTS.md walks, eval files

Sources: the agent's stream (Claude stream-json or `codex exec --json`) and, for
c2c runs, the Codex job transcripts copied into <run>/c2c-jobs.
"""

import json
import re
import sys
from pathlib import Path

REPO = str(Path(__file__).resolve().parent.parent)  # /…/projects/c2c

# Reaching the web where the fix could be (dirty) vs fetching packages (noted only).
NETWORK = re.compile(
    r"(?:^|[\s;&|(`$])(?:gh\s+\S|curl\s|wget\s|git\s+(?:clone|fetch|pull|ls-remote)\b)"
    r"|(?:urllib|requests|httpx|fetch\()[^\n]{0,200}https?://"
)
PACKAGES = re.compile(r"pip3?\s+(?:download|install)\b|npm\s+(?:install|i)\b|uv\s+pip\s+install\b|apt(?:-get)?\s+install\b")
PARENT_WALK = re.compile(r"\.parents\b|for\s+\w+\s+in\s+[^;]*\.\./|AGENTS\.md[^\n]*\.\.|\.\./\.\./")


def _outside(text, ws, own_dir):
    """Paths under the repo that are not the agent's own run directory."""
    hits = []
    for m in re.finditer(re.escape(REPO) + r"[^\s'\"`;)]*", text):
        p = m.group(0).rstrip(".,:")
        if ws and p.startswith(ws.rsplit("/testbed", 1)[0]):
            continue
        if p == own_dir or p.startswith(own_dir + "/"):
            continue  # pre-isolation runs: the agent's workspace lived in its run dir
        hits.append(p)
    return hits


def _commands(path):
    """(kind, text) for every tool call / shell command the agent issued."""
    if path.name == "agent.jsonl":
        for line in path.read_text(errors="ignore").splitlines():
            try:
                m = json.loads(line)
            except json.JSONDecodeError:
                continue
            if m.get("type") == "assistant":
                for c in m["message"].get("content", []):
                    if c.get("type") == "tool_use":
                        yield c["name"], json.dumps(c["input"])
            elif m.get("type") in ("item.started", "item.completed"):
                it = m.get("item") or {}
                if it.get("type") in ("web_search", "web_search_call"):
                    yield "codex_web_search", json.dumps(it)
                elif it.get("command"):
                    yield "codex_shell", it["command"]
    else:  # c2c Codex job record
        for e in json.loads(path.read_text()).get("transcript", []):
            d = e.get("detail") or ""
            if e.get("kind") == "command":
                yield "c2c_codex_shell", d
            elif "web_search" in d:
                yield "codex_web_search", d


PACKAGE_HOSTS = re.compile(r"(^|\.)(pypi\.org|files\.pythonhosted\.org|registry\.npmjs\.org|registry\.yarnpkg\.com|nuget\.org|crates\.io|repo1?\.maven\.org|repo\.maven\.apache\.org|plugins\.gradle\.org|services\.gradle\.org|proxy\.golang\.org)$")


def _all_blocked(cmd, blocked_log):
    """True when the command's fetches could not have reached a fix: every URL host
    was refused by the proxy or is a package registry, and any other network use
    is `gh`, which has no login in isolated runs."""
    hosts = set(re.findall(r"https?://([^/\s'\"]+)", cmd))
    refused = set(re.findall(r"BLOCKED \S+ ([^\s:]+)", blocked_log))
    if any(h not in refused and not PACKAGE_HOSTS.search(h) for h in hosts):
        return False
    return bool(hosts) or bool(re.search(r"(^|[\s;&|(])gh\s", cmd))


def audit_run(run_dir, ws=None):
    run_dir = Path(run_dir)
    if ws is None and (run_dir / "workspace_path.txt").exists():
        ws = (run_dir / "workspace_path.txt").read_text().strip()
    sources = [run_dir / "agent.jsonl", *sorted((run_dir / "c2c-jobs").glob("*.json"))]
    findings, notes = [], []
    own_dir = str(run_dir.resolve())
    for src in sources:
        if not src.exists():
            continue
        for kind, text in _commands(src):
            if kind in ("WebFetch", "WebSearch", "codex_web_search"):
                findings.append({"type": "web", "source": src.name, "tool": kind, "detail": text[:200]})
                continue
            shell = kind in ("Bash", "codex_shell", "c2c_codex_shell")
            body = json.loads(text).get("command", text) if kind == "Bash" else text
            if shell:
                # strip heredoc bodies: URLs written into files are not fetches
                body_cmd = re.sub(r"<<-?\s*'?(\w+)'?\n.*?\n\1\b", "<<heredoc>>", body, flags=re.S)
                # package fetches like `apt-get install curl` must not read as a curl call
                net_cmd = PACKAGES.sub("<pkg>", body_cmd)
                if NETWORK.search(re.sub(r"<pkg>[^;&|\n]*", "", net_cmd)):
                    findings.append({"type": "web", "source": src.name, "tool": kind, "detail": body_cmd[:4000]})
                elif PACKAGES.search(body_cmd):
                    notes.append({"type": "packages", "tool": kind, "detail": body_cmd[:160]})
                if PARENT_WALK.search(body_cmd):
                    findings.append({"type": "outside", "source": src.name, "tool": kind,
                                     "detail": "parent-directory walk: " + body_cmd[:160]})
            for p in _outside(text, ws, own_dir):
                findings.append({"type": "outside", "source": src.name, "tool": kind, "detail": p})
    blocked = run_dir / "blocked.log"
    blocked_text = blocked.read_text() if blocked.exists() else ""
    if blocked_text.strip():
        notes.append({"type": "blocked_attempts", "detail": blocked_text[-400:]})
    run_json = run_dir / "run.json"
    isolated = run_json.exists() and json.loads(run_json.read_text()).get("isolation") == "v3"
    if isolated:
        # behind the blocking proxy with gh logged out: an attempt whose hosts were all
        # refused, or a gh-only call, retrieved nothing — noted, not a finding
        shell = ("Bash", "codex_shell", "c2c_codex_shell")
        findings = [f for f in findings
                    if not (f["type"] == "web" and f["tool"] in shell and _all_blocked(f["detail"], blocked_text))]
    # one entry per distinct finding
    uniq = {(f["type"], f["tool"], f["detail"]): f for f in findings}
    return {"clean": not uniq, "findings": list(uniq.values()), "notes": notes[:20]}


if __name__ == "__main__":
    here = Path(__file__).resolve().parent
    dirs = [Path(a) for a in sys.argv[1:]] or sorted((here / "results").glob("pilot-*"))
    dirty = 0
    for d in dirs:
        if not (d / "run.json").exists():
            continue
        a = audit_run(d)
        if not a["clean"]:
            dirty += 1
            kinds = sorted({f["type"] for f in a["findings"]})
            print(f"{d.name}: {', '.join(kinds)} | {a['findings'][0]['detail'][:110]}")
    print(f"{dirty} of {len([d for d in dirs if (d / 'run.json').exists()])} runs not clean")
