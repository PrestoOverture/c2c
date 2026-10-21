"""Smoke run: one instance through every arm, measuring plan-quota consumption.

    python smoke.py --instance django__django-15503 [--arms B A C D E]

Per arm: fresh copy of the instance's /testbed on the host, bind-mounted into
an amd64 container from the instance image; the agent runs on the host and
reaches the Python environment through bin/envrun (docker exec). Before and
after each run it records Claude Pro (5h / 7d utilization from a tiny probe)
and Codex Plus (account/rateLimits/read) usage. The final patch goes to
results/smoke-<arm>/predictions.jsonl for `run.py score --run-id smoke-<arm>`.

Smoke-only shortcuts (see docs/eval.md): agents run on the host, so there is no
network block and no filesystem isolation beyond the agents' own instructions.
"""

import argparse
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

from codex_usage import list_models, read_rate_limits
from run import EVAL_DIR, REPO_ROOT, RESULTS_DIR, load_dataset

OPUS = "claude-opus-5-5"
SONNET = "claude-sonnet-5-5"
PROBE_MODEL = "claude-haiku-5-5"
CODEX_MODEL = "gpt-6.1-sol"
EFFORT = "high"
C2C_PACKAGE = "claude2codex@0.3.6"

RUN_CAP_S = 90 * 60
CLAUDE_START_MAX = 0.85  # a Claude arm waits for the 5h reset only if it would start above this
CODEX_START_MAX = 0.80  # same for Codex (arm C); a c2c run spends ~7% of the Codex 5h window
RESET_GUARD_S = 15 * 60  # ...or if the window resets within this long (the 5h delta would be lost)

UNATTENDED = (
    "\n\n## Evaluation mode\n"
    "This is an unattended evaluation run. No user is present: every step that asks for the "
    "user's approval is already approved. Never wait for or ask the user anything. Finish "
    "with the fix applied in the working tree.\n"
    "If the implementer fails (error, no output, no handoff), retry it at most once; if it "
    "fails again, stop and report the failure. Never implement the fix yourself."
)

# Session mechanics only, identical for every Claude arm (A, C, D, E): in -p mode
# the session ends the moment the model ends its turn, so a run that "waits" by
# backgrounding a sleep and ending its turn kills its own Codex job/subagent.
HEADLESS = (
    "\n\n## Session mechanics\n"
    "This session is non-interactive. It ends the moment you end your turn, and nothing will "
    "resume it later. Do not run commands in the background and do not end your turn while "
    "waiting for anything. To wait, pause in the foreground "
    "(for example `python3 -c 'import time; time.sleep(60)'`) and then check again."
)

CLAUDE_BASE = [
    "claude", "-p", "--model", OPUS, "--effort", EFFORT,
    "--output-format", "stream-json", "--verbose",
    "--setting-sources", "", "--strict-mcp-config",
    "--permission-mode", "bypassPermissions",
    "--disallowedTools", "Monitor", "ScheduleWakeup", "CronCreate", "WebFetch", "WebSearch",
]

# Every arm runs with no route to the upstream fix: no web tools (above for
# Claude, web_search="disabled" for Codex), no GitHub CLI login (agent_env), and
# a workspace outside this repo under an opaque name (pilot.py), so neither the
# PR number nor the eval's own files and AGENTS.md are within reach.
CODEX_NO_WEB = 'web_search="disabled"'


def agent_env(home_dir, proxy_url=None):
    env = {k: v for k, v in os.environ.items()
           if k not in ("GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN")}
    gh = home_dir / "gh-empty"
    gh.mkdir(parents=True, exist_ok=True)
    env.update(GH_CONFIG_DIR=str(gh), GIT_TERMINAL_PROMPT="0")
    if proxy_url:  # blockproxy.py: refuses GitHub / code search / search engines, passes the model APIs
        for k in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
            env[k] = proxy_url
        env["NO_PROXY"] = env["no_proxy"] = "localhost,127.0.0.1"
    return env


def sh(*cmd, **kw):
    return subprocess.run(cmd, check=True, capture_output=True, text=True, **kw).stdout


# ---------- usage ----------

def claude_usage():
    """Tiny Haiku call; its rate_limit_event carries the Pro windows' utilization."""
    out = subprocess.run(
        ["claude", "-p", "Reply with: ok", "--model", PROBE_MODEL, "--output-format", "stream-json",
         "--verbose", "--setting-sources", "", "--strict-mcp-config"],
        capture_output=True, text=True, stdin=subprocess.DEVNULL,
    ).stdout
    for line in out.splitlines():
        m = json.loads(line)
        if m.get("type") == "rate_limit_event":
            w = m["rate_limit_info"].get("unifiedWindows", {})
            return {k: {"utilization": v["utilization"], "resets_at": v["resetsAt"]} for k, v in w.items()}
    return None


