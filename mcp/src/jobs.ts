// Job registry: each job spawns one `codex app-server` process, starts (or
// resumes) a persisted thread, sets the thread goal, sends the contract as a
// turn, and lets Codex's server-side goal-continuation loop run until the goal
// is terminal (complete / budget_limited) or the thread goes quiet.
import { randomUUID } from "node:crypto";
import { CodexAppServer, type Json } from "./codex-client.ts";
import { parseHandoff, type Handoff } from "./contracts.ts";
import { writeLog } from "./log.ts";
import { createJobStore } from "./store.ts";

/**
 * Configuration options governing Codex execution, timeouts, retries, and concurrency.
 */
export interface JobConfig {
  /** Executable binary name or path for Codex */
  bin: string;
  /** CLI arguments passed when launching Codex app-server */
  args: string[];
  /** Working directory path for Codex job execution */
  cwd: string;
  /** Optional model override name passed to Codex */
  model?: string;
  /** Approval policy setting (e.g. "never" for autonomous mode) */
  approvalPolicy: string;
  /** Optional permission grants string for Codex execution */
  permissions?: string;
  /** Overall maximum job timeout duration in milliseconds */
  jobTimeoutMs: number;
  /** Quiet period duration in milliseconds before concluding single-turn jobs */
  quietMs: number;
  /** Inactivity warning threshold duration in milliseconds for stall detection */
  stallWarnMs: number;
  /** Optional maximum number of retry attempts for pre-turn process failures */
  retries?: number;
  /** Maximum number of jobs allowed to run concurrently */
  maxConcurrent: number;
}

/**
 * Status and resource consumption metrics for a Codex thread goal.
 */
export interface GoalState {
  /** Current status of the goal (e.g., "active", "complete", "budget_limited") */
  status?: string;
  /** Total tokens consumed by Codex toward fulfilling this goal */
  tokensUsed?: number;
  /** Optional token budget limit allocated for the goal */
  tokenBudget?: number;
  /** Total elapsed execution time in seconds */
  timeUsedSeconds?: number;
}

/**
 * Log entry capturing a single event in a job's execution history.
 */
export interface TranscriptEntry {
  /** ISO timestamp string recording when the event occurred */
  at: string;
  /** Category or event type indicator */
  kind: string;
  /** Detailed description text for the event */
  detail: string;
}

export type JobState = "blocked" | "queued" | "starting" | "running" | "done" | "error" | "timeout";

export type TokenUsage = Record<string, number>;

/**
 * Core job state record representing an implementation or rework task.
 */
export interface Job {
  /** Unique 8-character identifier assigned to the job */
  id: string;
  /** Job type classification: "implement" for new contracts or "rework" for delta contracts */
  kind: "implement" | "rework";
  /** Current lifecycle status of the job */
  state: JobState;
  /** Associated Codex thread identifier if thread has been initialized */
  threadId?: string;
  /** Goal status and resource consumption metrics */
  goal?: GoalState;
  /** Flag indicating whether thread goal was successfully established */
  goalSet: boolean;
  /** Aggregated token usage statistics mapped by token type */
  usage?: TokenUsage;
  /** Current attempt count for this job */
  attempts?: number;
  /** Number of completed turn iterations */
  turns: number;
  /** Chronological transcript of job execution log entries */
  transcript: TranscriptEntry[];
  /** Raw final agent message text received from Codex */
  finalMessage?: string;
  /** Parsed handoff structure extracted from final message */
  handoff?: Handoff;
  /** Error description string if job ended in error or timeout state */
  error?: string;
  /** Resolved list of context file absolute paths */
  contextFiles?: string[];
  /** Identifier of prerequisite job that must complete before this job runs */
  dependsOn?: string;
  /** ISO timestamp string when the job was created */
  startedAt: string;
  /** ISO timestamp string of the most recent Codex activity */
  lastActivityAt?: string;
  /** ISO timestamp string when the job reached a terminal state */
  endedAt?: string;
}

const store = createJobStore();
const jobs = new Map(store.listJobs().map((job) => [job.id, job]));

/**
 * Looks up a job by its unique identifier, checking memory cache first before attempting disk restoration.
 *
 * @param id - Unique job identifier to find
 * @returns The matching Job object, or undefined if it does not exist
 */
export function getJob(id: string): Job | undefined {
  return jobs.get(id) ?? store.getJob(id);
}

