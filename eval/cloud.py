"""Run round-2 eval jobs on GitHub Actions (native x86, no emulation).

    python cloud.py sync                 # mirror eval code + round-2 tasks into the runner repo, push
    python cloud.py sanity [ids...]      # dispatch sanity jobs (default: all screened-in round-2 tasks)
    python cloud.py fetch <run-id>       # download a sanity run's artifacts, merge into results/sanity-r2-cloud.json
    python cloud.py agent <arm> <prefix> [--parallel N] ids...   # dispatch agent runs (graded in a later job)
    python cloud.py runs <run-id>        # download graded agent runs into results/

The runner repo (public) is a mirror; this repo stays the source of truth.
"""

import gzip
import json
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from run import EVAL_DIR, REPO_ROOT, RESULTS_DIR

RUNNER = REPO_ROOT.parent / "c2c-eval-runner"
REMOTE = "PrestoOverture/c2c-eval-runner"
POOL = EVAL_DIR / "candidates" / "round2_pool.json"
CODE = ["run.py", "multilang.py", "sanity_r2.py", "smoke.py", "pilot.py", "audit.py", "blockproxy.py",
        "codex_usage.py", "task_prompt.md"]
CLOUD_SANITY = RESULTS_DIR / "sanity-r2-cloud.json"


def sh(*cmd, cwd=None):
    return subprocess.run(cmd, cwd=cwd, check=True, capture_output=True, text=True).stdout


def download(run_id, dest, pattern=None):
    """gh run download, retried; a failed attempt can leave partial files, so each starts clean."""
    for attempt in range(1, 5):
        shutil.rmtree(dest, ignore_errors=True)
        cmd = ["gh", "run", "download", run_id, "-R", REMOTE, "-D", str(dest)] + (["-p", pattern] if pattern else [])
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode == 0:
            return
        time.sleep(20 * attempt)
    sys.exit(f"gh run download {run_id} failed: {r.stderr.strip()[-500:]}")


def screened_in():
    tasks = {t["instance_id"]: t for t in json.loads((EVAL_DIR / "fresh" / "tasks.json").read_text())}
    return [i for i in json.loads(POOL.read_text()) if (tasks[i].get("screening") or {}).get("decision") == "keep"], tasks


def cmd_sync(_):
    ids, tasks = screened_in()
    dst = RUNNER / "eval"
    (dst / "fresh").mkdir(parents=True, exist_ok=True)
    for f in CODE:
        shutil.copy2(EVAL_DIR / f, dst / f)
    (RUNNER / "prompts").mkdir(exist_ok=True)
    shutil.copy2(REPO_ROOT / "prompts" / "what-claude-sees.md", RUNNER / "prompts" / "what-claude-sees.md")
    with gzip.open(dst / "fresh" / "tasks.json.gz", "wt") as f:
        json.dump([tasks[i] for i in ids], f)
    (RUNNER / ".gitignore").write_text("eval/fresh/tasks.json\neval/results/\n__pycache__/\n")
    sh("git", "add", "-A", cwd=RUNNER)
    if subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=RUNNER).returncode:
        sh("git", "commit", "-q", "-m", "Sync eval code and round-2 tasks from c2c", cwd=RUNNER)
        sh("git", "push", "-q", "origin", "main", cwd=RUNNER)
        print("pushed")
    else:
        print("runner already up to date")


def cmd_sanity(args):
    ids = args or screened_in()[0]
    sh("gh", "workflow", "run", "sanity.yml", "-R", REMOTE, "-f", f"ids={json.dumps(ids)}")
    print(f"dispatched sanity for {len(ids)} tasks; runs: https://github.com/{REMOTE}/actions")


def cmd_fetch(args):
    run_id = args[0]
    merged = json.loads(CLOUD_SANITY.read_text()) if CLOUD_SANITY.exists() else {}
    with tempfile.TemporaryDirectory() as tmp:
        download(run_id, Path(tmp) / "dl")
        for f in Path(tmp).glob("dl/sanity-*/sanity-r2.json"):
            merged.update(json.loads(f.read_text()))
        logs = RESULTS_DIR / f"cloud-{run_id}"
        shutil.copytree(tmp, logs, dirs_exist_ok=True)
    CLOUD_SANITY.write_text(json.dumps(merged, indent=2) + "\n")
    for iid, r in sorted(merged.items()):
        t = (r.get("gold") or {}).get("timings_s") or {}
        print(f"{iid:45} {r['verdict'][:70]:70} {sum(t.values()) // 60 if t else '-'}m")
    print(f"{sum(r['verdict'] == 'pass' for r in merged.values())}/{len(merged)} pass")


def cmd_agent(args):
    arm, prefix, rest = args[0], args[1], args[2:]
    parallel = "2"
    if rest[:1] == ["--parallel"]:
        parallel, rest = rest[1], rest[2:]
    sh("gh", "workflow", "run", "agent.yml", "-R", REMOTE, "-f", f"ids={json.dumps(rest)}",
       "-f", f"arm={arm}", "-f", f"prefix={prefix}", "-f", f"max_parallel={parallel}")
    print(f"dispatched {len(rest)} {arm} runs ({parallel} at a time); runs: https://github.com/{REMOTE}/actions")


def cmd_runs(args):
    run_id = args[0]
    with tempfile.TemporaryDirectory() as tmp:
        download(run_id, Path(tmp) / "dl", "run-*")
        for run_json in Path(tmp).glob("dl/run-*/*/run.json"):
            dst = RESULTS_DIR / run_json.parent.name
            shutil.copytree(run_json.parent, dst, dirs_exist_ok=True)
            r = json.loads(run_json.read_text())
            clean = (r.get("audit") or {}).get("clean")
            print(f"{dst.name:45} resolved={r['resolved']} clean={clean} {r['duration_s'] // 60}m "
                  f"claude {r['claude_delta']} codex {r['codex_delta']}")


if __name__ == "__main__":
    cmds = {"sync": cmd_sync, "sanity": cmd_sanity, "fetch": cmd_fetch, "agent": cmd_agent, "runs": cmd_runs}
    if len(sys.argv) < 2 or sys.argv[1] not in cmds:
        sys.exit(__doc__)
    cmds[sys.argv[1]](sys.argv[2:])
