// Job registry: each job spawns one `codex app-server` process, starts (or
// resumes) a persisted thread, sets the thread goal, sends the contract as a
// turn, and lets Codex's server-side goal-continuation loop run until the goal
// is terminal (complete / budget_limited) or the thread goes quiet.

import { randomUUID } from "node:crypto";
import { CodexAppServer, type Json } from "./codex-client.ts";
import { parseHandoff, type Handoff } from "./contracts.ts";
import { writeLog } from "./log.ts";
import { createJobStore } from "./store.ts";

export interface JobConfig {
  bin: string;
  args: string[];
  cwd: string;
  model?: string;
  approvalPolicy: string;
  permissions?: string;
  jobTimeoutMs: number;
  quietMs: number;
  retries?: number;
  maxConcurrent: number;
}

export interface GoalState {
  status?: string;
  tokensUsed?: number;
  tokenBudget?: number;
  timeUsedSeconds?: number;
}

export interface TranscriptEntry {
  at: string;
  kind: string;
  detail: string;
}

export type JobState = "blocked" | "queued" | "starting" | "running" | "done" | "error" | "timeout";

export type TokenUsage = Record<string, number>;

export interface Job {
  id: string;
  kind: "implement" | "rework";
  state: JobState;
  threadId?: string;
  goal?: GoalState;
  goalSet: boolean;
  usage?: TokenUsage;
  attempts?: number;
  turns: number;
  transcript: TranscriptEntry[];
  finalMessage?: string;
  handoff?: Handoff;
  error?: string;
  contextFiles?: string[];
  dependsOn?: string;
  startedAt: string;
  endedAt?: string;
}

const store = createJobStore();
const jobs = new Map(store.listJobs().map((job) => [job.id, job]));

export function getJob(id: string): Job | undefined {
  return jobs.get(id) ?? store.getJob(id);
}

export function listJobs(): Job[] {
  return [...jobs.values()];
}

export interface StartJobOptions {
  kind: "implement" | "rework";
  prompt: string;
  objective?: string; // set on implement; rework reuses the existing thread goal
  tokenBudget?: number;
  contextFiles?: string[];
  dependsOn?: string;
  resumeThreadId?: string;
  config: JobConfig;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  onProgress?: (event: JobProgressEvent) => void;
}

export interface JobProgressEvent {
  jobId: string;
  event:
    | "blocked"
    | "unblocked"
    | "dependency_failed"
    | "queued"
    | "dequeued"
    | "turn_started"
    | "turn_ended"
    | "goal_updated"
    | "agent_message";
  message: string;
}

interface QueueEntry {
  job: Job;
  opts: StartJobOptions;
}

const queue: QueueEntry[] = [];
const blocked = new Map<string, QueueEntry[]>();

export function getQueuePosition(id: string): number | undefined {
  const index = queue.findIndex((entry) => entry.job.id === id);
  return index === -1 ? undefined : index + 1;
}

function activeJobCount() {
  return [...jobs.values()].filter((job) => job.state === "starting" || job.state === "running").length;
}

function launch(job: Job, opts: StartJobOptions) {
  void runJob(job, opts).catch((err) => {
    finish(job, "error", undefined, String(err?.message ?? err));
  });
}

function drainQueue() {
  while (queue.length > 0 && activeJobCount() < queue[0].opts.config.maxConcurrent) {
    const { job, opts } = queue.shift()!;
    job.state = "starting";
    log(job, "queue", "dequeued; starting job");
    store.save(job);
    writeLog("info", "job_dequeued", { job_id: job.id, kind: job.kind });
    opts.onProgress?.({ jobId: job.id, event: "dequeued", message: "job dequeued; starting" });
    launch(job, opts);
  }
}

