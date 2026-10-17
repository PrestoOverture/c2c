"""Build one fresh (post-cutoff) SWE-bench-style task from a merged GitHub PR.

    python fresh/build_task.py --repo sympy/sympy --pr 30596 --issue 30584

Produces fresh/<instance_id>/{testbed,Dockerfile}, the image c2c-eval/<instance_id>,
and upserts the task into fresh/tasks.json, which run.py and smoke.py read with
--dataset fresh/tasks.json.

Leak control: /testbed is a single-commit repo made from `git archive <base>`, so
the fix is not reachable from git history inside the image or the agent's copy.
FAIL_TO_PASS / PASS_TO_PASS are measured, not copied: the test files are run at
base (+ test patch) and at base + gold (+ test patch) in the image.

Only the sympy profile exists so far; add a profile per repo as needed.
"""

import argparse
import io
import json
import re
import subprocess
import sys
import tarfile
from pathlib import Path

FRESH = Path(__file__).resolve().parent
SRC = FRESH / "src"
TASKS = FRESH / "tasks.json"

PROFILES = {
    "sympy/sympy": {
        "python": "3.12",
        "pip": ["mpmath", "pytest", "hypothesis"],
        # sympy's bin/test is a pytest wrapper now, so the old parse_log_sympy
        # format no longer appears; use plain pytest with the -rA summary.
        "test_cmd": "PYTHONWARNINGS='ignore::UserWarning,ignore::SyntaxWarning' python -m pytest -rA -p no:cacheprovider",
        "log_parser": "parse_log_pytest",
    },
}

SKIP = {".mailmap", "AUTHORS"}  # bookkeeping files a contributor's PR touches; not part of the fix


def sh(*cmd, cwd=None, input=None):
    return subprocess.run(cmd, cwd=cwd, input=input, check=True, capture_output=True, text=True).stdout


def gh_json(*args):
    return json.loads(sh("gh", *args))


def split_diff(diff):
    """Split a unified diff into (source patch, test patch) by file path."""
    chunks = re.split(r"(?m)^(?=diff --git )", diff)
    src, tst = [], []
    for c in chunks:
        if not c.strip():
            continue
        path = re.match(r"diff --git a/(\S+)", c).group(1)
        if path in SKIP:
            continue
        (tst if re.search(r"(^|/)tests?/|(^|/)test_[^/]*\.py$", path) else src).append(c)
    return "".join(src), "".join(tst)


def make_testbed(clone, base, dest):
    """Squash the tree at `base` into a fresh single-commit repo."""
    if dest.exists():
        sh("rm", "-rf", str(dest))
    dest.mkdir(parents=True)
    tar_bytes = subprocess.run(["git", "-C", str(clone), "archive", base], check=True, capture_output=True).stdout
    with tarfile.open(fileobj=io.BytesIO(tar_bytes)) as t:
        t.extractall(dest, filter="data")
    sh("git", "init", "-q", cwd=dest)
    sh("git", "add", "-A", cwd=dest)
    sh("git", "-c", "user.name=c2c-eval", "-c", "user.email=eval@c2c.invalid",
       "commit", "-q", "-m", "base", cwd=dest)
    return sh("git", "rev-parse", "HEAD", cwd=dest).strip()


def build_image(task_dir, image, prof):
    (task_dir / "Dockerfile").write_text(
        f"FROM python:{prof['python']}-slim\n"
        "RUN apt-get update && apt-get install -y --no-install-recommends git patch \\\n"
        "    && rm -rf /var/lib/apt/lists/*\n"
        f"RUN pip install --no-cache-dir {' '.join(prof['pip'])}\n"
        "COPY testbed /testbed\n"
        "WORKDIR /testbed\n"
        "RUN git config --global --add safe.directory /testbed && pip install --no-cache-dir -e .\n"
    )
    # Native architecture: these images are ours, and emulated amd64 made one
    # test_solveset pass take 17 min on Apple Silicon.
    subprocess.run(["docker", "build", "-t", image, str(task_dir)], check=True)


def run_tests(image, base_commit, test_files, test_patch, gold, prof):
    """Statuses of the test files' tests, with test_patch (and optionally gold) applied."""
    from swebench.harness.log_parsers import python as parsers

    script = "set -u\ncd /testbed\n"
    if gold:
        script += "git apply -v - <<'EOF_GOLD'\n" + gold + "EOF_GOLD\n"
    script += "git apply -v - <<'EOF_TEST'\n" + test_patch + "EOF_TEST\n"
    script += f"{prof['test_cmd']} {' '.join(test_files)}\n"
    out = subprocess.run(["docker", "run", "--rm", "-i", image, "bash", "-s"],
                         input=script, capture_output=True, text=True).stdout
    return getattr(parsers, prof["log_parser"])(out, None), out


