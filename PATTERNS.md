# Contract Patterns

Field notes on writing Goal Contracts that get implemented correctly on the first try.

Everything here was distilled from a real build: seven Goal Contracts delivered through this bridge in two days (the Phase 2–4 features of this very repository — persistence, retry, concurrency, dependencies, the stall watchdog, cost estimation). All seven passed review without a single Delta Contract. These are the patterns that made that happen.

*[中文版](./PATTERNS.zh-CN.md)*

## Anatomy of a contract that works

A real contract from this repo (Task 3.3, job dependency chaining), annotated:

```markdown
### Goal
codex_implement must support declaring a dependency on a previous job: the
dependent job starts automatically after the dependency succeeds, and fails
fast with a clear reason if the dependency fails.

1. Schema: codex_implement gains an optional `depends_on: string` parameter...
2. Submit-time validation: unknown job -> isError, no job created; ...
3. Blocking semantics: ... blocked jobs do NOT consume concurrency slots ...
4. Timing & events: the timeout clock starts when the job actually starts ...
5. Persistence: ... on restart load, "blocked" jobs are marked interrupted ...
```

What makes this work:

- **The first sentence is the acceptance test in prose.** Not "improve job orchestration" (a wish) but "starts automatically after the dependency succeeds, fails fast if it fails" (a behavior you can check).
- **Numbered specifics resolve every judgment call up front.** Does a blocked job consume a concurrency slot? When does the timeout clock start? What happens on restart? Each of these is a decision the implementer would otherwise make silently — and a coin-flip you'd catch (or miss) in review.
- **Edge semantics are stated, not implied.** "Unknown job → isError, *no job created*" pins both the error and the side-effect boundary.

The goal is not to write more words. It is to leave **zero open design decisions** that you would reject in review. If you would flag it in review, decide it in the contract.

## Constraints: fence the blast radius

```markdown
- Only modify mcp/src/jobs.ts, mcp/src/server.ts, plus new test files under mcp/test/.
- Do not modify: contracts.ts, codex-client.ts, log.ts, store.ts, config.ts, docs/, README*.
- No new runtime dependencies. Tool schemas may only be extended additively.
- Persisted format must stay backward compatible: old files without the new field must load.
- The existing N tests keep passing; only minimal adjustments are allowed.
```

Patterns that earn their place:

- **An explicit allow-list and an explicit deny-list.** The allow-list scopes the diff you will have to review. The deny-list protects load-bearing files. Review then starts with a 5-second `git status` check against both.
- **"Additively extendable" for any public surface** (schemas, persisted formats, APIs). This one line prevents silent breaking changes.
- **Name the exact current test count** ("the existing 29 tests keep passing"). It makes "don't break what works" checkable, and drift in the number is itself a review signal.
- **Expect principled violations.** In this repo's run, Codex once modified two existing mock files that were technically outside the allow-list — because a new default (retries on) had changed what the old mocks meant. That was the *correct* engineering call. Judge boundary crossings by whether the contract's success conditions forced them; a good handoff will volunteer the reason.

## Success Conditions: make the machine do the judging

The single most important rule: **at least one condition is a command whose exit code decides.** Everything else builds on that.

Verification tricks that proved decisive, all lifted from this repo's test suites:

| To prove... | Do this |
|---|---|
| "No job/record was created on rejection" | Count files in the state directory before and after; assert equality. |
| "The prompt actually delivered contains X" | Make the mock *reject the request* when X is absent (`EXPECT_*` env vars). Success of the job then *is* the proof. |
| "No process was ever spawned" | Assert on two independent channels: no spawn event in the structured log *and* no attempt/thread entries in the transcript. |
| "File contents are never inlined into the prompt" | Write a marker string into the file; assert the prompt does not contain it. |
| "B starts only after A finishes" | Assert event *ordering* in the progress stream, not just final states. |
| "Timeout counts from dequeue, not enqueue" | Set total elapsed > timeout with queueing; completion itself proves the clock's start point. |
| "The timing-sensitive test isn't flaky" | Run it under `bun test --rerun-each 3` (or equivalent) before accepting it. |

And the meta-rule for the handoff: **require it in the contract.** Every contract here ends with:

```markdown
- [ ] The final handoff lists: Changed Files, Validation (commands + output),
      each Success Condition with its verification result, and Risks & Deviations.
```

A missing or incomplete handoff is itself a review failure — you never have to argue about it, because it was a success condition.

## Review: never trust, always re-run

The handoff says `bun test` passed. Run `bun test` anyway. In this repo's run every handoff happened to be truthful — and that is exactly what you can't assume, because the day one isn't, the re-run is your only defense. The review loop that worked:

1. `git status` against the allow/deny lists (5 seconds).
2. Read the diff — for design, not just correctness. (Two of the best findings here were *positive*: a fairness fix and a stall-boundary refinement the contract never asked for.)
3. Re-run every verification command yourself, from a clean shell.
4. Check the handoff's Risks & Deviations against what the diff actually shows. "None" plus an undeclared deviation is a worse sign than a declared one. A handoff that says "P90 uses the nearest-rank method" unprompted is a good sign.

## Delta Contracts: scope to the failure

When review fails, do not renegotiate the task. Send back only:

```markdown
### Findings
- store.ts:41 — interrupted jobs keep their stale endedAt; restart test fails.

### Failed Success Conditions
- [ ] Persistence round-trip test passes.

### Constraints
- Original constraints still apply. Fix only the findings above; do not touch work that passed.
```

The thread (and its goal) resumes — Codex retains full context of its own implementation, so the fix is surgical. This repo's run needed zero Delta Contracts across seven tasks; the honest attribution is contract precision up front, which is cheaper than any rework loop.

## Calibration numbers (one local data point)

From the seven implement jobs that built Phases 2–4 (TypeScript, ~40–440 line diffs each, `reasoning_effort: high`):

- **Tokens per job:** 51k–128k (median ≈ 87k). `codex_estimate` now surfaces your own local numbers — prefer those.
- **Wall time per job:** 5–15 minutes when healthy; two jobs stalled mid-turn for 10–16 minutes (upstream CLI issue) and self-recovered.
- **Timeout:** the 30-minute default absorbed both stalls. If you tighten it, watch `seconds_since_activity` (stall watchdog) before concluding a job is dead — reasoning pauses and stalls look identical from outside.
- **Effort:** `high` produced above-contract judgment calls (fairness fixes, boundary refinements) that default effort had not. For contracts whose edge semantics matter, it paid for itself.

## Anti-patterns

- **The vision goal.** "Make the server production-ready." Codex will decide what that means; you will disagree in review.
- **The unverifiable condition.** "Code is clean and well-tested." If a machine can't decide it, it's a review note, not a success condition.
- **The unfenced diff.** No file allow-list → the diff sprawls → review cost explodes → subtle regressions hide in noise.
- **The implicit edge.** Every "what happens if X" you leave open is decided by the implementer, silently, against your review checklist.
- **The trusted handoff.** Accepting "all tests pass" without re-running is not review; it's hope with extra steps.
- **The mega-contract.** One contract per reviewable increment. Seven small contracts with clean handoffs beat one heroic contract every time — and the rework loop stays surgical when something does fail.