export function startJob(opts: StartJobOptions): Job {
  const dependency = opts.dependsOn ? getJob(opts.dependsOn) : undefined;
  if (opts.dependsOn && !dependency) throw new Error(`unknown depends_on job_id ${opts.dependsOn}`);
  if (dependency?.state === "error" || dependency?.state === "timeout") {
    throw new Error(dependencyFailureMessage(dependency));
  }
  const isBlocked = dependency !== undefined && dependency.state !== "done";
  const queued = !isBlocked && (queue.length > 0 || activeJobCount() >= opts.config.maxConcurrent);
  const job: Job = {
    id: randomUUID().slice(0, 8),
    kind: opts.kind,
    state: isBlocked ? "blocked" : queued ? "queued" : "starting",
    goalSet: false,
    usage: {},
    attempts: 1,
    turns: 0,
    transcript: [],
    ...(opts.contextFiles ? { contextFiles: opts.contextFiles } : {}),
    ...(opts.dependsOn ? { dependsOn: opts.dependsOn } : {}),
    startedAt: new Date().toISOString(),
  };
  jobs.set(job.id, job);
  if (isBlocked) {
    const dependents = blocked.get(opts.dependsOn!) ?? [];
    dependents.push({ job, opts });
    blocked.set(opts.dependsOn!, dependents);
    log(job, "blocked", `blocked on dependency ${opts.dependsOn}`);
  } else if (queued) {
    queue.push({ job, opts });
    log(job, "queue", `enqueued at position ${queue.length}`);
  }
  store.save(job);
  writeLog("info", "job_created", { job_id: job.id, kind: job.kind, state: job.state });
  if (isBlocked) {
    writeLog("info", "job_blocked", { job_id: job.id, kind: job.kind, depends_on: opts.dependsOn });
    opts.onProgress?.({ jobId: job.id, event: "blocked", message: `blocked on dependency ${opts.dependsOn}` });
  } else if (queued) {
    writeLog("info", "job_enqueued", { job_id: job.id, kind: job.kind, queue_position: queue.length });
    opts.onProgress?.({ jobId: job.id, event: "queued", message: `job queued at position ${queue.length}` });
  } else {
    launch(job, opts);
  }
  return job;
}

function log(job: Job, kind: string, detail: string) {
  job.transcript.push({ at: new Date().toISOString(), kind, detail: detail.slice(0, 500) });
  if (job.transcript.length > 200) job.transcript.splice(0, job.transcript.length - 200);
}

function finish(job: Job, state: JobState, client?: CodexAppServer, error?: string) {
  if (job.state === "done" || job.state === "error" || job.state === "timeout") return;
  const previousState = job.state;
  job.state = state;
  job.error = error;
  job.endedAt = new Date().toISOString();
  if (job.finalMessage) job.handoff = parseHandoff(job.finalMessage);
  store.save(job);
  writeLog(state === "error" || state === "timeout" ? "error" : "info", "job_state_changed", {
    job_id: job.id,
    from: previousState,
    to: state,
    ...(error ? { error } : {}),
  });
  writeLog("info", "job_usage", {
    job_id: job.id,
    state,
    usage: job.usage ?? {},
  });
  client?.kill();
  resolveDependents(job);
  drainQueue();
}

function dependencyFailureMessage(dependency: Job) {
  return `dependency ${dependency.id} failed: ${dependency.error ?? `state ${dependency.state}`}`;
}

function resolveDependents(dependency: Job) {
  const dependents = blocked.get(dependency.id);
  if (!dependents?.length) return;
  blocked.delete(dependency.id);

  for (const { job, opts } of dependents) {
    if (dependency.state === "done") {
      log(job, "unblocked", `dependency ${dependency.id} completed; unblocked`);
      store.save(job);
      writeLog("info", "job_unblocked", { job_id: job.id, depends_on: dependency.id });
      opts.onProgress?.({
        jobId: job.id,
        event: "unblocked",
        message: `dependency ${dependency.id} completed; job unblocked`,
      });
      enqueueOrLaunch(job, opts);
    } else {
      const error = dependencyFailureMessage(dependency);
      log(job, "dependency_failed", error);
      store.save(job);
      writeLog("info", "job_dependency_failed", {
        job_id: job.id,
        depends_on: dependency.id,
        error,
      });
      opts.onProgress?.({ jobId: job.id, event: "dependency_failed", message: error });
      finish(job, "error", undefined, error);
    }
  }
}