def codex_usage():
    rl = read_rate_limits()["rateLimits"]
    return {
        name: {"utilization": rl[key]["usedPercent"] / 100, "resets_at": rl[key]["resetsAt"]}
        for key, name in (("primary", "five_hour"), ("secondary", "seven_day")) if rl.get(key)
    }


def _retry(read, tries=4):
    """Usage reads hit the network; a transient failure must not kill a run."""
    for attempt in range(tries):
        try:
            return read()
        except Exception as e:  # noqa: BLE001 — any failure here just means "unknown"
            err = e
            time.sleep(15 * (attempt + 1))
    print(f"  usage read failed after {tries} tries: {err}", flush=True)
    return None


def snapshot(arm=None):
    """Usage of both plans; an arm that never touches one side skips reading it
    (a cloud runner may have no login for it)."""
    claude = _retry(claude_usage) if arm != "B" else None
    codex = _retry(codex_usage) if arm in (None, "B", "C") else None
    return {"at": time.time(), "claude": claude, "codex": codex}


def wait_for_headroom(side, read):
    """Wait for the 5h window to reset if it is too full to start a run, or if it
    would reset mid-run (a reset makes the run's 5h delta unmeasurable)."""
    u = _retry(read)
    if not u or "five_hour" not in u:
        return
    w = u["five_hour"]
    too_full = w["utilization"] > (CLAUDE_START_MAX if side == "claude" else CODEX_START_MAX)
    resets_mid_run = w["resets_at"] - time.time() < RESET_GUARD_S
    if too_full or resets_mid_run:
        until = w["resets_at"] + 60
        print(f"  {side} 5h window at {w['utilization']:.0%}, resets "
              f"{time.strftime('%H:%M', time.localtime(w['resets_at']))}; waiting for the reset", flush=True)
        time.sleep(max(0, until - time.time()))


# ---------- workspace ----------

def prepare_workspace(inst, run_dir, ctr):
    ws = run_dir / "testbed"
    plat = inst.get("platform", "linux/amd64")
    plat_flag = ["--platform", plat] if plat else []
    tmp = sh("docker", "create", *plat_flag, inst["image"]).strip()
    try:
        sh("docker", "cp", f"{tmp}:/testbed", str(ws))
    finally:
        sh("docker", "rm", tmp)
    subprocess.run(["docker", "rm", "-f", ctr], capture_output=True)
    # no network inside the work container: envrun must not be a way around the proxy
    sh("docker", "run", "-d", *plat_flag, "--network", "none", "--name", ctr,
       "-v", f"{ws}:/testbed", inst["image"], "sleep", "infinity")
    envrun = run_dir / "bin" / "envrun"
    envrun.parent.mkdir(exist_ok=True)
    envrun.write_text(
        "#!/bin/bash\n"
        f'exec docker exec -i -w /testbed {ctr} bash -c '
        f'"{inst.get("env_activate", "source /opt/miniconda3/bin/activate testbed")} && $*"\n'
    )
    envrun.chmod(0o755)
    base = inst["base_commit"]
    if inst.get("sanitize_git"):
        # The image's .git can still hold the upstream fix (objects, reflog);
        # replace the agent's copy with a single commit of the base tree.
        sh("rm", "-rf", str(ws / ".git"))
        sh("git", "init", "-q", cwd=ws)
        sh("git", "add", "-A", cwd=ws)
        sh("git", "-c", "user.name=c2c-eval", "-c", "user.email=eval@c2c.invalid",
           "commit", "-q", "-m", "base", cwd=ws)
        base = sh("git", "rev-parse", "HEAD", cwd=ws).strip()
    return ws, envrun, base


def collect_patch(ws, base_commit):
    sh("git", "-C", str(ws), "add", "-A")
    return sh(
        "git", "-C", str(ws), "diff", "--cached", base_commit, "--", ".",
        ":(exclude,glob)tests/**", ":(exclude,glob)**/tests/**", ":(exclude,glob)testing/**",
        ":(exclude,glob)**/test_*.py", ":(exclude,glob)test/**", ":(exclude,glob)**/test/**",
        ":(exclude,glob)**/__tests__/**", ":(exclude,glob)**/*.test.*", ":(exclude,glob)**/*.spec.*",
    )


