"""Pilot runner: every (task, arm, repeat), shuffled with a fixed seed, resumable.

    C2C_EVAL_DATASET=fresh/tasks.json python pilot.py [--limit N] [--plan]
    C2C_EVAL_DATASET=fresh/tasks.json python pilot.py --tasks round2/probe.txt --arms S --repeats 1 --prefix probe

Each run reuses smoke.py's machinery (fresh workspace + container, quota
headroom checks, Claude/Codex usage snapshots before and after) and is then
graded twice, because timing-sensitive tests can flake. A run is done once
results/pilot-<task>-<arm>-r<k>/run.json exists, so re-invoking continues
where it stopped; --limit runs at most N pending runs (one "batch").
"""

import argparse
import json
import os
import random
import secrets
import shutil
import subprocess
import sys
import time
from pathlib import Path

import audit
import blockproxy
import smoke
from run import EVAL_DIR, RESULTS_DIR, load_dataset, pull_images, score

ARMS = ["A", "B", "C", "D", "E"]
REPEATS = 3
SEED = 20261018
PILOT_FILE = EVAL_DIR / "fresh" / "pilot_fresh.txt"
GRADES = 2
proxy = blockproxy.BlockProxy().start()  # one per runner process; log_path set per run
WS_ROOT = Path("/tmp/ws")  # deliberately outside the repo: agents walk parents for AGENTS.md


PREFIX = "pilot"  # run ids are <PREFIX>-<task>-<arm>-r<k>; --prefix keeps other rounds apart


def plan(task_file=PILOT_FILE, arms=ARMS, repeats=REPEATS):
    ids = [l.strip() for l in task_file.read_text().splitlines() if l.strip() and not l.startswith("#")]
    runs = [(iid, arm, k) for iid in ids for arm in arms for k in range(1, repeats + 1)]
    random.Random(SEED).shuffle(runs)
    return runs


def run_id_of(iid, arm, k):
    return f"{PREFIX}-{iid.split('__')[1]}-{arm}-r{k}"


def grade(run_id):
    """Grade a run GRADES times from scratch; returns each grade's summary."""
    run_dir = RESULTS_DIR / run_id
    grades = []
    for g in range(1, GRADES + 1):
        for stale in ("logs", "multilang", "summary.json", "harness.log"):
            p = run_dir / stale
            shutil.rmtree(p) if p.is_dir() else p.unlink(missing_ok=True)
        for report in run_dir.glob("arm-*.json"):
            report.unlink()
        try:
            s = score(run_id, workers=1, timeout=1800)
        except SystemExit as e:  # harness failure: record it, keep going
            s = {"error": str(e)}
        (run_dir / f"grade-{g}.json").write_text(json.dumps(s, indent=2) + "\n")
        grades.append({"resolved": bool(s.get("resolved")), "error": bool(s.get("error"))})
        ensure_docker()
    return grades


def grade_fields(grades):
    if grades is None:  # agent-only run (cloud agent job); grade_existing fills these in
        return {"grades": None, "resolved": None, "grades_disagree": None}
    return {"grades": grades, "resolved": all(g["resolved"] for g in grades),
            "grades_disagree": len({g["resolved"] for g in grades}) > 1}


def grade_existing(run_id):
    """Grade a run whose agent ran elsewhere (cloud agent job without the gold data)."""
    path = RESULTS_DIR / run_id / "run.json"
    record = json.loads(path.read_text())
    record.update(grade_fields(grade(run_id)))
    record["audit"] = audit.audit_run(RESULTS_DIR / run_id)
    path.write_text(json.dumps(record, indent=2) + "\n")
    return record


def ensure_docker():
    """Docker Desktop has quit on its own between runs; start it and wait."""
    if subprocess.run(["docker", "info"], capture_output=True).returncode == 0:
        return
    print("  docker is down; starting Docker Desktop", flush=True)
    subprocess.run(["open", "-a", "Docker"])
    for _ in range(60):
        time.sleep(5)
        if subprocess.run(["docker", "info"], capture_output=True).returncode == 0:
            return
    sys.exit("docker did not come up within 5 minutes")


