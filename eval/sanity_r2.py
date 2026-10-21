"""Round-2 gold/no-op sanity, one task at a time, resumable.

    C2C_EVAL_DATASET=fresh/tasks.json python sanity_r2.py [ids...]

Disk only holds a few task images at once, so each repo's images are pulled,
checked and removed before the next repo. Per task: grade the gold patch; if it
resolves within the time limit (rebuild + test + print, docs/eval.md "Round 2
design"), grade the no-op patch too. Outcomes go to results/sanity-r2.json,
keyed by instance id; ids already there are skipped.
"""

import json
import subprocess
import sys
import time
from itertools import groupby

import multilang
from run import EVAL_DIR, RESULTS_DIR, load_dataset, pull_images, score, write_predictions

POOL = EVAL_DIR / "candidates" / "round2_pool.json"
OUT = RESULTS_DIR / "sanity-r2.json"
GOLD_LIMIT_S = 15 * 60
multilang.CMD_TIMEOUT_S = GOLD_LIMIT_S + 60  # a command that alone exceeds the limit fails the task anyway


def ensure_docker():
    """Docker Desktop quits on its own at times (see pilot.py)."""
    if subprocess.run(["docker", "info"], capture_output=True).returncode == 0:
        return
    subprocess.run(["open", "-a", "Docker"])
    for _ in range(60):
        time.sleep(5)
        if subprocess.run(["docker", "info"], capture_output=True).returncode == 0:
            return
    sys.exit("docker did not come up within 5 minutes")


def grade(iid, kind):
    run_id = f"sanity-r2-{iid.split('__')[1]}-{kind}"
    write_predictions(run_id, kind, [iid])
    start = time.time()
    try:
        s = score(run_id, workers=1, timeout=1800)
    except SystemExit as e:
        return {"error": str(e), "wall_s": round(time.time() - start)}
    rep = RESULTS_DIR / run_id / "multilang" / iid / "report.json"
    r = json.loads(rep.read_text()) if rep.exists() else {}
    f2p = (r.get("tests_status") or {}).get("FAIL_TO_PASS", {})
    p2p = (r.get("tests_status") or {}).get("PASS_TO_PASS", {})
    return {
        "resolved": bool(s["resolved"]), "error": r.get("error") or bool(s["error"]),
        "applied": bool(s["patch_applied"]), "timings_s": r.get("timings_s"),
        "wall_s": round(time.time() - start), "parsed_tests": r.get("parsed_tests"),
        "f2p_failed": f2p.get("failure", []), "p2p_failed": p2p.get("failure", [])[:50],
        "p2p_failed_n": len(p2p.get("failure", [])),
    }


def verdict(gold, noop):
    if gold.get("error") or not gold.get("resolved"):
        return "fail: gold not resolved"
    t = gold.get("timings_s") or {}
    if sum(t.values()) > GOLD_LIMIT_S:
        return f"fail: gold grade {sum(t.values()) // 60} min > {GOLD_LIMIT_S // 60}"
    if noop is None or noop.get("error") or not noop.get("applied") or noop.get("resolved"):
        return "fail: no-op not a clean unresolved"
    return "pass"


def main():
    ids = sys.argv[1:] or json.loads(POOL.read_text())
    data = load_dataset()
    done = json.loads(OUT.read_text()) if OUT.exists() else {}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    todo = sorted((i for i in ids if i not in done), key=lambda i: data[i]["repo"])
    for repo, group in groupby(todo, key=lambda i: data[i]["repo"]):
        group = list(group)
        ensure_docker()
        try:
            pull_images(group)
        except SystemExit as e:
            for iid in group:
                done[iid] = {"verdict": f"fail: {e}", "gold": None, "noop": None}
            OUT.write_text(json.dumps(done, indent=2) + "\n")
            continue
        for iid in group:
            print(f"{iid}: gold", flush=True)
            gold = grade(iid, "gold")
            t = gold.get("timings_s") or {}
            noop = None
            if gold.get("resolved") and sum(t.values()) <= GOLD_LIMIT_S:
                print(f"{iid}: no-op", flush=True)
                noop = grade(iid, "noop")
            v = verdict(gold, noop)
            done[iid] = {"verdict": v, "gold": gold, "noop": noop}
            OUT.write_text(json.dumps(done, indent=2) + "\n")
            print(f"{iid}: {v} (gold timings {t})", flush=True)
            ensure_docker()
        for image in {data[i]["image"] for i in group}:
            subprocess.run(["docker", "rmi", "-f", image], capture_output=True)
        subprocess.run(["docker", "image", "prune", "-f"], capture_output=True)
    passed = [i for i in ids if done.get(i, {}).get("verdict") == "pass"]
    print(f"SANITY DONE: {len(passed)}/{len(ids)} pass")


if __name__ == "__main__":
    main()
