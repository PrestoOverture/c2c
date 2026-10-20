"""c2c evaluation runner — SWE-bench Verified scoring path.

Subcommands:
  select            freeze the pilot instance list (pilot_instances.txt)
  pull              pre-pull the pilot's amd64 instance images
  predict           write a predictions JSONL for a run (gold | noop)
  score             grade a run's predictions with the official SWE-bench harness
  sanity            gold + noop runs on the pilot; asserts 10/10 and 0/10

Every run lives in results/<run_id>/: predictions.jsonl, harness logs, report,
summary.json. Agent arms (A–D, see docs/eval.md) will write the same
predictions.jsonl shape, so `score` is the single grading path for all of them.
"""

import argparse
import json
import os
import random
import subprocess
import sys
import time
from collections import defaultdict
from pathlib import Path

EVAL_DIR = Path(__file__).resolve().parent
REPO_ROOT = EVAL_DIR.parent
RESULTS_DIR = EVAL_DIR / "results"
PILOT_FILE = EVAL_DIR / "pilot_instances.txt"

# A HF dataset id, or a local JSON task file such as fresh/tasks.json (see fresh/build_task.py).
DATASET = os.environ.get("C2C_EVAL_DATASET", "SWE-bench/SWE-bench_Verified")
HARD = ("1-4 hours", ">4 hours")
PILOT_SIZE = 10
PILOT_SEED = 20261016

# Adds a new, unrelated file: the harness still applies a patch and runs the
# tests, but the code under test is base_commit. An empty patch would be
# skipped by the harness without running anything, which proves nothing.
NOOP_PATCH = """diff --git a/c2c_eval_noop.txt b/c2c_eval_noop.txt
new file mode 100644
--- /dev/null
+++ b/c2c_eval_noop.txt
@@ -0,0 +1 @@
+noop
"""


def load_dataset():
    if DATASET.endswith(".json"):
        return {r["instance_id"]: r for r in json.loads(Path(DATASET).read_text())}
    from datasets import load_dataset as hf_load

    return {r["instance_id"]: r for r in hf_load(DATASET, split="test")}


def read_pilot():
    lines = PILOT_FILE.read_text().splitlines()
    return [l.strip() for l in lines if l.strip() and not l.startswith("#")]


def cmd_select(args):
    if PILOT_FILE.exists() and not args.force:
        sys.exit(f"{PILOT_FILE.name} already frozen; pass --force to reselect")
    hard = [r for r in load_dataset().values() if r["difficulty"] in HARD]
    by_repo = defaultdict(list)
    for r in sorted(hard, key=lambda r: r["instance_id"]):
        by_repo[r["repo"]].append(r["instance_id"])

    # One per repo first, then the remaining slots go to the largest repos,
    # so coverage is broad and no repo dominates.
    alloc = {repo: 1 for repo in by_repo}
    for repo in sorted(by_repo, key=lambda k: -len(by_repo[k])):
        if sum(alloc.values()) >= PILOT_SIZE:
            break
        alloc[repo] += 1
    while sum(alloc.values()) < PILOT_SIZE:  # fewer repos than slots: top up the biggest
        alloc[max(by_repo, key=lambda k: len(by_repo[k]) - alloc[k])] += 1

    rng = random.Random(PILOT_SEED)
    picked = []
    for repo in sorted(by_repo):
        picked += rng.sample(by_repo[repo], min(alloc[repo], len(by_repo[repo])))

    header = [
        f"# Pilot instances — {DATASET}, difficulty in {HARD}",
        f"# {len(hard)} hard instances; stratified by repo, seed {PILOT_SEED}. Frozen: do not edit.",
    ]
    PILOT_FILE.write_text("\n".join(header + sorted(picked)) + "\n")
    print(f"wrote {len(picked)} instances to {PILOT_FILE.name}")


def write_predictions(run_id, kind, instance_ids):
    data = load_dataset()
    run_dir = RESULTS_DIR / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    path = run_dir / "predictions.jsonl"
    with path.open("w") as f:
        for iid in instance_ids:
            patch = data[iid]["patch"] if kind == "gold" else NOOP_PATCH
            f.write(json.dumps({"instance_id": iid, "model_name_or_path": kind, "model_patch": patch}) + "\n")
    return path


def pull_images(instance_ids):
    """The published images are amd64-only. The harness pulls for the host
    platform, which on Apple Silicon finds no manifest and reports the image as
    missing, so pull them explicitly; Docker then runs them under emulation."""
    data = load_dataset()
    for iid in instance_ids:
        image = data[iid]["image"]
        if subprocess.run(["docker", "image", "inspect", image], capture_output=True).returncode == 0:
            continue
        # Docker Hub's auth endpoint returns transient 503s; retry with backoff.
        for attempt in range(1, 6):
            print(f"pulling {image} (attempt {attempt})", flush=True)
            cmd = ["docker", "pull", "-q", "--platform", "linux/amd64", image]
            if subprocess.run(cmd).returncode == 0:
                break
            if attempt == 5:
                sys.exit(f"failed to pull {image} after 5 attempts")
            time.sleep(15 * attempt)