# ---------- arms ----------

def workflow_text():
    """The c2c-workflow MCP prompt, as rendered in prompts/what-claude-sees.md."""
    doc = (REPO_ROOT / "prompts" / "what-claude-sees.md").read_text()
    section = doc[doc.index("## 2. The `c2c-workflow` Prompt"):doc.index("## 3. Tool descriptions")]
    return section.split("````markdown\n", 1)[1].rsplit("````", 1)[0]  # the fenced prompt body only


def c2c_lite_text():
    skill = sh("git", "-C", str(REPO_ROOT), "show", "5f1b6a1:skills/c2c-lite/SKILL.md")
    return skill.split("---", 2)[2]  # drop frontmatter


def arm_command(arm, prompt, run_dir):
    if arm == "A":
        return CLAUDE_BASE + ["--append-system-prompt", HEADLESS.lstrip(), prompt]
    if arm == "S":  # round-2 difficulty probe: arm A with Sonnet, never reported as a result
        base = [SONNET if a == OPUS else a for a in CLAUDE_BASE]
        return base + ["--append-system-prompt", HEADLESS.lstrip(), prompt]
    if arm == "B":
        return ["codex", "exec", "--json", "-m", CODEX_MODEL, "-c", f"model_reasoning_effort={EFFORT}",
                "-c", CODEX_NO_WEB, "-s", "danger-full-access", "--skip-git-repo-check", prompt]
    if arm == "C":
        mcp = {"mcpServers": {"codex": {"command": "npx", "args": ["-y", C2C_PACKAGE], "env": {
            "CODEX_MODEL": CODEX_MODEL,
            "CODEX_ARGS": f"app-server -c model_reasoning_effort={EFFORT} -c sandbox_mode=danger-full-access -c {CODEX_NO_WEB}",
            "CODEX_JOB_TIMEOUT_MS": str(80 * 60 * 1000),
            "C2C_STATE_DIR": str(run_dir / "c2c-jobs"),
        }}}}
        (run_dir / "mcp.json").write_text(json.dumps(mcp, indent=2))
        note = UNATTENDED + f"\nPass reasoning_effort \"{EFFORT}\" on every codex_implement and codex_rework call."
        return CLAUDE_BASE + ["--mcp-config", str(run_dir / "mcp.json"),
                              "--append-system-prompt", workflow_text() + note + HEADLESS, prompt]
    if arm in ("D", "E"):
        model = SONNET if arm == "D" else OPUS
        agents = {"implementer": {
            "description": "Implements a Goal Contract and returns a handoff.",
            "prompt": "You implement the Goal Contract you are given, run its verification commands, and end with the requested handoff.",
            "model": model, "effort": EFFORT,
        }}
        (run_dir / "agents.json").write_text(json.dumps(agents, indent=2))
        note = UNATTENDED + ("\nSpawn the implementer with subagent_type \"implementer\" and do not "
                             "override its model.")
        return CLAUDE_BASE + ["--agents", str(run_dir / "agents.json"),
                              "--append-system-prompt", c2c_lite_text() + note + HEADLESS, prompt]
    raise ValueError(arm)


def run_agent(cmd, cwd, log_path, env=None):
    start = time.time()
    with log_path.open("w") as log:
        proc = subprocess.Popen(cmd, cwd=cwd, stdout=log, stderr=subprocess.STDOUT, env=env,
                                stdin=subprocess.DEVNULL, start_new_session=True)
        try:
            rc = proc.wait(timeout=RUN_CAP_S)
            timed_out = False
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)  # also takes down c2c's codex app-server
            rc, timed_out = proc.wait(), True
    return {"exit_code": rc, "timed_out": timed_out, "duration_s": round(time.time() - start)}


# ---------- metrics from logs ----------

def claude_metrics(log_path):
    result = None
    for line in log_path.read_text().splitlines():
        try:
            m = json.loads(line)
        except json.JSONDecodeError:
            continue
        if m.get("type") == "result":
            result = m
    if not result:
        return None
    return {k: result.get(k) for k in ("subtype", "is_error", "num_turns", "total_cost_usd", "usage", "modelUsage")}


def codex_exec_metrics(log_path):
    totals = {}
    for line in log_path.read_text().splitlines():
        try:
            m = json.loads(line)
        except json.JSONDecodeError:
            continue
        if m.get("type") == "turn.completed":
            for k, v in (m.get("usage") or {}).items():
                if isinstance(v, int):
                    totals[k] = totals.get(k, 0) + v
    return totals