function enqueueOrLaunch(job: Job, opts: StartJobOptions) {
  if (queue.length > 0 || activeJobCount() >= opts.config.maxConcurrent) {
    job.state = "queued";
    queue.push({ job, opts });
    log(job, "queue", `enqueued at position ${queue.length} after dependency completed`);
    store.save(job);
    writeLog("info", "job_enqueued", { job_id: job.id, kind: job.kind, queue_position: queue.length });
    opts.onProgress?.({ jobId: job.id, event: "queued", message: `job queued at position ${queue.length}` });
    drainQueue();
    return;
  }

  job.state = "starting";
  store.save(job);
  launch(job, opts);
}

// Defensive field extraction: the app-server item shapes vary by type/version.
function extractText(item: any): string | undefined {
  if (typeof item?.text === "string") return item.text;
  if (typeof item?.message === "string") return item.message;
  if (typeof item?.content === "string") return item.content;
  if (Array.isArray(item?.content)) {
    const parts = item.content
      .map((c: any) => (typeof c === "string" ? c : c?.text))
      .filter((x: any) => typeof x === "string");
    if (parts.length) return parts.join("\n");
  }
  return undefined;
}

function extractGoal(params: any): GoalState {
  const g = params?.goal ?? params ?? {};
  return {
    status: g.status,
    tokensUsed: g.tokensUsed ?? g.tokens_used,
    tokenBudget: g.tokenBudget ?? g.token_budget,
    timeUsedSeconds: g.timeUsedSeconds ?? g.time_used_seconds,
  };
}

const usageAliases: Record<string, string> = {
  input_tokens: "inputTokens",
  input_token_count: "inputTokens",
  output_tokens: "outputTokens",
  output_token_count: "outputTokens",
  total_tokens: "totalTokens",
  total_token_count: "totalTokens",
  tokensUsed: "totalTokens",
  tokens_used: "totalTokens",
};

function extractUsage(params: any): TokenUsage | undefined {
  const source = params?.turn?.usage ?? params?.usage ?? params?.turn?.tokenUsage ?? params?.tokenUsage;
  if (!source || typeof source !== "object") return undefined;
  const usage: TokenUsage = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "number" && Number.isFinite(value)) usage[usageAliases[key] ?? key] = value;
  }
  return Object.keys(usage).length ? usage : undefined;
}

function mergeUsage(job: Job, usage: TokenUsage | undefined, cumulative = false) {
  if (!usage) return;
  job.usage ??= {};
  for (const [key, value] of Object.entries(usage)) {
    job.usage[key] = cumulative ? value : (job.usage[key] ?? 0) + value;
  }
}

function updateGoal(job: Job, params: any) {
  job.goal = extractGoal(params);
  if (typeof job.goal.tokensUsed === "number") {
    mergeUsage(job, { totalTokens: job.goal.tokensUsed }, true);
  }
  store.save(job);
}

const TERMINAL_GOAL_STATUSES = new Set(["complete", "budget_limited", "budgetLimited"]);

interface AttemptResult {
  error?: Error;
  processFailure: boolean;
}

