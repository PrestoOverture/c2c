#!/bin/bash
# Overnight chain for the round-2 A vs C run (2026-10-21). Each step waits for the cloud
# run it depends on, so only one arm-C run is ever active (one shared Codex login).
#   1. sanity rerun (4 tasks) -> fetch; dispatch A for the ones that pass
#   2. C run over the first 32 tasks -> then dispatch C for the 9 vm-tier passes + step-1 passes
#   3. wait for every agent run, then download all graded runs
set -u
cd "$(dirname "$0")/.."
R=PrestoOverture/c2c-eval-runner
S=/private/tmp/claude-501/-Users-kwang-projects-c2c/3c6e4b96-93b5-41b8-a520-8129f20f0bc6/scratchpad
SANITY_RERUN=39473204956
C_FIRST=39472577500

wait_run() { until [ "$(gh run view "$1" -R $R --json status -q .status 2>/dev/null)" = "completed" ]; do sleep 120; done; }
log() { echo "[$(date '+%m-%d %H:%M')] $*"; }

wait_run $SANITY_RERUN
python3 cloud.py fetch $SANITY_RERUN >/dev/null
python3 - > "$S/rerun_pass.txt" <<'PY'
import json
d = json.load(open("results/sanity-r2-cloud.json"))
for i in ["yvgude__lean-ctx-969", "yvgude__lean-ctx-1179", "root-project__root-22854", "root-project__root-22857"]:
    if d[i]["verdict"] == "pass":
        print(i)
PY
log "sanity rerun passes: $(tr '\n' ' ' < "$S/rerun_pass.txt")"
if [ -s "$S/rerun_pass.txt" ]; then
    xargs python3 cloud.py agent A r2 --parallel 2 < "$S/rerun_pass.txt"
fi

wait_run $C_FIRST
log "first C run done"
cat "$S/vm_ids.txt" "$S/rerun_pass.txt" | xargs python3 cloud.py agent C r2 --parallel 1
sleep 30

for id in $(gh run list -R $R -w agent.yml -L 30 --json databaseId,status -q '.[]|select(.status!="completed")|.databaseId'); do
    wait_run "$id"
done
log "all agent runs done; downloading"
for id in $(gh run list -R $R -w agent.yml -L 30 --json databaseId,createdAt -q '.[]|select(.createdAt > "2026-10-20T16:30:00Z")|.databaseId'); do
    python3 cloud.py runs "$id" | grep -E '^r2-' || true
done
log "OVERNIGHT DONE"