def do_run(inst, arm, run_id, template, grade_now=True):
    ensure_docker()
    run_dir = RESULTS_DIR / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    if arm != "B":
        smoke.wait_for_headroom("claude", smoke.claude_usage)
    if arm in ("B", "C"):
        smoke.wait_for_headroom("codex", smoke.codex_usage)
    # Everything the agent can see lives under an opaque dir outside this repo,
    # with an opaque container and image tag: no PR number, no eval files.
    token = secrets.token_hex(6)
    opaque = WS_ROOT / token
    opaque.mkdir(parents=True)
    ctr = f"ws-{token}"
    alias = f"ws-image:{token}"
    subprocess.run(["docker", "tag", inst["image"], alias], check=True)
    try:
        ws, envrun, base = smoke.prepare_workspace(dict(inst, image=alias), opaque, ctr)
        prompt = template.format(repo=inst["repo"], workdir=ws, envrun=envrun,
                                 problem_statement=inst["problem_statement"])
        cmd = smoke.arm_command(arm, prompt, opaque)

        before = smoke.snapshot(arm)
        proxy.log_path = run_dir / "blocked.log"
        outcome = smoke.run_agent(cmd, ws, run_dir / "agent.jsonl", env=smoke.agent_env(opaque, proxy.url))
        proxy.log_path = None
        time.sleep(30)  # let usage counters settle
        after = smoke.snapshot(arm)
        subprocess.run(["docker", "rm", "-f", ctr], capture_output=True)
        log_text = (run_dir / "agent.jsonl").read_text(errors="ignore")
        if '"error":"authentication_failed"' in log_text:
            # not an agent outcome: leave no run.json so the run stays pending
            sys.exit(f"{run_id}: agent could not authenticate; fix the login and rerun")
        jobs_text = "".join(f.read_text(errors="ignore") for f in (opaque / "c2c-jobs").glob("*.json"))
        if ('"error":"rate_limit"' in log_text or "hit your limit" in log_text
                or "hit your usage limit" in jobs_text):
            sys.exit(f"{run_id}: Claude or Codex hit the plan's usage limit mid-run; rerun after the reset")
        # the work container writes into the bind-mounted checkout as root; on a cloud
        # runner those files can be unreadable to git here, so take ownership back first
        subprocess.run(["sudo", "-n", "chown", "-R", f"{os.getuid()}:{os.getgid()}", str(ws)], capture_output=True)
        patch = smoke.collect_patch(ws, base)
        if (opaque / "c2c-jobs").exists():
            shutil.copytree(opaque / "c2c-jobs", run_dir / "c2c-jobs")
        (run_dir / "workspace_path.txt").write_text(str(ws) + "\n")
    finally:
        subprocess.run(["docker", "rm", "-f", ctr], capture_output=True)
        subprocess.run(["docker", "rmi", alias], capture_output=True)
        shutil.rmtree(opaque, ignore_errors=True)
    (run_dir / "predictions.jsonl").write_text(json.dumps(
        {"instance_id": inst["instance_id"], "model_name_or_path": f"arm-{arm}", "model_patch": patch}) + "\n")
    grades = grade(run_id) if grade_now else None
    record = {
        "run_id": run_id, "arm": arm, "instance_id": inst["instance_id"],
        "models": {"opus": smoke.OPUS, "sonnet": smoke.SONNET, "codex": smoke.CODEX_MODEL, "effort": smoke.EFFORT},
        **outcome, "patch_lines": patch.count("\n"),
        **grade_fields(grades),
        "usage_before": before, "usage_after": after,
        "claude_delta": smoke.delta(before, after, "claude"),
        "codex_delta": smoke.delta(before, after, "codex"),
        "claude": smoke.claude_metrics(run_dir / "agent.jsonl") if arm != "B" else None,
        "codex_exec": smoke.codex_exec_metrics(run_dir / "agent.jsonl") if arm == "B" else None,
        "c2c_jobs": smoke.c2c_job_metrics(run_dir) if arm == "C" else None,
        "isolation": "v3",  # v2 + blocking proxy for agent web traffic, no network in the work container
    }
    record["audit"] = audit.audit_run(run_dir, ws=str(ws))
    (run_dir / "run.json").write_text(json.dumps(record, indent=2) + "\n")
    return record


