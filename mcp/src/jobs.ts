// Job registry: each job spawns one `codex app-server` process, starts (or
// resumes) a persisted thread, sets the thread goal, sends the contract as a
// turn, and lets Codex's server-side goal-continuation loop run until the goal
// is terminal (complete / budget_limited) or the thread goes quiet.

import { randomUUID } from "node:crypto";
import { CodexAppServer, type Json } from "./codex-client.ts";
import { parseHandoff, type Handoff } from "./contracts.ts";

export interface JobConfig {
  bin: string;
  args: string[];
  cwd: string;
  model?: string;
  approvalPolicy: string;
  permissions?: string;
  jobTimeoutMs: number;
  quietMs: number;
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

export type JobState = "starting" | "running" | "done" | "error" | "timeout";

export interface Job {
  id: string;
  kind: "implement" | "rework";
  state: JobState;
  threadId?: string;
  goal?: GoalState;
  goalSet: boolean;
  turns: number;
  transcript: TranscriptEntry[];
  finalMessage?: string;
  handoff?: Handoff;
  error?: string;
  startedAt: string;
  endedAt?: string;
}

const jobs = new Map<string, Job>();

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function listJobs(): Job[] {
  return [...jobs.values()];
}

export interface StartJobOptions {
  kind: "implement" | "rework";
  prompt: string;
  objective?: string; // set on implement; rework reuses the existing thread goal
  tokenBudget?: number;
  resumeThreadId?: string;
  config: JobConfig;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  onProgress?: (event: JobProgressEvent) => void;
}

export interface JobProgressEvent {
  jobId: string;
  event: "turn_started" | "turn_ended" | "goal_updated" | "agent_message";
  message: string;
}

export function startJob(opts: StartJobOptions): Job {
  const job: Job = {
    id: randomUUID().slice(0, 8),
    kind: opts.kind,
    state: "starting",
    goalSet: false,
    turns: 0,
    transcript: [],
    startedAt: new Date().toISOString(),
  };
  jobs.set(job.id, job);
  void runJob(job, opts).catch((err) => {
    finish(job, "error", undefined, String(err?.message ?? err));
  });
  return job;
}

function log(job: Job, kind: string, detail: string) {
  job.transcript.push({ at: new Date().toISOString(), kind, detail: detail.slice(0, 500) });
  if (job.transcript.length > 200) job.transcript.splice(0, job.transcript.length - 200);
}

function finish(job: Job, state: JobState, client?: CodexAppServer, error?: string) {
  if (job.state === "done" || job.state === "error" || job.state === "timeout") return;
  job.state = state;
  job.error = error;
  job.endedAt = new Date().toISOString();
  if (job.finalMessage) job.handoff = parseHandoff(job.finalMessage);
  client?.kill();
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

const TERMINAL_GOAL_STATUSES = new Set(["complete", "budget_limited", "budgetLimited"]);

async function runJob(job: Job, opts: StartJobOptions) {
  const cfg = opts.config;
  let activeTurn = false;
  let quietTimer: ReturnType<typeof setTimeout> | undefined;
  let settle!: () => void;
  const doneSignal = new Promise<void>((res) => (settle = res));
  const progress = (event: JobProgressEvent["event"], message: string) =>
    opts.onProgress?.({ jobId: job.id, event, message });

  const client = new CodexAppServer({
    bin: cfg.bin,
    args: cfg.args,
    cwd: cfg.cwd,
    onLog: (line) => log(job, "log", line),
    onExit: (code) => {
      if (job.state === "starting" || job.state === "running") {
        finish(job, "error", undefined, `codex app-server exited early (code ${code})`);
      }
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
    const p: any = params ?? {};
    switch (method) {
      case "turn/started": {
        activeTurn = true;
        job.turns += 1;
        clearTimeout(quietTimer);
        log(job, "turn", `turn ${job.turns} started`);
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
        job.goal = extractGoal(p);
        log(job, "goal", `status=${job.goal.status} tokensUsed=${job.goal.tokensUsed ?? "?"}`);
        progress("goal_updated", `goal status=${job.goal.status ?? "unknown"}`);
        if (job.goal.status && TERMINAL_GOAL_STATUSES.has(job.goal.status) && !activeTurn) {
          finish(job, "done", client);
          settle();
        }
        break;
      }
      case "turn/completed":
      case "turn/failed": {
        activeTurn = false;
        const status = p.turn?.status ?? (method === "turn/failed" ? "failed" : "completed");
        log(job, "turn", `turn ended (${status})`);
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
        job.goal = extractGoal(res);
        if (job.goal.status && TERMINAL_GOAL_STATUSES.has(job.goal.status)) {
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
  }, cfg.jobTimeoutMs);

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
    log(job, "thread", `thread ${job.threadId} ${opts.resumeThreadId ? "resumed" : "started"}`);

    if (opts.objective) {
      try {
        const goalRes: any = await client.request("thread/goal/set", {
          threadId: job.threadId,
          objective: opts.objective,
          ...(opts.tokenBudget ? { tokenBudget: opts.tokenBudget } : {}),
        });
        job.goalSet = true;
        job.goal = extractGoal(goalRes);
        log(job, "goal", `goal set (status=${job.goal.status ?? "active"})`);
        progress("goal_updated", `goal status=${job.goal.status ?? "active"}`);
      } catch (err: any) {
        // Goals can be feature-gated; degrade to single-turn mode rather than fail.
        log(job, "goal", `thread/goal/set failed (${err?.message ?? err}); continuing without goal loop`);
        job.goalSet = false;
      }
    }

    job.state = "running";
    await client.request("turn/start", {
      threadId: job.threadId,
      input: [{ type: "text", text: opts.prompt }],
      ...(opts.reasoningEffort ? { effort: opts.reasoningEffort } : {}),
    });

    await doneSignal;
  } finally {
    clearTimeout(overallTimer);
    clearTimeout(quietTimer);
    client.kill();
  }
}
