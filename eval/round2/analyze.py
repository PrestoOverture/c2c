"""Round-2 A vs C analysis, as pre-registered in docs/eval.md ("Amendment ... no difficulty filter").

    python round2/analyze.py            # from eval/

Unit: the task. Resolved = both grades pass. Primary: one-sided exact sign test on
discordant tasks (C > A at p < 0.025); also two-sided p and the resolved-rate
difference with a paired bootstrap 95% CI. Descriptive split by the Sonnet probe.
"""

import glob
import json
import random
import sys
from math import comb
from pathlib import Path

EVAL = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(EVAL))
import audit  # noqa: E402

RESULTS = EVAL / "results"


def runs(arm):
    out = {}
    for f in glob.glob(str(RESULTS / f"r2-*-{arm}-r1" / "run.json")):
        r = json.loads(Path(f).read_text())
        r["audit"] = audit.audit_run(Path(f).parent)  # current audit rules for every run
        out[r["instance_id"]] = r
    return out


def probe():
    out = {}
    for f in glob.glob(str(RESULTS / "probe-*-S-r1" / "run.json")):
        r = json.loads(Path(f).read_text())
        out[r["instance_id"]] = bool(r["resolved"])
    return out


def sign_p(k, n):
    """P(X >= k) for X ~ Bin(n, 1/2)."""
    return sum(comb(n, i) for i in range(k, n + 1)) / 2 ** n if n else 1.0


def bootstrap_ci(diffs, reps=20000, seed=20261021):
    rng = random.Random(seed)
    n = len(diffs)
    means = sorted(sum(rng.choice(diffs) for _ in range(n)) / n for _ in range(reps))
    return means[int(0.025 * reps)], means[int(0.975 * reps) - 1]


def main():
    A, C, P = runs("A"), runs("C"), probe()
    tasks = sorted(set(A) & set(C))
    missing = sorted(set(A) ^ set(C))
    a = [bool(A[t]["resolved"]) for t in tasks]
    c = [bool(C[t]["resolved"]) for t in tasks]
    c_only = [t for t, x, y in zip(tasks, a, c) if y and not x]
    a_only = [t for t, x, y in zip(tasks, a, c) if x and not y]
    n_disc = len(c_only) + len(a_only)
    p_one = sign_p(len(c_only), n_disc)
    p_two = min(1.0, 2 * min(sign_p(len(c_only), n_disc), sign_p(len(a_only), n_disc))) if n_disc else 1.0
    diffs = [int(y) - int(x) for x, y in zip(a, c)]
    lo, hi = bootstrap_ci(diffs)

    print(f"paired tasks: {len(tasks)}" + (f"  (unpaired, excluded: {missing})" if missing else ""))
    print(f"A resolved {sum(a)}/{len(tasks)} ({sum(a)/len(tasks):.0%})   C resolved {sum(c)}/{len(tasks)} ({sum(c)/len(tasks):.0%})")
    print(f"discordant: C only {len(c_only)}, A only {len(a_only)}")
    print(f"  C only: {c_only}\n  A only: {a_only}")
    print(f"sign test C > A one-sided p = {p_one:.4f}  -> {'SUPPORTED' if p_one < 0.025 else 'not supported'} at 0.025")
    print(f"two-sided p = {p_two:.4f}; resolved-rate difference C - A = {sum(diffs)/len(tasks):+.3f}, 95% CI [{lo:+.3f}, {hi:+.3f}]")

    for label, keep in (("Sonnet probe failed (hard)", False), ("Sonnet probe solved (easy)", True)):
        sub = [i for i, t in enumerate(tasks) if t in P and P[t] == keep]
        if sub:
            print(f"{label}: n={len(sub)}  A {sum(a[i] for i in sub)}  C {sum(c[i] for i in sub)}  "
                  f"C only {sum(c[i] and not a[i] for i in sub)}  A only {sum(a[i] and not c[i] for i in sub)}")
    no_probe = [t for t in tasks if t not in P]
    if no_probe:
        print(f"no probe run (vm tier): n={len(no_probe)}  A {sum(bool(A[t]['resolved']) for t in no_probe)}  "
              f"C {sum(bool(C[t]['resolved']) for t in no_probe)}")

    for arm, R in (("A", A), ("C", C)):
        ts = [R[t] for t in tasks]
        mins = sorted(r["duration_s"] / 60 for r in ts)
        cl = [r["claude_delta"]["five_hour"] for r in ts if r.get("claude_delta") and r["claude_delta"].get("five_hour") is not None]
        cx = [r["codex_delta"]["five_hour"] for r in ts if r.get("codex_delta") and r["codex_delta"].get("five_hour") is not None]
        dirty = [t for t in tasks if not R[t]["audit"]["clean"]]
        print(f"{arm}: median {mins[len(mins)//2]:.1f} min, mean {sum(mins)/len(mins):.1f} min; "
              f"Claude 5h/run mean {sum(cl)/max(len(cl),1):.3f} (n={len(cl)}); "
              f"Codex 5h/run mean {sum(cx)/max(len(cx),1):.3f} (n={len(cx)}); audit findings: {dirty}")

    out = {"tasks": tasks, "A": dict(zip(tasks, a)), "C": dict(zip(tasks, c)), "c_only": c_only, "a_only": a_only,
           "p_one_sided": p_one, "p_two_sided": p_two, "diff": sum(diffs) / len(tasks), "ci95": [lo, hi]}
    (RESULTS / "r2-analysis.json").write_text(json.dumps(out, indent=2) + "\n")


if __name__ == "__main__":
    main()
