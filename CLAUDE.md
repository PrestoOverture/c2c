# Claude Code Guidelines

The contract workflow (role, Goal/Delta formats, review protocol) is delivered by the MCP Prompt `c2c-workflow`. This file carries only what is specific to this repository.

## Session Startup Routine

At the beginning of every session, you **must**:
1. Read `docs/prd.md`, `docs/architecture.md`, `docs/roadmap.md`, `docs/tech_stack.md`, `docs/progress.md`.
2. Orient the user: what was completed last, what the current phase is, what steps remain.

At the end of each phase or session, update these files to reflect current state.

## Review Additions (beyond the MCP Prompt)

- Flag security issues (OWASP top 10, path traversal, command injection).
- Run the phase's **Real Test** from `docs/roadmap.md` — Tier A/B mechanics yourself (one-shot CLI, PTY-driven TUI); ask the user to judge subjective pass bars. Record the outcome in `docs/progress.md`. A failed Real Test is a review failure.

## Constraints
- Ignore `AGENTS.md`; it is for Codex.