/**
 * Returns a list of all jobs currently registered in memory.
 *
 * @returns Array of all registered Job objects
 */
export function listJobs(): Job[] {
  return [...jobs.values()];
}

/**
 * Options provided when submitting a new job for execution.
 */
export interface StartJobOptions {
  /** Job type classification: "implement" or "rework" */
  kind: "implement" | "rework";
  /** Rendered prompt string containing protocol instructions and contract body */
  prompt: string;
  /** Compact objective string set on the thread goal for implement jobs */
  objective?: string; // set on implement; rework reuses the existing thread goal
  /** Optional token budget limit for goal execution */
  tokenBudget?: number;
  /** Optional list of context file paths for Codex reference */
  contextFiles?: string[];
  /** Identifier of prerequisite job that must complete first */
  dependsOn?: string;
  /** Existing thread identifier to resume for rework jobs */
  resumeThreadId?: string;
  /** Job execution configuration settings */
  config: JobConfig;
  /** Optional reasoning effort level override for Codex */
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  /** Optional callback for streaming job progress events */
  onProgress?: (event: JobProgressEvent) => void;
}

/**
 * Real-time progress event emitted during job execution.
 */
export interface JobProgressEvent {
  /** Identifier of the job emitting the progress event */
  jobId: string;
  /** Specific event type describing the lifecycle state transition or activity */
  event:
  | "blocked"
  | "unblocked"
  | "dependency_failed"
  | "queued"
  | "dequeued"
  | "turn_started"
  | "turn_ended"
  | "goal_updated"
  | "agent_message"
  | "stalled"
  | "resumed";
  /** Human-readable message detailing the progress event */
  message: string;
}

/**
 * Queue item entry representing a job waiting in the execution queue.
 */
interface QueueEntry {
  /** The queued job instance */
  job: Job;
  /** Options and configuration supplied when the job was started */
  opts: StartJobOptions;
}

const queue: QueueEntry[] = [];
const blocked = new Map<string, QueueEntry[]>();

/**
 * Calculates the 1-based queue position for a waiting job in the FIFO queue.
 *
 * @param id - Job identifier to query queue position for
 * @returns 1-based queue index position, or undefined if the job is not in the queue
 */
export function getQueuePosition(id: string): number | undefined {
  const index = queue.findIndex((entry) => entry.job.id === id);
  return index === -1 ? undefined : index + 1;
}

/**
 * Counts the number of currently active jobs in starting or running state.
 *
 * @returns Total count of jobs currently starting or running
 */
function activeJobCount() {
  return [...jobs.values()].filter((job) => job.state === "starting" || job.state === "running").length;
}

/**
 * Asynchronously launches execution for a job in the background and catches unhandled errors.
 *
 * @param job - Job instance to launch
 * @param opts - Job start options and configuration
 */
function launch(job: Job, opts: StartJobOptions) {
  void runJob(job, opts).catch((err) => {
    finish(job, "error", undefined, String(err?.message ?? err));
  });
}

/**
 * Inspects the waiting queue and dequeues the next job for execution whenever concurrency slots are available.
 */
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

/**
 * Creates a new implementation or rework job, handles dependency checking and queueing, and launches or enqueues it.
 *
 * @param opts - Options for job creation including contract prompt, dependency id, and configuration
 * @returns The newly created Job object
 */
