# c2c-codex — Claude↔Codex Contract Bridge (MCP server)

*[中文](./README.zh-CN.md)*

Claude Code is the **architect/reviewer** (see `../CLAUDE.md`); Codex is the **implementer** (see `../AGENTS.md`). This MCP server is the courier between them: it turns Goal/Delta Contracts into Codex runs and returns the structured handoff for Claude to review. It is **language-agnostic** — all verification commands come from the contract's Success Conditions, never from this server.

## How it works

Each job spawns `codex app-server` (Codex's JSON-RPC interface, stdio/JSONL) and drives it:

```
initialize
→ thread/start            (or thread/resume for rework)
→ thread/goal/set         objective = the Goal Contract, distilled  ← this is /goal
→ turn/start              input = the full rendered contract
→ ... Codex's goal-continuation loop runs turns until the goal is achieved ...
→ job done when goal status is terminal (complete / budget_limited),
  or the thread goes quiet after a turn with the goal still active
```

Setting the thread goal is the programmatic equivalent of the `/goal` slash command in the Codex TUI: Codex audits its own work against the objective after each turn and keeps going ("Goal achieved" / "Goal unmet") until it passes or hits the token budget.

## Tools

| Tool | Purpose |
|---|---|
| `codex_implement` | Start a job from a Goal Contract (`goal`, `constraints[]`, `success_conditions[]`, optional `token_budget`, `cwd`). Returns `job_id` immediately. |
| `codex_status` | Poll a job: state, thread id, goal status/tokens, turn count, transcript tail. |
| `codex_result` | Fetch a finished job: final message + parsed handoff (Changed Files / Validation / Success Conditions / Risks & Deviations). A missing section ⇒ `handoff.valid: false` — per CLAUDE.md that is itself a review failure. |
| `codex_rework` | Resume the same Codex thread with a Delta Contract (`findings[]`, `failed_conditions[]`). The existing thread goal re-engages. |

## Configuration (env vars)

| Var | Default | Meaning |
|---|---|---|
| `CODEX_BIN` | `codex` | Codex executable |
| `CODEX_ARGS` | `app-server` | Args (space-separated) |
| `CODEX_CWD` | server cwd | Default working directory for jobs |
| `CODEX_MODEL` | (codex default) | Model override passed to `thread/start` |
| `CODEX_APPROVAL_POLICY` | `never` | Codex approval policy (autonomous worker) |
| `CODEX_PERMISSIONS` | (unset) | Codex permissions profile passthrough |
| `CODEX_JOB_TIMEOUT_MS` | `1800000` | Hard cap per job (30 min) |
| `CODEX_QUIET_MS` | `30000` | Quiet window after a turn before declaring a still-active goal finished |
| `GOAL_OBJECTIVE_MAX` | `2000` | Max length of the `thread/goal/set` objective string |

## Run / test

```sh
bun install
bun test          # e2e against test/mock-codex.ts (no real Codex needed)
bunx tsc --noEmit # typecheck
```

Registered for Claude Code in `../.mcp.json`. The server itself runs on Bun (Node ≥ 22.18 also works — the TS is erasable-syntax only).

## Status / caveats

- **Verified live** against `codex` 0.144.6 (2026-07-19): `test/live-smoke.ts` drove a real contract through the MCP server — `thread/goal/set` accepted, goal tracked `tokensUsed` and went `active → complete`, Codex self-verified the success condition, and the structured handoff parsed valid. Also covered by `bun test` against `test/mock-codex.ts` (no real Codex or model spend needed).
- Requires a reasonably current Codex CLI (`npm i -g @openai/codex@latest`). Note: a stale install can fail with an instant `zsh: killed` after a macOS update — reinstalling fixes it.
- If Codex's goals feature is unavailable in a build ("goals feature is disabled"), `thread/goal/set` failure degrades the job gracefully to single-turn mode and notes it in the transcript.
- Goals require a persisted thread; `thread/start` defaults are used (no ephemeral threads).
- Server→client requests (approvals) are declined automatically — jobs run with `approvalPolicy: never`; tune `CODEX_PERMISSIONS` if Codex needs broader sandbox rights.