async function runJob(job: Job, opts: StartJobOptions) {
  const deadline = Date.now() + opts.config.jobTimeoutMs;
  const maxAttempts = (opts.config.retries ?? 1) + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    job.attempts = attempt;
    log(job, "attempt", `attempt ${attempt} started`);
    store.save(job);
    writeLog("info", "job_attempt_started", { job_id: job.id, attempt });

    const result = await runAttempt(job, opts, Math.max(0, deadline - Date.now()));
    if (!result.error || job.state === "done" || job.state === "error" || job.state === "timeout") return;

    const retryable = result.processFailure && job.state === "starting" && job.turns === 0;
    if (!retryable || attempt === maxAttempts) {
      finish(job, "error", undefined, result.error.message);
      return;
    }

    log(job, "retry", `attempt ${attempt} failed before the first turn; retrying in 500ms`);
    store.save(job);
    writeLog("info", "job_retry_scheduled", {
      job_id: job.id,
      attempt,
      next_attempt: attempt + 1,
      delay_ms: 500,
      error: result.error.message,
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function runAttempt(job: Job, opts: StartJobOptions, timeoutMs: number): Promise<AttemptResult> {
  const cfg = opts.config;
  let activeTurn = false;
  let processError: Error | undefined;
  let quietTimer: ReturnType<typeof setTimeout> | undefined;
  let settle!: () => void;
  const doneSignal = new Promise<void>((res) => (settle = res));
  const progress = (event: JobProgressEvent["event"], message: string) =>
    opts.onProgress?.({ jobId: job.id, event, message });

  if (!opts.resumeThreadId) job.goalSet = false;

  const client = new CodexAppServer({
    bin: cfg.bin,
    args: cfg.args,
    cwd: cfg.cwd,
    onLog: (line) => log(job, "log", line),
    onSpawn: (pid) => writeLog("info", "codex_process_spawn", {
      job_id: job.id,
      attempt: job.attempts ?? 1,
      ...(pid === undefined ? {} : { pid }),
    }),
    onExit: (code, error) => {
      writeLog(job.state === "starting" || job.state === "running" ? "error" : "info", "codex_process_exit", {
        job_id: job.id,
        attempt: job.attempts ?? 1,
        code,
        error: error.message,
      });
      if (job.state === "starting" || job.state === "running") processError = error;
      settle();
    },
    onNotification: (method, params) => handleNotification(method, params),
  });

  function armQuietTimer() {
    clearTimeout(quietTimer);
    quietTimer = setTimeout(() => {
      log(job, "quiet", `no goal continuation within ${cfg.quietMs}ms; treating turn as final`);
      finish(job, "done", client);
      settle();
    }, cfg.quietMs);
  }

  function handleNotification(method: string, params: Json) {
    writeLog("debug", "codex_notification", {
      job_id: job.id,
      attempt: job.attempts ?? 1,
      method,
      params: params ?? null,
    });
    const p: any = params ?? {};
    switch (method) {
      case "turn/started": {
        activeTurn = true;
        job.turns += 1;
        clearTimeout(quietTimer);
        if (job.state === "starting") {
          job.state = "running";
          store.save(job);
          writeLog("info", "job_state_changed", { job_id: job.id, from: "starting", to: "running" });
        }
        log(job, "turn", `turn ${job.turns} started`);
        writeLog("info", "turn_started", { job_id: job.id, turn: job.turns });
        progress("turn_started", `turn ${job.turns} started`);
        break;
      }
      case "item/completed": {
        const item = p.item ?? p;
        const type = String(item?.type ?? "item");
        if (/agent.?message/i.test(type)) {
          const text = extractText(item);
          if (text) {
            job.finalMessage = text;
            log(job, "message", text.slice(0, 200));
            progress("agent_message", text.slice(0, 200));
          }
        } else if (/command/i.test(type)) {
          log(job, "command", String(item?.command ?? item?.detail ?? ""));
        } else {
          log(job, "item", type);
        }
        break;
      }
      case "thread/goal/updated": {
        updateGoal(job, p);
        log(job, "goal", `status=${job.goal?.status} tokensUsed=${job.goal?.tokensUsed ?? "?"}`);
        writeLog("info", "goal_updated", {
          job_id: job.id,
          status: job.goal?.status ?? null,
          tokens_used: job.goal?.tokensUsed ?? null,
        });
        progress("goal_updated", `goal status=${job.goal?.status ?? "unknown"}`);
        if (job.goal?.status && TERMINAL_GOAL_STATUSES.has(job.goal.status) && !activeTurn) {
          finish(job, "done", client);
          settle();
        }
        break;
      }
      case "turn/completed":
      case "turn/failed": {
        activeTurn = false;
        mergeUsage(job, extractUsage(p));
        store.save(job);
        const status = p.turn?.status ?? (method === "turn/failed" ? "failed" : "completed");
        log(job, "turn", `turn ended (${status})`);
        writeLog("info", "turn_ended", { job_id: job.id, turn: job.turns, status });
        progress("turn_ended", `turn ended (${status})`);
        void onTurnEnded();
        break;
      }
      default:
        break;
    }
  }

  async function onTurnEnded() {
    // No goal on the thread → single-turn mode; the turn's end is the job's end.
    if (!job.goalSet) {
      finish(job, "done", client);
      settle();
      return;
    }
    if (job.goal?.status && TERMINAL_GOAL_STATUSES.has(job.goal.status)) {
      finish(job, "done", client);
      settle();
      return;
    }
    // Goal may lag the turn notification — ask directly, then wait for a
    // continuation turn; if none starts within quietMs, treat as final.
    try {
      const res: any = await client.request("thread/goal/get", { threadId: job.threadId }, 15_000);
      if (res?.goal) {
        updateGoal(job, res);
        if (job.goal?.status && TERMINAL_GOAL_STATUSES.has(job.goal.status)) {
          finish(job, "done", client);
          settle();
          return;
        }
      }
    } catch (err: any) {
      log(job, "log", `thread/goal/get failed: ${err?.message ?? err}`);
    }
    if (!activeTurn) armQuietTimer();
  }

  const overallTimer = setTimeout(() => {
    finish(job, "timeout", client, `job exceeded ${cfg.jobTimeoutMs}ms`);
    settle();
  }, timeoutMs);

  try {
    await client.initialize();

    const threadParams: Record<string, unknown> = {
      cwd: cfg.cwd,
      approvalPolicy: cfg.approvalPolicy,
      ...(cfg.model ? { model: cfg.model } : {}),
      ...(cfg.permissions ? { permissions: cfg.permissions } : {}),
      ...(opts.reasoningEffort ? { config: { model_reasoning_effort: opts.reasoningEffort } } : {}),
    };
    let threadRes: any;
    if (opts.resumeThreadId) {
      threadRes = await client.request("thread/resume", { threadId: opts.resumeThreadId, ...threadParams });
      job.threadId = threadRes?.thread?.id ?? opts.resumeThreadId;
      job.goalSet = true; // implement already set the thread goal; the loop re-engages on resume
    } else {
      threadRes = await client.request("thread/start", { ...threadParams, sessionStartSource: "startup" });
      job.threadId = threadRes?.thread?.id ?? threadRes?.id;
    }
    if (!job.threadId) throw new Error(`could not determine thread id from ${JSON.stringify(threadRes).slice(0, 300)}`);
    store.save(job);
    log(job, "thread", `thread ${job.threadId} ${opts.resumeThreadId ? "resumed" : "started"}`);

    if (opts.objective) {
      try {
        const goalRes: any = await client.request("thread/goal/set", {
          threadId: job.threadId,
          objective: opts.objective,
          ...(opts.tokenBudget ? { tokenBudget: opts.tokenBudget } : {}),
        });
        job.goalSet = true;
        updateGoal(job, goalRes);
        log(job, "goal", `goal set (status=${job.goal?.status ?? "active"})`);
        progress("goal_updated", `goal status=${job.goal?.status ?? "active"}`);
      } catch (err: any) {
        // A dead process is a transient failure (retryable); a feature-gated
        // goal API degrades to single-turn mode rather than failing the job.
        if (client.exited) throw err;
        log(job, "goal", `thread/goal/set failed (${err?.message ?? err}); continuing without goal loop`);
        job.goalSet = false;
      }
    }

    await client.request("turn/start", {
      threadId: job.threadId,
      input: [{ type: "text", text: opts.prompt }],
      ...(opts.reasoningEffort ? { effort: opts.reasoningEffort } : {}),
    });
    await doneSignal;
    return processError ? { error: processError, processFailure: true } : { processFailure: false };
  } catch (error: any) {
    const failure = processError ?? (error instanceof Error ? error : new Error(String(error)));
    return { error: failure, processFailure: client.exited };
  } finally {
    clearTimeout(overallTimer);
    clearTimeout(quietTimer);
    client.kill();
  }
}
