"""SWE-bench-Live/MultiLang adapter: import tasks and grade predictions.

    python multilang.py import jsonata-js__jsonata-814 [...]

MultiLang tasks carry their own build/test/print commands and a per-task Python
log parser (source code), so the SWE-bench harness cannot grade them. `import`
copies tasks into fresh/tasks.json with grader="multilang"; run.py `score`
dispatches such runs to `grade()` here, which mirrors the harness: fresh
container from the task image, apply the model patch, apply the test patch,
rebuild, test, print, parse, and require every FAIL_TO_PASS and PASS_TO_PASS
test to pass.

The images keep the upstream fix commit in their git object store and reflog,
so smoke.py squashes the agent's copy of /testbed (sanitize_git); grading runs
on the original image, which agents never see.
"""

import json
import re
import subprocess
import sys
import time
from pathlib import Path

DATASET = "SWE-bench-Live/MultiLang"
EVAL_DIR = Path(__file__).resolve().parent
TASKS = EVAL_DIR / "fresh" / "tasks.json"
CMD_TIMEOUT_S = 1800


def load_multilang(ids):
    from datasets import get_dataset_split_names, load_dataset

    found = {}
    for split in get_dataset_split_names(DATASET):
        for r in load_dataset(DATASET, split=split):
            if r["instance_id"] in ids:
                found[r["instance_id"]] = dict(r, language=split)
    missing = set(ids) - set(found)
    if missing:
        sys.exit(f"not in {DATASET}: {sorted(missing)}")
    return found


def as_json_list(v):
    return v if isinstance(v, str) else json.dumps(v)


def cmd_import(ids):
    tasks = json.loads(TASKS.read_text()) if TASKS.exists() else []
    for iid, r in load_multilang(set(ids)).items():
        record = {
            "instance_id": iid, "repo": r["repo"], "language": r["language"],
            "image": f"{r['docker_image']}:latest", "platform": "linux/amd64",
            "base_commit": r["base_commit"], "created_at": str(r["created_at"]),
            "difficulty": "fresh", "source": DATASET,
            "problem_statement": r["problem_statement"], "hints_text": "",
            "patch": r["patch"], "test_patch": r["test_patch"],
            "FAIL_TO_PASS": as_json_list(r["FAIL_TO_PASS"]),
            "PASS_TO_PASS": as_json_list(r["PASS_TO_PASS"]),
            "grader": "multilang",
            "rebuild_cmds": r["rebuild_cmds"], "test_cmds": r["test_cmds"], "print_cmds": r["print_cmds"],
            "log_parser_code": r["log_parser"],
            "env_activate": "true", "sanitize_git": True,
            "screening": None,
        }
        tasks = [t for t in tasks if t["instance_id"] != iid] + [record]
        print(f"imported {iid} ({r['language']}, created {record['created_at'][:10]})")
    TASKS.write_text(json.dumps(tasks, indent=2) + "\n")


# ---------- grading ----------

def docker(*args, input=None, timeout=None):
    return subprocess.run(["docker", *args], input=input, capture_output=True, text=True,
                          timeout=timeout or CMD_TIMEOUT_S)


def apply_patch(ctr, patch, name):
    """git apply, falling back to a fuzzy `patch` like the SWE-bench harness."""
    path = f"/tmp/{name}.diff"
    docker("exec", "-i", ctr, "bash", "-c", f"cat > {path}", input=patch)
    for cmd in (f"git apply -v {path}", f"patch --batch --fuzz=5 -p1 -i {path}"):
        r = docker("exec", "-w", "/testbed", ctr, "bash", "-c", cmd)
        if r.returncode == 0:
            return True, r.stdout + r.stderr
    return False, r.stdout + r.stderr


def run_cmds(ctr, cmds, log, timings=None, phase=""):
    out = []
    for cmd in cmds:
        start = time.time()
        r = docker("exec", "-w", "/testbed", ctr, "bash", "-c", cmd)
        took = round(time.time() - start)
        if timings is not None:
            timings[phase] = timings.get(phase, 0) + took
        log.write(f"$ {cmd}\n[exit {r.returncode}, {took}s]\n{r.stdout}{r.stderr}\n")
        out.append(r.stdout)
    return "".join(out)


# ---------- scoped grading ----------
# SWE-bench runs only the test files its test patch touches; MultiLang runs whole
# suites, which under amd64 emulation can take tens of minutes per grade. With
# grading_scope="touched" the test command is narrowed to the touched test files
# and PASS_TO_PASS to the tests that live in them. Supported runners below; any
# other command makes scoping fail loudly rather than silently run everything.

def touched_test_files(task):
    files = re.findall(r"(?m)^diff --git a/(\S+)", task["test_patch"])
    return [f for f in files if re.search(r"(\.test\.m?[jt]sx?|\.spec\.m?[jt]sx?|\.test)$", f)]