export function startJob(opts: StartJobOptions): Job {
  const dependency = opts.dependsOn ? getJob(opts.dependsOn) : undefined;
  if (opts.dependsOn && !dependency) throw new Error(`unknown depends_on job_id ${opts.dependsOn}`);
  if (dependency?.state === "error" || dependency?.state === "timeout") {
    throw new Error(dependencyFailureMessage(dependency));
  }
  const isBlocked = dependency !== undefined && dependency.state !== "done";
  const queued = !isBlocked && (queue.length > 0 || activeJobCount() >= opts.config.maxConcurrent);
  const startedAt = new Date().toISOString();
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
    startedAt,
    lastActivityAt: startedAt,
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

/**
 * Appends a log entry to the job transcript while maintaining the maximum transcript size limit.
 *
 * @param job - Job object receiving the transcript log entry
 * @param kind - Category label for the transcript log entry
 * @param detail - Detailed description text for the event
 */
function log(job: Job, kind: string, detail: string) {
  job.transcript.push({ at: new Date().toISOString(), kind, detail: detail.slice(0, 500) });
  if (job.transcript.length > 200) job.transcript.splice(0, job.transcript.length - 200);
}

/**
 * Sets a job to a terminal state (done/error/timeout), parses handoff, kills the Codex client, and resolves dependent jobs.
 *
 * @param job - Target job to finish
 * @param state - Final state to set for the job
 * @param client - Associated Codex client instance to kill (optional)
 * @param error - Error message string if finishing with error or timeout (optional)
 */
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

/**
 * Generates a formatted error message when an upstream dependency job fails.
 *
 * @param dependency - The upstream dependency job that failed
 * @returns Formatted error string describing the dependency failure
 */
function dependencyFailureMessage(dependency: Job) {
  return `dependency ${dependency.id} failed: ${dependency.error ?? `state ${dependency.state}`}`;
}

/**
 * Notifies all blocked downstream jobs when an upstream dependency finishes, unblocking or failing them accordingly.
 *
 * @param dependency - The finished upstream dependency job
 */
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

/**
 * Determines whether an unblocked job should enter the waiting queue or launch immediately based on concurrency limits.
 *
 * @param job - The unblocked job to schedule
 * @param opts - Job execution options
 */
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

/**
 * Safely extracts text content from various item formats returned by Codex notifications.
 *
 * @param item - Raw notification item object from Codex
 * @returns Extracted text string, or undefined if extraction fails
 */
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

/**
 * Extracts normalized goal status and token usage fields from Codex goal update notification parameters.
 *
 * @param params - Raw notification parameters containing goal state information
 * @returns Normalized GoalState object
 */
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

/**
 * Extracts token usage statistics from turn notifications and normalizes usage key aliases.
 *
 * @param params - Notification parameters containing token usage fields
 * @returns Normalized TokenUsage object, or undefined if no usage statistics are found
 */
function extractUsage(params: any): TokenUsage | undefined {
  const source = params?.turn?.usage ?? params?.usage ?? params?.turn?.tokenUsage ?? params?.tokenUsage;
  if (!source || typeof source !== "object") return undefined;
  const usage: TokenUsage = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "number" && Number.isFinite(value)) usage[usageAliases[key] ?? key] = value;
  }
  return Object.keys(usage).length ? usage : undefined;
}

/**
 * Merges extracted token usage stats into the job's total token usage map via cumulative overwrite or additive sum.
 *
 * @param job - Target job object to update
 * @param usage - Token usage object to merge
 * @param cumulative - If true, overwrites existing values; if false, adds to existing values. Defaults to false
 */
function mergeUsage(job: Job, usage: TokenUsage | undefined, cumulative = false) {
  if (!usage) return;
  job.usage ??= {};
  for (const [key, value] of Object.entries(usage)) {
    job.usage[key] = cumulative ? value : (job.usage[key] ?? 0) + value;
  }
}

/**
 * Updates goal state, merges token usage statistics, and persists the updated job to disk.
 *
 * @param job - Target job object to update
 * @param params - Notification parameters containing updated goal information
 */
function updateGoal(job: Job, params: any) {
  job.goal = extractGoal(params);
  if (typeof job.goal.tokensUsed === "number") {
    mergeUsage(job, { totalTokens: job.goal.tokensUsed }, true);
  }
  store.save(job);
}

const TERMINAL_GOAL_STATUSES = new Set(["complete", "budget_limited", "budgetLimited"]);

/**
 * Result outcome returned by a single job attempt execution.
 */
interface AttemptResult {
  /** Error object if the attempt encountered an exception or process failure */
  error?: Error;
  /** Flag indicating whether the failure was caused by a process exit or spawn failure */
  processFailure: boolean;
}

/**
 * Manages job attempts, overall execution deadline, and automatic retries for pre-first-turn process crashes.
 *
 * @param job - Target job object to run
 * @param opts - Job start configuration options
 */
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

/**
 * Executes a single job attempt: spawns Codex process, initializes thread and goal, and listens to notifications.
 *
 * @param job - Active job object for this attempt
 * @param opts - Job configuration options
 * @param timeoutMs - Maximum execution time allowed for this attempt in milliseconds
 * @returns Promise resolving to an AttemptResult containing error info and process failure flag
 */
