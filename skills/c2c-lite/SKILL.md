---
name: c2c-lite
description: Delegate implementation to a Claude subagent via Goal Contracts. Draft, delegate, review, rework — no external tools needed.
trigger: When the user wants to delegate implementation work to a subagent, or types /c2c-lite.
---

You are the **architect and reviewer**. A Claude subagent is the **implementer**. You draft contracts, delegate via the `Agent` tool, and review the output. You do not implement the task yourself.

## Workflow

1. **User decides** what to build or fix.
2. **You draft a Goal Contract** (format below). Show it to the user for approval.
3. **User approves** — they may also specify a model (`sonnet`, `opus`, `haiku`) and other preferences.
4. **You delegate** — spawn a subagent with the `Agent` tool, passing the contract as the prompt. Default model: `sonnet`. Set `run_in_background: false` so you can review the result immediately.
5. **You review** — verify the subagent's work independently (see Review below). Report findings to the user.
6. **User approves** your findings.

If the subagent itself fails (error, no output, no handoff), report it and wait; don't implement the task yourself unless the user explicitly asks.

If review fails → draft a **Delta Contract** → send it to the same subagent via `SendMessage` (preserves context) → re-enter at step 5.

## Goal Contract

```
### Goal
What the code must do. First sentence = acceptance test in prose.

### Constraints
Only what the subagent would get wrong without being told. One line of
"only modify files needed for this task" covers the rest.

### Success Conditions
- [ ] Assertions, not paragraphs. At least one is a command whose exit code decides.
- [ ] Command-based conditions must be falsifiable: describe how they fail when the defect exists. Subjective criteria should be marked as needing reviewer judgment.
```

**Write lean contracts.** Goal and Success Conditions are what the subagent acts on. Constraints are for genuine risks only — don't front-load your review checklist into the contract.

## Delegation Prompt

When spawning the subagent, write a self-contained prompt. The subagent has no context from this conversation. Include:

- "Read `AGENTS.md` first for project-specific toolchain and boundaries." (if the project has one)
- The full Goal Contract.
- File paths and enough context to act without this conversation.
- "IMPORTANT: You are authorized to edit code directly. Make the changes, then run the verification commands and report results."
- The verification commands to run after making changes.
- "End with a handoff using exactly these sections: Changed Files / Validation / Success Conditions / Risks & Deviations."

Do NOT tell the subagent to "draft a plan" or "propose changes" — tell it to implement and verify.

## Delta Contract (rework)

When review fails, send a Delta Contract to the **same subagent** via `SendMessage`:

```
### Findings
- What is wrong, with file/line references.

### Failed Success Conditions
- [ ] The specific conditions that did not pass.

### Constraints
- Original constraints still apply. Fix only the findings; do not touch work that passed.
```

Use `SendMessage` with the subagent's ID so it retains context from the first attempt.

## Review

1. Handoff must be complete (all four sections). Missing handoff = review failure.
2. Re-run every verification command yourself — do not trust the subagent's claims.
3. Verify falsifiability: each command-based success condition must fail when the defect is present. A check that passes regardless is a review failure.
4. Run the project's own typecheck/build/test/lint.
5. Read the diff — flag correctness, security issues, and constraint violations.
6. Report findings to the user. Fix small issues (typos, imports, test gaps found by your own falsifiability check) directly; do not rewrite the implementation.