def main():
    global PREFIX
    p = argparse.ArgumentParser()
    p.add_argument("--limit", type=int, default=None, help="run at most N pending runs")
    p.add_argument("--plan", action="store_true", help="print the run order and progress, run nothing")
    p.add_argument("--tasks", type=Path, default=PILOT_FILE, help="task list, relative to eval/")
    p.add_argument("--arms", nargs="+", default=ARMS, choices=ARMS + ["S"])
    p.add_argument("--repeats", type=int, default=REPEATS)
    p.add_argument("--prefix", default="pilot")
    p.add_argument("--no-grade", action="store_true", help="run agents only; grade later with --grade-existing")
    p.add_argument("--grade-existing", nargs="+", metavar="RUN_ID", help="grade runs whose agent ran elsewhere")
    p.add_argument("--rmi", action="store_true",
                   help="pull each task image before its run and remove it after (disk too small for all)")
    args = p.parse_args()

    PREFIX = args.prefix
    if args.grade_existing:
        for run_id in args.grade_existing:
            r = grade_existing(run_id)
            print(f"{run_id}: resolved={r['resolved']}{' (grades disagree)' if r['grades_disagree'] else ''}", flush=True)
        return
    task_file = args.tasks if args.tasks.is_absolute() else EVAL_DIR / args.tasks
    runs = plan(task_file, args.arms, args.repeats)
    pending = [r for r in runs if not (RESULTS_DIR / run_id_of(*r) / "run.json").exists()]
    if args.plan:
        for i, r in enumerate(runs, 1):
            print(f"{i:3} {run_id_of(*r)} {'done' if r not in pending else ''}")
        print(f"{len(runs) - len(pending)}/{len(runs)} done")
        return

    data = load_dataset()
    for iid, _, _ in runs:
        task = data[iid]
        if (task.get("screening") or {}).get("decision") != "keep":
            sys.exit(f"{iid} is not screened in")
    template = (EVAL_DIR / "task_prompt.md").read_text()
    batch = pending[: args.limit] if args.limit else pending
    for n, (iid, arm, k) in enumerate(batch, 1):
        run_id = run_id_of(iid, arm, k)
        shutil.rmtree(RESULTS_DIR / run_id, ignore_errors=True)  # a half-finished earlier attempt
        print(f"[{n}/{len(batch)}] {run_id}: running", flush=True)
        if args.rmi:
            ensure_docker()
            pull_images([iid])
        r = do_run(data[iid], arm, run_id, template, grade_now=not args.no_grade)
        if args.rmi:
            subprocess.run(["docker", "rmi", "-f", data[iid]["image"]], capture_output=True)
            subprocess.run(["docker", "image", "prune", "-f"], capture_output=True)
        print(f"[{n}/{len(batch)}] {run_id}: {r['duration_s'] // 60} min, exit {r['exit_code']}"
              f"{' TIMEOUT' if r['timed_out'] else ''}, resolved={r['resolved']}"
              f"{' (grades disagree)' if r['grades_disagree'] else ''}, "
              f"claude Δ {r['claude_delta']}, codex Δ {r['codex_delta']}", flush=True)
    done = len(runs) - len(pending) + len(batch)
    print(f"BATCH DONE: {done}/{len(runs)} runs complete")


if __name__ == "__main__":
    main()
