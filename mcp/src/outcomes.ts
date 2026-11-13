// Worker-agnostic, append-only summaries. Deliberately whitelist fields so raw
// prompts, transcripts and command output never enter the long-lived log.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Evidence } from "./evidence.ts";
import type { MergeResult } from "./merge.ts";
import type { Isolation, TargetSync } from "./isolation.ts";
import { defaultStateDir, warnOnce } from "./store.ts";

interface OutcomeJob {
  id: string;
  kind: "implement" | "rework";
  parentJobId?: string | null;
  rootJobId?: string | null;
  reworkRound?: number;
  threadId?: string;
  state: string;
  error?: string;
  turns: number;
  attempts?: number;
  usage?: Record<string, number>;
  startedAt: string;
  endedAt?: string;
  handoff?: { valid: boolean };
  evidence?: Evidence | null;
  isolation?: Isolation;
  sync?: TargetSync;
}

export function summarizeOutcome(job: OutcomeJob) {
  const source = job.evidence;
  const failed = (c: { exit_code: number | null; timed_out: boolean }) => c.exit_code !== 0 || c.timed_out;
  const evidence = source ? {
    passed: source.passed,
    environment: source.environment,
    error: source.error ?? null,
    failed_setup: source.setup.filter(failed).map((c) => c.command),
    failed_commands: source.commands.filter(failed).map((c) => c.command),
    timed_out: [...source.setup, ...source.commands].filter((c) => c.timed_out).map((c) => c.command),
    falsification_ran: source.falsification.ran,
    falsification_skipped_reason: source.falsification.skipped_reason ?? null,
    unfalsified: source.falsification.unfalsified,
    tests_modified: source.changes?.tests_modified ?? [],
    out_of_scope: source.changes?.out_of_scope ?? [],
    new_unclassified: source.changes?.new_unclassified ?? [],
  } : null;
  const flags = {
    worker_error: job.state === "error",
    timeout: job.state === "timeout",
    handoff_invalid: job.state === "done" && !job.handoff?.valid,
    snapshot_error: !!evidence?.error,
    setup: !!evidence?.failed_setup.length,
    verify: !!evidence?.failed_commands.length,
    falsification: !!evidence?.unfalsified.length,
    tests_modified: !!evidence?.tests_modified.length,
    out_of_scope: !!evidence?.out_of_scope.length,
    new_unclassified: !!evidence?.new_unclassified.length,
    conflict_unresolved: !!job.sync?.unresolved.length,
  };
  return {
    at: job.endedAt ?? new Date().toISOString(),
    job_id: job.id,
    kind: job.kind,
    parent_job_id: job.parentJobId ?? null,
    root_job_id: job.rootJobId ?? (job.kind === "implement" ? job.id : null),
    rework_round: job.reworkRound ?? (job.kind === "implement" ? 0 : 1),
    thread_id: job.threadId ?? null,
    ...(job.isolation ? { isolation: job.isolation.mode, branch: job.isolation.branch } : {}),
    ...(job.sync ? { sync: job.sync } : {}),
    state: job.state,
    error: job.error ?? null,
    turns: job.turns,
    attempts: job.attempts ?? 1,
    usage: job.usage ?? {},
    duration_ms: Math.max(0, Date.parse(job.endedAt ?? new Date().toISOString()) - Date.parse(job.startedAt)),
    handoff_valid: job.handoff?.valid ?? (job.state === "done" ? false : null),
    evidence,
    caught_by: Object.entries(flags).filter(([, flagged]) => flagged).map(([name]) => name).sort(),
  };
}

// Called only by the guarded terminal transition, never by persistence/restart
// rewrites. Retries and verification have not reached that transition yet.
export function appendOutcome(job: OutcomeJob, dir = defaultStateDir()): void {
  try {
    appendFileSync(join(dir, "outcomes.jsonl"), `${JSON.stringify(summarizeOutcome(job))}\n`, { mode: 0o600 });
  } catch (error) {
    warnOnce(error);
  }
}

/** Every merge attempt has its own outcome, without verification output tails. */
export function appendMergeOutcome(job: OutcomeJob, merge: MergeResult, dir = defaultStateDir()): void {
  const { evidence, ...outcome } = merge;
  try {
    appendFileSync(join(dir, "outcomes.jsonl"), `${JSON.stringify({
      at: merge.at, job_id: job.id, kind: "merge", branch: job.isolation?.branch ?? null,
      target_branch: job.isolation?.target_branch ?? null, merge: outcome,
      evidence: evidence ? summarizeOutcome({ ...job, evidence }).evidence : null,
    })}\n`, { mode: 0o600 });
  } catch (error) { warnOnce(error); }
}