def c2c_job_metrics(run_dir):
    jobs = []
    for f in sorted((run_dir / "c2c-jobs").glob("*.json")):
        j = json.loads(f.read_text())
        jobs.append({k: j.get(k) for k in ("id", "kind", "state", "turns", "usage", "attempts")})
    return jobs


def delta(before, after, side):
    b, a = before.get(side), after.get(side)
    if not b or not a:
        return None
    out = {}
    for w in ("five_hour", "seven_day"):
        if w in a and w in b:
            # A fresh, unused window can report a placeholder reset time that
            # moves on first use; only a used window whose reset moved really reset.
            moved = abs(a[w]["resets_at"] - b[w]["resets_at"]) > 600
            reset = moved and b[w]["utilization"] > 0
            out[w] = None if reset else round(a[w]["utilization"] - b[w]["utilization"], 4)
    return out  # None for a window that reset mid-run: the delta is not measurable


# ---------- main ----------

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--instance", required=True)
    p.add_argument("--arms", nargs="+", default=["B", "A", "C", "D", "E"])
    p.add_argument("--tag", default="", help="run ids become smoke-<tag>-<arm>")
    args = p.parse_args()

    if {"B", "C"} & set(args.arms):
        # Codex answers an unknown model id with a 400 that reads like a plan
        # restriction, mid-run; check the id against the account up front.
        models = list_models()
        if EFFORT not in models.get(CODEX_MODEL, []):
            sys.exit(f"Codex model {CODEX_MODEL!r} with effort {EFFORT!r} not available; have: {models}")

    inst = load_dataset()[args.instance]
    if "screening" in inst and (inst["screening"] or {}).get("decision") != "keep":
        sys.exit(f"{args.instance} is not screened in (see fresh/screen.py): {inst['screening']}")
    template = (EVAL_DIR / "task_prompt.md").read_text()

    for arm in args.arms:
        run_id = f"smoke-{args.tag}-{arm}" if args.tag else f"smoke-{arm}"
        run_dir = RESULTS_DIR / run_id
        if (run_dir / "run.json").exists():
            print(f"{run_id}: already done, skipping")
            continue
        run_dir.mkdir(parents=True, exist_ok=True)
        print(f"{run_id}: preparing", flush=True)
        if arm != "B":
            wait_for_headroom("claude", claude_usage)
        if arm in ("B", "C"):
            wait_for_headroom("codex", codex_usage)
        ctr = f"c2c-eval-{run_id}"
        ws, envrun, base = prepare_workspace(inst, run_dir, ctr)
        prompt = template.format(repo=inst["repo"], workdir=ws, envrun=envrun,
                                 problem_statement=inst["problem_statement"])
        cmd = arm_command(arm, prompt, run_dir)

        before = snapshot()
        print(f"{run_id}: running (cap {RUN_CAP_S // 60} min)", flush=True)
        outcome = run_agent(cmd, ws, run_dir / "agent.jsonl")
        time.sleep(30)  # let usage counters settle
        after = snapshot()
        subprocess.run(["docker", "rm", "-f", ctr], capture_output=True)

        patch = collect_patch(ws, base)
        with (run_dir / "predictions.jsonl").open("w") as f:
            f.write(json.dumps({"instance_id": args.instance, "model_name_or_path": f"arm-{arm}",
                                "model_patch": patch}) + "\n")
        record = {
            "run_id": run_id, "arm": arm, "instance_id": args.instance,
            "models": {"opus": OPUS, "sonnet": SONNET, "codex": CODEX_MODEL, "effort": EFFORT},
            **outcome,
            "patch_lines": patch.count("\n"),
            "usage_before": before, "usage_after": after,
            "claude_delta": delta(before, after, "claude"),
            "codex_delta": delta(before, after, "codex"),
            "claude": claude_metrics(run_dir / "agent.jsonl") if arm != "B" else None,
            "codex_exec": codex_exec_metrics(run_dir / "agent.jsonl") if arm == "B" else None,
            "c2c_jobs": c2c_job_metrics(run_dir) if arm == "C" else None,
        }
        (run_dir / "run.json").write_text(json.dumps(record, indent=2) + "\n")
        print(f"{run_id}: done in {outcome['duration_s'] // 60} min, exit {outcome['exit_code']}"
              f"{' TIMEOUT' if outcome['timed_out'] else ''}, patch {record['patch_lines']} lines, "
              f"claude Δ {record['claude_delta']}, codex Δ {record['codex_delta']}", flush=True)


if __name__ == "__main__":
    main()