async function runAttempt(job: Job, opts: StartJobOptions, timeoutMs: number): Promise<AttemptResult> {
  const cfg = opts.config;
  let activeTurn = false;
  let stalled = false;
  let processError: Error | undefined;
  let quietTimer: ReturnType<typeof setTimeout> | undefined;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
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

  /**
   * Resets and starts the quiet timer; if no further Codex activity occurs within quietMs, finalizes the job as done.
   */
  function armQuietTimer() {
    clearTimeout(quietTimer);
    quietTimer = setTimeout(() => {
      log(job, "quiet", `no goal continuation within ${cfg.quietMs}ms; treating turn as final`);
      finalize("done");
      settle();
    }, cfg.quietMs);
  }

  /**
   * Clears any active stall detection timer.
   */
  function clearStallTimer() {
    clearTimeout(stallTimer);
    stallTimer = undefined;
  }

  /**
   * Arm or reset the stall detection timer to monitor if Codex produces events within the warning threshold.
   */
  function armStallTimer() {
    clearStallTimer();
    if (cfg.stallWarnMs === 0 || !activeTurn || stalled || !job.lastActivityAt) return;
    const stalledForMs = Math.max(0, Date.now() - Date.parse(job.lastActivityAt));
    stallTimer = setTimeout(checkForStall, Math.max(0, cfg.stallWarnMs - stalledForMs));
  }

  /**
   * Evaluates if Codex inactivity has exceeded the warning threshold, emitting stall events and notifications if triggered.
   */
  function checkForStall() {
    stallTimer = undefined;
    if (!activeTurn || stalled || !job.lastActivityAt) return;
    const stalledForMs = Math.max(0, Date.now() - Date.parse(job.lastActivityAt));
    if (stalledForMs < cfg.stallWarnMs) {
      armStallTimer();
      return;
    }
    stalled = true;
    log(job, "stalled", `no Codex activity for ${stalledForMs}ms`);
    store.save(job);
    writeLog("info", "job_stalled", { job_id: job.id, stalled_for_ms: stalledForMs });
    progress("stalled", `job stalled for ${stalledForMs}ms`);
  }

  /**
   * Updates the job's last activity timestamp, emitting resumed events if previously stalled and resetting stall timers.
   */
  function recordActivity() {
    const now = new Date();
    if (stalled && job.lastActivityAt) {
      const stalledForMs = Math.max(0, now.getTime() - Date.parse(job.lastActivityAt));
      stalled = false;
      log(job, "resumed", `Codex activity resumed after ${stalledForMs}ms`);
      writeLog("info", "job_resumed", { job_id: job.id, stalled_for_ms: stalledForMs });
      progress("resumed", `job resumed after ${stalledForMs}ms`);
    }
    job.lastActivityAt = now.toISOString();
    store.save(job);
    if (activeTurn) armStallTimer();
  }

  /**
   * Clears timers and finalizes the job with the specified terminal state and error message.
   *
   * @param state - Terminal job state
   * @param error - Error description string (optional)
   */
  function finalize(state: JobState, error?: string) {
    clearStallTimer();
    finish(job, state, client, error);
  }

  /**
   * Handles incoming JSON-RPC notifications from the Codex child process (turn events, agent messages, goal updates).
   *
   * @param method - RPC notification method name
   * @param params - Notification parameters payload
   */
  function handleNotification(method: string, params: Json) {
    writeLog("debug", "codex_notification", {
      job_id: job.id,
      attempt: job.attempts ?? 1,
      method,
      params: params ?? null,
    });
    recordActivity();
    const p: any = params ?? {};
    switch (method) {
      case "turn/started": {
        activeTurn = true;
        armStallTimer();
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
          finalize("done");
          settle();
        }
        break;
      }
      case "turn/completed":
      case "turn/failed": {
        activeTurn = false;
        clearStallTimer();
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

  /**
   * Called when a turn completes to verify if the thread goal is terminal, or arm a quiet timer for continuation turns.
   */
  async function onTurnEnded() {
    // No goal on the thread → single-turn mode; the turn's end is the job's end.
    if (!job.goalSet) {
      finalize("done");
      settle();
      return;
    }
    if (job.goal?.status && TERMINAL_GOAL_STATUSES.has(job.goal.status)) {
      finalize("done");
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
          finalize("done");
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
    finalize("timeout", `job exceeded ${cfg.jobTimeoutMs}ms`);
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
    clearStallTimer();
    client.kill();
  }
}