def scoped_test_cmds(task):
    files = touched_test_files(task)
    if not files:
        raise ValueError(f"{task['instance_id']}: no test files in the test patch to scope to")
    cmds = []
    for cmd in task["test_cmds"]:
        if "vitest run" in cmd:
            cmds.append(cmd.replace("vitest run", "vitest run " + " ".join(files), 1))
        elif "npx mocha" in cmd:
            cmds.append(cmd.replace("npx mocha", "npx mocha " + " ".join(files), 1).replace(" --recursive", ""))
        elif "make check" in cmd:
            names = " ".join(Path(f).name for f in files)
            cmds.append(re.sub(r"make check", f'make check TESTS="{names}"', cmd, count=1))
        else:
            raise ValueError(f"{task['instance_id']}: don't know how to scope {cmd!r}")
    return cmds


def scoped_p2p(task, p2p):
    files = touched_test_files(task)
    names = {Path(f).name for f in files}
    return [t for t in p2p if t.split("::")[0] in files or t in names]


def parse(task, output):
    scope = {}
    exec(task["log_parser_code"], scope)  # the dataset's own parser source
    return scope["parser"](output)


def grade_one(task, model_patch, run_id, out_dir):
    out_dir.mkdir(parents=True, exist_ok=True)
    ctr = f"c2c-grade-{run_id}-{task['instance_id']}".lower()
    docker("rm", "-f", ctr)
    plat = ["--platform", task["platform"]] if task.get("platform") else []
    docker("run", "-d", *plat, "--name", ctr, task["image"], "sleep", "infinity")
    report = {"instance_id": task["instance_id"], "patch_successfully_applied": False, "resolved": False}
    try:
        with (out_dir / "test_output.log").open("w") as log:
            if model_patch:
                ok, msg = apply_patch(ctr, model_patch, "model")
                log.write(f"## model patch\n{msg}\n")
                if not ok:
                    return report
            report["patch_successfully_applied"] = True
            # Like SWE-bench's eval scripts: the hidden test files win. Reset the
            # files the test patch touches (agents often add a same-named test).
            for f in re.findall(r"(?m)^diff --git a/(\S+)", task["test_patch"]):
                docker("exec", "-w", "/testbed", ctr, "bash", "-c",
                       f"git checkout -q HEAD -- '{f}' 2>/dev/null || rm -f '{f}'")
            ok, msg = apply_patch(ctr, task["test_patch"], "test")
            log.write(f"## test patch\n{msg}\n")
            if not ok:
                report["error"] = "test patch failed to apply"
                return report
            scoped = task.get("grading_scope") == "touched"
            timings = report["timings_s"] = {}
            run_cmds(ctr, task["rebuild_cmds"], log, timings, "rebuild")
            run_cmds(ctr, scoped_test_cmds(task) if scoped else task["test_cmds"], log, timings, "test")
            output = run_cmds(ctr, task["print_cmds"], log, timings, "print")
        statuses = parse(task, output)
        f2p, p2p = json.loads(task["FAIL_TO_PASS"]), json.loads(task["PASS_TO_PASS"])
        if scoped:
            p2p = scoped_p2p(task, p2p)
            report["grading_scope"] = {"test_files": touched_test_files(task), "pass_to_pass": len(p2p)}
        passed = lambda t: statuses.get(t) == "pass"
        report["tests_status"] = {
            "FAIL_TO_PASS": {"success": [t for t in f2p if passed(t)], "failure": [t for t in f2p if not passed(t)]},
            "PASS_TO_PASS": {"success": [t for t in p2p if passed(t)], "failure": [t for t in p2p if not passed(t)]},
        }
        report["parsed_tests"] = len(statuses)
        report["resolved"] = all(map(passed, f2p)) and all(map(passed, p2p))
        return report
    except subprocess.TimeoutExpired as e:
        report["error"] = f"timeout: {e.cmd}"
        return report
    finally:
        docker("rm", "-f", ctr)
        (out_dir / "report.json").write_text(json.dumps(report, indent=2) + "\n")


def grade(run_dir, run_id, tasks):
    """Grade results/<run_id>/predictions.jsonl; returns the same summary shape as run.score."""
    preds = [json.loads(l) for l in (run_dir / "predictions.jsonl").read_text().splitlines()]
    reports = []
    for p in preds:
        task = tasks[p["instance_id"]]
        patch = p["model_patch"] or ""
        if not patch.strip():
            reports.append({"instance_id": p["instance_id"], "empty_patch": True, "resolved": False})
            continue
        reports.append(grade_one(task, patch, run_id, run_dir / "multilang" / p["instance_id"]))
    ids = [p["instance_id"] for p in preds]
    errors = [r["instance_id"] for r in reports if r.get("error") or (not r.get("empty_patch") and "tests_status" not in r and r.get("patch_successfully_applied"))]
    return {
        "run_id": run_id, "model": preds[0]["model_name_or_path"], "submitted": len(ids),
        "resolved": [r["instance_id"] for r in reports if r["resolved"]],
        "unresolved": [r["instance_id"] for r in reports if not r["resolved"] and r["instance_id"] not in errors],
        "error": errors,
        "empty_patch": [r["instance_id"] for r in reports if r.get("empty_patch")],
        "patch_applied": [r["instance_id"] for r in reports if r.get("patch_successfully_applied")],
    }


if __name__ == "__main__":
    if len(sys.argv) < 3 or sys.argv[1] != "import":
        sys.exit(__doc__)
    cmd_import(sys.argv[2:])