def cmd_pull(args):
    pull_images(read_pilot())


def cmd_predict(args):
    path = write_predictions(args.run_id, args.kind, read_pilot())
    print(f"wrote {path}")


def score(run_id, workers, timeout):
    run_dir = RESULTS_DIR / run_id
    preds = [json.loads(l) for l in (run_dir / "predictions.jsonl").read_text().splitlines()]
    ids = [p["instance_id"] for p in preds]
    tasks = load_dataset()
    if all(tasks[i].get("grader") == "multilang" for i in ids):
        import multilang

        summary = multilang.grade(run_dir, run_id, tasks)
    else:
        summary = score_with_harness(run_dir, run_id, preds, workers, timeout)
    (run_dir / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(
        f"{run_id}: resolved {len(summary['resolved'])}/{len(ids)}, "
        f"unresolved {len(summary['unresolved'])}, error {len(summary['error'])}, "
        f"patch applied {len(summary['patch_applied'])}/{len(ids)}"
    )
    return summary


def score_with_harness(run_dir, run_id, preds, workers, timeout):
    ids = [p["instance_id"] for p in preds]
    model = preds[0]["model_name_or_path"]
    cmd = [
        sys.executable, "-m", "swebench.harness.run_evaluation",
        "--dataset_name", str(Path(DATASET).resolve()) if DATASET.endswith(".json") else DATASET,
        "--predictions_path", "predictions.jsonl",
        "--run_id", run_id,
        "--max_workers", str(workers),
        "--timeout", str(timeout),
        "--instance_ids", *ids,
    ]
    # cwd = run dir so the harness's logs/ and report land inside the run.
    with (run_dir / "harness.log").open("w") as log:
        rc = subprocess.run(cmd, cwd=run_dir, stdout=log, stderr=subprocess.STDOUT).returncode
    report_path = run_dir / f"{model.replace('/', '__')}.{run_id}.json"
    if rc != 0 or not report_path.exists():
        sys.exit(f"harness failed (exit {rc}); see {run_dir / 'harness.log'}")

    report = json.loads(report_path.read_text())
    per_instance = {}
    for iid in ids:
        r = run_dir / "logs" / "run_evaluation" / run_id / model / iid / "report.json"
        per_instance[iid] = json.loads(r.read_text()).get(iid, {}) if r.exists() else None
    summary = {
        "run_id": run_id,
        "model": model,
        "submitted": len(ids),
        "resolved": report["resolved_ids"],
        "unresolved": report["unresolved_ids"],
        "error": report["error_ids"],
        "empty_patch": report["empty_patch_ids"],
        "patch_applied": sorted(i for i, r in per_instance.items() if r and r.get("patch_successfully_applied")),
    }
    return summary


def cmd_score(args):
    score(args.run_id, args.workers, args.timeout)


def cmd_sanity(args):
    ids = args.ids or read_pilot()
    n = len(ids)
    pull_images(ids)
    ok = True
    for kind, expect in (("gold", n), ("noop", 0)):
        run_id = f"sanity-{args.tag}-{kind}" if args.tag else f"sanity-{kind}"
        write_predictions(run_id, kind, ids)
        s = score(run_id, args.workers, args.timeout)
        # noop must still apply and be graded; an error is not a clean 0.
        good = len(s["resolved"]) == expect and not s["error"] and len(s["patch_applied"]) == n
        print(f"  {'PASS' if good else 'FAIL'}: expected {expect}/{n} resolved, 0 errors, {n} applied")
        ok &= good
    sys.exit(0 if ok else 1)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("select")
    s.add_argument("--force", action="store_true")
    s.set_defaults(fn=cmd_select)

    s = sub.add_parser("predict")
    s.add_argument("--run-id", required=True)
    s.add_argument("--kind", choices=("gold", "noop"), required=True)
    s.set_defaults(fn=cmd_predict)

    s = sub.add_parser("pull")
    s.set_defaults(fn=cmd_pull)

    for name, fn in (("score", cmd_score), ("sanity", cmd_sanity)):
        s = sub.add_parser(name)
        if name == "score":
            s.add_argument("--run-id", required=True)
        else:
            s.add_argument("--ids", nargs="+", help="instance ids (default: the pilot)")
            s.add_argument("--tag", default="", help="run ids become sanity-<tag>-<kind>")
        s.add_argument("--workers", type=int, default=2)
        s.add_argument("--timeout", type=int, default=1800)
        s.set_defaults(fn=fn)

    args = p.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
