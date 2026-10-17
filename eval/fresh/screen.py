"""Record the screening decision for a fresh task (the SWE-bench Verified step).

A task's hidden FAIL_TO_PASS tests must be implied by its issue text; a test that
pins behaviour the issue never asks for makes the task unsolvable from its
statement. The reviewer reads each FAIL_TO_PASS test against the issue and
either keeps the task with only the implied tests, or drops it.

    python fresh/screen.py show sympy__sympy-30596
    python fresh/screen.py keep sympy__sympy-30596 --tests <test>... \
        --drop "<test>=<reason>" ... --reviewer <who>
    python fresh/screen.py drop sympy__sympy-30596 --reason "..." --reviewer <who>

The unscreened list stays in FAIL_TO_PASS_measured; FAIL_TO_PASS becomes the kept
tests. Rebuilding a task with build_task.py resets its screening.
"""

import argparse
import datetime
import json
import re
import sys
from pathlib import Path

FRESH = Path(__file__).resolve().parent
TASKS = FRESH / "tasks.json"


def load():
    return json.loads(TASKS.read_text())


def find(tasks, iid):
    for t in tasks:
        if t["instance_id"] == iid:
            return t
    sys.exit(f"unknown instance {iid}")


def measured_f2p(task):
    return json.loads(task.get("FAIL_TO_PASS_measured") or task["FAIL_TO_PASS"])


def test_sources(task, names):
    """Each test function's added source, from the test patch."""
    out = {}
    for name in names:
        func = name.split("::")[-1]
        m = re.search(rf"(?m)^\+def {re.escape(func)}\(.*?(?=^[+ ]def |^[+ ]class |^diff --git |^@@ |\Z)",
                      task["test_patch"], re.S)
        out[name] = m.group(0) if m else "(not added by the test patch)"
    return out


def cmd_show(args):
    task = find(load(), args.instance)
    print(f"# {task['instance_id']}  ({task['repo']})\n\n## Issue\n{task['problem_statement']}")
    print("## FAIL_TO_PASS tests (measured)")
    for name, src in test_sources(task, measured_f2p(task)).items():
        print(f"\n### {name}\n{src}")
    print(f"\n## Current screening\n{json.dumps(task.get('screening'), indent=2)}")


def record(task, decision, kept, dropped, reviewer, note):
    task["FAIL_TO_PASS_measured"] = json.dumps(measured_f2p(task))
    task["FAIL_TO_PASS"] = json.dumps(kept)
    task["screening"] = {
        "decision": decision, "kept": kept, "dropped": dropped,
        "reviewer": reviewer, "note": note,
        "date": datetime.date.today().isoformat(),
    }


def cmd_keep(args):
    tasks = load()
    task = find(tasks, args.instance)
    measured = measured_f2p(task)
    dropped = dict(d.split("=", 1) for d in args.drop)
    unknown = (set(args.tests) | set(dropped)) - set(measured)
    if unknown:
        sys.exit(f"not in measured FAIL_TO_PASS: {sorted(unknown)}")
    undecided = set(measured) - set(args.tests) - set(dropped)
    if undecided:
        sys.exit(f"every measured test needs a keep or drop decision; undecided: {sorted(undecided)}")
    if not args.tests:
        sys.exit("keeping a task needs at least one test; use `drop` instead")
    record(task, "keep", sorted(args.tests), dropped, args.reviewer, args.note)
    TASKS.write_text(json.dumps(tasks, indent=2) + "\n")
    print(f"{args.instance}: keep, FAIL_TO_PASS {len(measured)} -> {len(args.tests)}")


def cmd_drop(args):
    tasks = load()
    task = find(tasks, args.instance)
    record(task, "drop", [], {"*": args.reason}, args.reviewer, args.note)
    TASKS.write_text(json.dumps(tasks, indent=2) + "\n")
    print(f"{args.instance}: dropped")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("show")
    s.add_argument("instance")
    s.set_defaults(fn=cmd_show)
    s = sub.add_parser("keep")
    s.add_argument("instance")
    s.add_argument("--tests", nargs="+", default=[])
    s.add_argument("--drop", nargs="*", default=[], metavar="TEST=REASON")
    s.add_argument("--reviewer", required=True)
    s.add_argument("--note", default="")
    s.set_defaults(fn=cmd_keep)
    s = sub.add_parser("drop")
    s.add_argument("instance")
    s.add_argument("--reason", required=True)
    s.add_argument("--reviewer", required=True)
    s.add_argument("--note", default="")
    s.set_defaults(fn=cmd_drop)
    args = p.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
