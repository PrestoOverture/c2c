#!/bin/bash
# Waits for sanity_r2.py to finish, writes the probe task list from its passes,
# then runs the first probe batch (Sonnet solo, arm S, 1 attempt per task).
cd "$(dirname "$0")/.."
while pgrep -f sanity_r2.py >/dev/null; do sleep 60; done
python3 - <<'PY'
import json
done = json.load(open("results/sanity-r2.json"))
ids = [i for i, r in sorted(done.items()) if r["verdict"] == "pass"]
open("round2/probe.txt", "w").write("# round-2 difficulty probe: screened in + sanity pass\n" + "\n".join(ids) + "\n")
print(f"probe list: {len(ids)} tasks")
PY
C2C_EVAL_DATASET=fresh/tasks.json PYTHONUNBUFFERED=1 .venv/bin/python pilot.py \
    --tasks round2/probe.txt --arms S --repeats 1 --prefix probe --rmi --limit 15