def eval_script(base_commit, test_files, test_patch, prof):
    files = " ".join(test_files)
    return "\n".join([
        "#!/bin/bash",
        "set -uxo pipefail",
        "cd /testbed",
        "git config --global --add safe.directory /testbed",
        "git status",
        f"git -c core.fileMode=false diff {base_commit}",
        f"git checkout {base_commit} {files}",
        "git apply -v - <<'EOF_114329324912'",
        test_patch.rstrip("\n"),
        "EOF_114329324912",
        ": '>>>>> Start Test Output'",
        f"{prof['test_cmd']} {files}",
        ": '>>>>> End Test Output'",
        f"git checkout {base_commit} {files}",
    ]) + "\n"


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--repo", required=True)
    p.add_argument("--pr", type=int, required=True)
    p.add_argument("--issue", type=int, required=True)
    args = p.parse_args()
    prof = PROFILES[args.repo]
    owner, name = args.repo.split("/")
    instance_id = f"{owner}__{name}-{args.pr}"
    task_dir = FRESH / instance_id
    image = f"c2c-eval/{instance_id.lower()}:latest"

    pr = gh_json("api", f"repos/{args.repo}/pulls/{args.pr}")
    merge = pr["merge_commit_sha"]
    base = gh_json("api", f"repos/{args.repo}/commits/{merge}")["parents"][0]["sha"]
    issue = gh_json("api", f"repos/{args.repo}/issues/{args.issue}")

    clone = SRC / name
    if not clone.exists():
        sh("git", "clone", "-q", "--filter=blob:none", f"https://github.com/{args.repo}.git", str(clone))
    sh("git", "-C", str(clone), "fetch", "-q", "origin", merge)
    gold, test_patch = split_diff(sh("git", "-C", str(clone), "diff", base, merge))
    test_files = sorted(set(re.findall(r"(?m)^diff --git a/(\S+)", test_patch)))
    if not gold or not test_patch:
        sys.exit("PR has no source change or no test change")

    squashed = make_testbed(clone, base, task_dir / "testbed")
    build_image(task_dir, image, prof)

    before, log_b = run_tests(image, squashed, test_files, test_patch, None, prof)
    after, log_a = run_tests(image, squashed, test_files, test_patch, gold, prof)
    (task_dir / "tests_before.log").write_text(log_b)
    (task_dir / "tests_after.log").write_text(log_a)
    f2p = sorted(t for t, s in after.items() if s == "PASSED" and before.get(t) != "PASSED")
    p2p = sorted(t for t, s in after.items() if s == "PASSED" and before.get(t) == "PASSED")
    broken = sorted(t for t, s in after.items() if s != "PASSED")
    if not f2p:
        sys.exit(f"no FAIL_TO_PASS tests; see {task_dir}/tests_*.log")

    record = {
        "instance_id": instance_id, "repo": args.repo, "image": image,
        "base_commit": squashed, "upstream_base_commit": base, "upstream_merge_commit": merge,
        "created_at": issue["created_at"], "merged_at": pr["merged_at"], "difficulty": "fresh",
        "problem_statement": f"{issue['title']}\n\n{issue['body'] or ''}\n",
        "hints_text": "", "patch": gold, "test_patch": test_patch,
        "FAIL_TO_PASS": json.dumps(f2p), "PASS_TO_PASS": json.dumps(p2p),
        "version": "fresh", "environment_setup_commit": squashed,
        "log_parser": prof["log_parser"], "eval_type": "pass_and_fail",
        "eval_script": eval_script(squashed, test_files, test_patch, prof),
        "env_activate": "true",  # plain python image: no conda env to activate
        "platform": None,  # native build, unlike the amd64-only SWE-bench images
        "screening": None,  # set by fresh/screen.py; smoke.py refuses unscreened tasks
    }
    tasks = json.loads(TASKS.read_text()) if TASKS.exists() else []
    tasks = [t for t in tasks if t["instance_id"] != instance_id] + [record]
    TASKS.write_text(json.dumps(tasks, indent=2) + "\n")
    print(f"{instance_id}: next, screen it: python fresh/screen.py show {instance_id}")
    print(f"{instance_id}: F2P {len(f2p)}, P2P {len(p2p)}, failing after gold {len(broken)} {broken[:5]}")


if __name__ == "__main__":
    main()
