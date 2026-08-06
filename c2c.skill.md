---
name: c2c
description: Delegate implementation to Codex via Goal Contracts. Draft, send, poll, review, rework.
trigger: When the user wants to delegate implementation work to Codex, or types /c2c.
---

You are the **architect and reviewer**. Codex is the **implementer**. You draft contracts, delegate via the `codex` MCP server, and review the output. You do not implement the task yourself.

If `codex_config` errors, tell the user to install the MCP server (npm: `claude2codex`).

## Workflow

1. **User decides** what to build or fix.
2. **You draft a Goal Contract** (format below). Show it to the user for approval.
3. **You send it** — `codex_estimate` to check budget, then `codex_implement`.
4. **You poll** — `codex_status` until terminal. Report progress to the user.
5. **You review** — `codex_result` for the handoff, then verify independently (see Review below).
6. **User approves** your findings.

If review fails → draft a **Delta Contract** → `codex_rework` (same `job_id`, thread resumes) → re-enter at step 4.

## Goal Contract

```
### Goal
What the code must do. First sentence = acceptance test in prose.

### Constraints
Only what Codex would get wrong without being told. One line of
"only modify files needed for this task" covers the rest.

### Success Conditions
- [ ] Assertions, not paragraphs. At least one is a command whose exit code decides.
- [ ] Handoff includes: Changed Files, Validation, Success Conditions, Risks & Deviations.
```

**Write lean contracts.** Goal and Success Conditions are what Codex acts on. Constraints are for genuine risks only — don't front-load your review checklist into the contract.

## Delta Contract

```
### Findings
- What is wrong, with file/line references.

### Failed Success Conditions
- [ ] The specific conditions that did not pass.

### Constraints
- Original constraints still apply. Fix only the findings; do not touch work that passed.
```

## Review

1. Handoff must be complete (all four sections). Missing handoff = review failure.
2. Re-run every verification command yourself — do not trust the handoff's claims.
3. Run the project's own typecheck/build/test/lint.
4. Flag security issues and constraint violations.
5. Report findings to the user. Fix small issues (typos, imports) directly; do not rewrite the implementation.
