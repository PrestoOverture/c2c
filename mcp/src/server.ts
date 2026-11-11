// MCP server: Claude (architect/reviewer) delegates implementation to Codex
// (implementer) through typed Goal/Delta Contract tools. Codex runs each
// contract under its thread-goal loop (`/goal`) until the objective is met.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import {
  renderGoalContract,
  renderDeltaContract,
  renderObjectiveDetails,
  type GoalContract,
} from "./contracts.ts";
import { startJob, getJob, listJobs, getQueuePosition, mergeJob, type Job, type JobConfig } from "./jobs.ts";
import { readCodexConfig } from "./config.ts";

/**
 * Reads an integer configuration value from environment variables, falling back to a default value if missing or invalid.
 *
 * @param name - Name of the environment variable
 * @param fallback - Default integer value to use if parsing fails
 * @returns Parsed integer value or default fallback
 */
function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v ? Number.parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Reads environment variables to construct and return a complete Codex job execution configuration object.
 *
 * @param cwd - Target working directory path for job execution (optional)
 * @returns Configured JobConfig object containing timeouts, concurrency caps, and retry parameters
 */
function config(cwd?: string): JobConfig {
  return {
    bin: process.env.CODEX_BIN ?? "codex",
    args: (process.env.CODEX_ARGS ?? "app-server").split(" ").filter(Boolean),
    cwd: cwd ?? process.env.CODEX_CWD ?? process.cwd(),
    model: process.env.CODEX_MODEL || undefined,
    approvalPolicy: process.env.CODEX_APPROVAL_POLICY ?? "never",
    permissions: process.env.CODEX_PERMISSIONS || undefined,
    jobTimeoutMs: envInt("CODEX_JOB_TIMEOUT_MS", 7_200_000),
    idleTimeoutMs: Math.max(0, envInt("C2C_IDLE_TIMEOUT_MS", 1_200_000)),
    quietMs: envInt("CODEX_QUIET_MS", 30_000),
    stallWarnMs: Math.max(0, envInt("C2C_STALL_WARN_MS", 120_000)),
    retries: Math.max(0, envInt("C2C_RETRIES", 1)),
    maxConcurrent: Math.max(1, envInt("C2C_MAX_CONCURRENT", 2)),
    verifyTimeoutMs: Math.max(1, envInt("C2C_VERIFY_TIMEOUT_MS", 600_000)),
  };
}

const OBJECTIVE_MAX = envInt("GOAL_OBJECTIVE_MAX", 2000);
const objectiveBudgetDescription =
  `The rendered thread-goal objective has a GOAL_OBJECTIVE_MAX budget of ${OBJECTIVE_MAX} characters; ` +
  "over-limit calls are rejected.";

/**
 * Extracts core job status, token usage statistics, and recent activity logs into a concise summary object.
 *
 * @param job - Job object to summarize
 * @param transcriptTail - Number of recent transcript log entries to include, defaulting to 15
 * @returns Formatted job status summary object suitable for client consumption
 */
function jobSummary(job: Job, transcriptTail = 15) {
  return {
    job_id: job.id,
    kind: job.kind,
    parent_job_id: job.parentJobId ?? null,
    root_job_id: job.rootJobId ?? (job.kind === "implement" ? job.id : null),
    rework_round: job.reworkRound ?? (job.kind === "implement" ? 0 : 1),
    state: job.state,
    thread_id: job.threadId ?? null,
    goal: job.goal ?? null,
    usage: job.usage ?? {},
    attempts: job.attempts ?? 1,
    turns: job.turns,
    started_at: job.startedAt,
    ended_at: job.endedAt ?? null,
    error: job.error ?? null,
    evidence: job.evidence ?? null,
    ...(job.isolation ? { isolation: job.isolation } : {}),
    ...(job.merge ? { merge: job.merge } : {}),
    ...(!["done", "error", "timeout"].includes(job.state)
      ? { last_activity_at: job.lastActivityAt ?? null }
      : {}),
    ...(job.state === "running" && job.lastActivityAt
      ? { seconds_since_activity: Math.max(0, (Date.now() - Date.parse(job.lastActivityAt)) / 1000) }
      : {}),
    ...(job.contextFiles ? { context_files: job.contextFiles } : {}),
    ...(job.dependsOn ? { depends_on: job.dependsOn } : {}),
    ...(job.state === "queued" ? { queue_position: getQueuePosition(job.id) ?? null } : {}),
    transcript_tail: job.transcript.slice(-transcriptTail),
  };
}

/**
 * Formats a data object into an MCP text result payload structure.
 *
 * @param obj - Data object to include in the content payload
 * @param isError - Flag indicating if this payload represents an error result, defaulting to false
 * @returns Formatted MCP text result object
 */
function textResult(obj: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }],
    isError,
  };
}

/**
 * Server instructions, injected into the client's system prompt on connect.
 * Unlike the `c2c-workflow` Prompt (user-invoked slash command), these are always
 * in context — so they must stay short and must only activate on Codex delegation.
 */
const SERVER_INSTRUCTIONS = `When the user asks to delegate work to Codex (or to use c2c), act as architect and reviewer, not implementer:
1. Draft a Goal Contract and get the user's approval (show the user the contract) before calling codex_implement.
2. codex_estimate, then codex_implement: pass verify_commands, test_paths and scope (setup_commands for dependencies); poll codex_status and report progress.
3. Read evidence first in codex_result: read unfalsified, tests_modified, out_of_scope and new_unclassified; review judges intent and constraints, never trusts the handoff alone. On failure, send a Delta Contract via codex_rework.
If a Codex job itself fails (error, 0 tokens, no handoff), report it and wait; don't implement the task yourself unless the user explicitly asks.
For isolated jobs, codex_merge verifies and integrates passing work; cleanup defaults to true.
Full formats: the c2c-workflow prompt.`;

const server = new McpServer(
  { name: "c2c-codex", version: "0.3.7" },
  { instructions: SERVER_INSTRUCTIONS },
);
const reasoningEffort = z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]);
const contextFiles = z.array(z.object({
  path: z.string().min(1),
  note: z.string().optional(),
}));
const verificationInputs = {
  verify_commands: z.array(z.string()).optional().describe("Shell commands the server re-runs after Codex exits in a clean working-tree snapshot; each must exit 0. Read evidence first; review judges intent."),
  setup_commands: z.array(z.string()).optional().describe("Shell commands run before verification and falsification in each snapshot, and before merged-tree verification (e.g. install dependencies); stop on first failure. With no verify_commands, nothing runs."),
  test_paths: z.array(z.string()).optional().describe("Declared test files: git glob pathspecs relative to job cwd, including new tests. After verification passes, the server keeps only test changes and re-runs checks; commands that still pass appear in falsification.unfalsified. Rework inherits unless overridden; [] clears."),
  scope: z.array(z.string()).optional().describe("Allowed production files: git glob pathspecs relative to job cwd. Changes outside scope and test_paths are flagged; added files matching neither are new_unclassified. Rework inherits unless overridden; [] clears."),
};

/**
 * Validates and resolves relative file paths in a context file list to absolute paths, verifying disk existence.
 *
 * @param files - Optional list of context file objects containing path and note
 * @param cwd - Base working directory for resolving relative paths
 * @returns Object containing lists of resolved valid file paths and missing file paths
 */
async function resolveContextFiles(
  files: { path: string; note?: string }[] | undefined,
  cwd: string,
) {
  if (!files?.length) return { files: undefined, missing: [] as string[] };
  const resolved = files.map((file) => ({ ...file, path: resolve(cwd, file.path) }));
  const exists = await Promise.all(resolved.map(async (file) => {
    try {
      await stat(file.path);
      return true;
    } catch {
      return false;
    }
  }));
  return {
    files: resolved,
    missing: resolved.filter((_, index) => !exists[index]).map((file) => file.path),
  };
}

/**
 * Constructs an MCP error result listing missing context file paths.
 *
 * @param paths - Array of missing file paths
 * @returns Formatted MCP error text result
 */
function missingContextFiles(paths: string[]) {
  return textResult({ error: `context_files not found:\n${paths.map((path) => `- ${path}`).join("\n")}` }, true);
}

/**
 * Aggregates token usage statistics from completed implement jobs, calculating median, 90th percentile, and mean tokens.
 *
 * @returns Object containing historical usage metrics, or null if no completed implement jobs exist
 */
function implementHistory() {
  const totals = listJobs()
    .filter((job) => job.kind === "implement" && job.state === "done")
    .map((job) => job.usage?.totalTokens)
    .filter((total): total is number => typeof total === "number" && Number.isFinite(total))
    .sort((a, b) => a - b);
  if (!totals.length) return null;
  const middle = Math.floor(totals.length / 2);
  const median = totals.length % 2
    ? totals[middle]
    : (totals[middle - 1] + totals[middle]) / 2;
  return {
    samples: totals.length,
    median_total_tokens: Math.round(median),
    p90_total_tokens: Math.round(totals[Math.ceil(totals.length * 0.9) - 1]),
    mean_total_tokens: Math.round(totals.reduce((sum, total) => sum + total, 0) / totals.length),
  };
}

/**
 * Validates specified job dependency existence and state before starting a dependent job.
 *
 * @param dependsOn - Identifier of the prerequisite job (optional)
 * @returns Error message string if dependency validation fails, or undefined if valid
 */
function dependencyValidationError(dependsOn: string | undefined) {
  if (!dependsOn) return undefined;
  const dependency = getJob(dependsOn);
  if (!dependency) return `unknown depends_on job_id ${dependsOn}`;
  if (dependency.state === "error" || dependency.state === "timeout") {
    return `dependency ${dependency.id} failed: ${dependency.error ?? `state ${dependency.state}`}`;
  }
  return undefined;
}

/**
 * Creates a sequential progress reporting callback that sends job progress events as MCP notifications to the client.
 *
 * @returns Progress reporting callback function
 */
function progressReporter() {
  let sequence = 0;
  return (event: { jobId: string; event: string; message: string }) => {
    sequence += 1;
    void server.server.notification({
      method: "notifications/progress",
      params: {
        progressToken: event.jobId,
        progress: sequence,
        message: JSON.stringify(event),
      },
    }).catch(() => undefined);
  };
}

server.registerTool(
  "codex_implement",
  {
    title: "Delegate a Goal Contract to Codex",
    description:
      "Start a Codex implementation job for a Goal Contract. Sets the contract as a Codex thread goal " +
      "(the /goal loop keeps Codex iterating until the objective is achieved or the token budget is hit) " +
      "and sends the full contract as the first turn. Returns a job_id immediately; poll codex_status, " +
      "then fetch codex_result when done. Language-agnostic: verification commands come from the " +
      "caller via verify_commands, with declared test_paths and scope for falsification and change flags. Read server evidence first; review judges intent. " +
      "Optional isolation: worktree creates a persistent c2c/<job_id> branch at HEAD (or the isolated dependency tip) and runs in a separate worktree; uncommitted source changes are excluded. Non-git cwd runs in place with a note. Creation failures fail the job. Server commits uncommitted output after evidence; codex_merge integrates passing work.",
    inputSchema: {
      goal: z.string().min(1).describe(`What the code must do when this task is done. ${objectiveBudgetDescription}`),
      constraints: z
        .array(z.string())
        .describe("Only what Codex would get wrong without being told: genuine risks, not a review checklist."),
      success_conditions: z
        .array(z.string())
        .min(1)
        .describe(`Checkable criteria proving the goal is met. At least one must be a runnable command/test; command-based ones should say how they fail when the defect exists. ${objectiveBudgetDescription}`),
      token_budget: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Optional token budget for the Codex goal loop (thread/goal/set tokenBudget)."),
      cwd: z.string().optional().describe("Working directory for Codex. Defaults to the project directory."),
      isolation: z.enum(["worktree"]).optional().describe("Opt in to a persistent <C2C_STATE_DIR>/worktrees/<job_id> at HEAD, branch c2c/<job_id>, matching the cwd subdirectory. Defaults to in-place execution with no isolation metadata. Records target_branch (null for detached source); isolated dependencies supply the branch tip and target. Rework reuses the worktree; use codex_merge to integrate or discard."),
      context_files: contextFiles.optional().describe("Files or directories Codex should read before implementing."),
      ...verificationInputs,
      depends_on: z.string().min(1).optional().describe("Job id of a prior job that must succeed before this job starts."),
      reasoning_effort: reasoningEffort.optional().describe("Optional Codex reasoning effort; omitted uses the Codex default."),
    },
  },
  async (input) => {
    const jobConfig = config(input.cwd);
    const resolvedContext = await resolveContextFiles(input.context_files, jobConfig.cwd);
    if (resolvedContext.missing.length) return missingContextFiles(resolvedContext.missing);
    const contract: GoalContract = {
      goal: input.goal,
      constraints: input.constraints,
      success_conditions: input.success_conditions,
      context_files: resolvedContext.files,
      verify_commands: input.verify_commands,
      setup_commands: input.setup_commands,
      test_paths: input.test_paths,
      scope: input.scope,
    };
    const prompt = renderGoalContract(contract);
    const dependencyError = dependencyValidationError(input.depends_on);
    if (dependencyError) return textResult({ error: dependencyError }, true);
    const renderedObjective = renderObjectiveDetails(contract, OBJECTIVE_MAX);
    if (renderedObjective.objectiveChars > OBJECTIVE_MAX) {
      return textResult({
        error:
          `Rendered objective is ${renderedObjective.objectiveChars} characters, exceeding the ` +
          `GOAL_OBJECTIVE_MAX limit of ${OBJECTIVE_MAX}. Shorten goal or success_conditions, or raise ` +
          "GOAL_OBJECTIVE_MAX.",
      }, true);
    }
    const job = startJob({
      kind: "implement",
      isolation: input.isolation,
      prompt,
      objective: renderedObjective.objective,
      tokenBudget: input.token_budget,
      contextFiles: resolvedContext.files?.map((file) => file.path),
      verify_commands: input.verify_commands,
      setup_commands: input.setup_commands,
      test_paths: input.test_paths,
      scope: input.scope,
      dependsOn: input.depends_on,
      config: jobConfig,
      reasoningEffort: input.reasoning_effort,
      onProgress: progressReporter(),
    });
    return textResult({
      job_id: job.id,
      state: job.state,
      note: job.state === "blocked"
        ? `Job blocked on dependency ${job.dependsOn}. Poll codex_status for its state.`
        : job.state === "queued"
          ? "Job queued. Poll codex_status for its queue position and state."
          : "Job started. Poll codex_status until state is 'done', then call codex_result.",
    });
  },
);

server.registerTool(
  "codex_estimate",
  {
    title: "Estimate a Goal Contract's token cost",
    description:
      "Read-only estimate made before starting a job. Measures the fully rendered Goal Contract prompt and " +
      "returns approx_prompt_tokens using an approximate characters/4 heuristic, plus local completed-job history. Includes verify_commands, setup_commands, test_paths and scope in the prompt estimate.",
    inputSchema: {
      goal: z.string().min(1).describe(`What the code must do when this task is done. ${objectiveBudgetDescription}`),
      constraints: z
        .array(z.string())
        .describe("Only what Codex would get wrong without being told: genuine risks, not a review checklist."),
      success_conditions: z
        .array(z.string())
        .min(1)
        .describe(`Checkable criteria proving the goal is met. At least one must be a runnable command/test; command-based ones should say how they fail when the defect exists. ${objectiveBudgetDescription}`),
      cwd: z.string().optional().describe("Working directory used to resolve relative context_files paths. Defaults to the project directory."),
      context_files: contextFiles.optional().describe("Files or directories included in the rendered prompt."),
      ...verificationInputs,
    },
    annotations: { readOnlyHint: true },
  },
  async (input) => {
    const jobConfig = config(input.cwd);
    const resolvedContext = await resolveContextFiles(input.context_files, jobConfig.cwd);
    if (resolvedContext.missing.length) return missingContextFiles(resolvedContext.missing);
    const contract: GoalContract = {
      goal: input.goal,
      constraints: input.constraints,
      success_conditions: input.success_conditions,
      context_files: resolvedContext.files,
      verify_commands: input.verify_commands,
      setup_commands: input.setup_commands,
      test_paths: input.test_paths,
      scope: input.scope,
    };
    const prompt = renderGoalContract(contract);
    const renderedObjective = renderObjectiveDetails(contract, OBJECTIVE_MAX);
    const history = implementHistory();
    return textResult({
      prompt_chars: prompt.length,
      approx_prompt_tokens: Math.ceil(prompt.length / 4),
      objective_chars: renderedObjective.objectiveChars,
      objective_max_chars: OBJECTIVE_MAX,
      objective_over_limit: renderedObjective.objectiveChars > OBJECTIVE_MAX,
      history,
      estimated_total_tokens: history?.median_total_tokens ?? null,
      note: history
        ? "Estimated total tokens are based on local history and vary with task complexity."
        : "No completed implement job history is available; estimates based on local history vary with task complexity.",
    });
  },
);

server.registerTool(
  "codex_rework",
  {
    title: "Send a Delta Contract to Codex",
    description:
      "Resume the Codex thread from a previous implement job and hand it a Delta Contract " +
      "(review findings + failed success conditions). The existing thread goal is reactivated, so the " +
      "/goal loop continues until the objective passes. Returns a new job_id. Inherits verify_commands and " +
      "setup_commands, test_paths and scope from the known parent unless overridden (use [] to clear); read its own evidence first, then review intent. " +
      "Isolated jobs reuse the same persistent worktree, branch, base commit and cwd (overriding cwd), by job_id or known thread_id, including after restart. Missing worktrees after merge cleanup/discard and worktrees being merged are rejected at submission.",
    inputSchema: {
      job_id: z
        .string()
        .optional()
        .describe("The original implement job's id (preferred; resolves the thread to resume)."),
      thread_id: z.string().optional().describe("Codex thread id, if the job registry is gone (e.g. after a restart)."),
      findings: z.array(z.string()).min(1).describe("What is wrong, with file/line references."),
      failed_conditions: z
        .array(z.string())
        .describe("The specific Success Conditions from the original contract that did not pass."),
      constraints: z.array(z.string()).optional().describe("Additional constraints beyond the originals."),
      cwd: z.string().optional().describe("Working directory for Codex. Defaults to the project directory."),
      context_files: contextFiles.optional().describe("Files or directories Codex should read before implementing."),
      ...verificationInputs,
      reasoning_effort: reasoningEffort.optional().describe("Optional Codex reasoning effort; omitted uses the Codex default."),
    },
  },
  async (input) => {
    let threadId = input.thread_id;
    const prev = input.job_id ? getJob(input.job_id) : threadId
      ? listJobs().filter((job) => job.threadId === threadId)
        .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0]
      : undefined;
    const jobConfig = config(prev?.isolation ? prev.isolationCwd : input.cwd);
    const resolvedContext = await resolveContextFiles(input.context_files, jobConfig.cwd);
    if (resolvedContext.missing.length) return missingContextFiles(resolvedContext.missing);
    if (!threadId && input.job_id && !prev) return textResult({ error: `unknown job_id ${input.job_id}` }, true);
    const verifyCommands = input.verify_commands ?? prev?.verify_commands;
    const setupCommands = input.setup_commands ?? prev?.setup_commands;
    const testPaths = input.test_paths ?? prev?.test_paths;
    const scope = input.scope ?? prev?.scope;
    if (!threadId && input.job_id) {
      threadId = prev?.threadId;
    }
    if (!threadId) {
      return textResult({ error: "provide job_id (of the implement job) or thread_id" }, true);
    }
    const job = startJob({
      kind: "rework",
      prompt: renderDeltaContract({
        findings: input.findings,
        failed_conditions: input.failed_conditions,
        constraints: input.constraints,
        context_files: resolvedContext.files,
        verify_commands: verifyCommands,
        setup_commands: setupCommands,
        test_paths: testPaths,
        scope,
      }),
      resumeThreadId: threadId,
      parentJobId: input.job_id ?? prev?.id,
      contextFiles: resolvedContext.files?.map((file) => file.path),
      verify_commands: verifyCommands,
      setup_commands: setupCommands,
      test_paths: testPaths,
      scope,
      config: jobConfig,
      reasoningEffort: input.reasoning_effort,
      onProgress: progressReporter(),
    });
    return textResult({
      job_id: job.id,
      resumed_thread_id: threadId,
      state: job.state,
      note: job.state === "queued"
        ? "Rework job queued. Poll codex_status for its queue position and state."
        : "Rework job started. Poll codex_status until state is 'done', then call codex_result.",
    });
  },
);

server.registerTool(
  "codex_merge",
  {
    title: "Merge or discard an isolated job",
    description: "Serially integrate the latest job on the requested worktree lineage. Requires done, no active/pending jobs on the worktree, and evidence.passed=true. Merges with --no-ff in a temporary worktree, re-runs setup + verify, then fast-forwards target_branch. Returns merged, conflict (files), verification_failed (evidence), target_blocked, or refused. Failures preserve target and job trees. cleanup defaults to true: remove job worktree and branch after merging; discard=true removes them without merging. Status/result expose the latest merge record; each attempt logs kind=merge. Cleanup/discard prevents further rework.",
    inputSchema: {
      job_id: z.string().min(1).describe("Any job id in the isolated worktree lineage; resolves its latest job."),
      cleanup: z.boolean().default(true).describe("Remove job worktree and branch after a successful merge."),
      discard: z.boolean().optional().describe("Remove job worktree and branch without merging. Works for failed work too: needs no passing evidence, only that nothing is active or pending on the worktree."),
    },
  },
  async (input) => {
    try {
      const merge = await mergeJob(input.job_id, { cleanup: input.cleanup, discard: input.discard, timeoutMs: config().verifyTimeoutMs });
      return textResult(merge, merge.status === "refused");
    } catch (error) {
      return textResult({ error: String(error instanceof Error ? error.message : error) }, true);
    }
  },
);

server.registerTool(
  "codex_config",
  {
    title: "Read current Codex configuration",
    description: "Read-only view of the Codex CLI model, default reasoning effort, version, and current configuration.",
    inputSchema: {
      cwd: z.string().optional().describe("Directory whose Codex configuration should be resolved."),
    },
    annotations: { readOnlyHint: true },
  },
  async (input) => textResult(await readCodexConfig(config(input.cwd))),
);

server.registerTool(
  "codex_status",
  {
    title: "Check a Codex job",
    description:
      "Status of a blocked, queued, running, or finished Codex job: dependency, state, queue position, thread id, " +
      "parent_job_id, root_job_id, rework_round, goal state (status/tokens), turn count, server verification evidence, and a tail of the activity transcript. " +
      "Opt-in isolation metadata includes mode, worktree_path, branch, base_commit, target_branch, source_dirty and note; absent for default jobs. Includes the latest merge attempt when present.",
    inputSchema: {
      job_id: z.string().describe("Job id returned by codex_implement or codex_rework."),
    },
  },
  async (input) => {
    const job = getJob(input.job_id);
    if (!job) return textResult({ error: `unknown job_id ${input.job_id}` }, true);
    return textResult(jobSummary(job));
  },
);

server.registerTool(
  "codex_result",
  {
    title: "Fetch a finished Codex job's handoff",
    description:
      "Final result of a finished job: Codex's final message, the parsed structured handoff " +
      "(Changed Files / Validation / Success Conditions / Risks & Deviations — a missing section is " +
      "itself a review failure), server verification evidence (including falsification.unfalsified and changes.tests_modified / out_of_scope / new_unclassified), and final goal state. Read evidence first for " +
      "mechanical pass/fail; review judges intent and constraints. Includes parent_job_id, root_job_id and rework_round. " +
      "Opt-in isolation metadata includes mode, worktree_path, branch, base_commit, target_branch, source_dirty and note; evidence includes committed branch changes against that base. Includes the latest merge attempt when present. Errors if the job is not finished.",
    inputSchema: {
      job_id: z.string().describe("Job id returned by codex_implement or codex_rework."),
    },
  },
  async (input) => {
    const job = getJob(input.job_id);
    if (!job) return textResult({ error: `unknown job_id ${input.job_id}` }, true);
    if (job.state === "blocked" || job.state === "queued" || job.state === "starting" || job.state === "running") {
      return textResult({ error: `job ${job.id} is still ${job.state}; poll codex_status` }, true);
    }
    return textResult({
      ...jobSummary(job, 5),
      final_message: job.finalMessage ?? null,
      handoff: job.handoff ?? null,
    });
  },
);

server.registerPrompt("c2c-workflow", {
  description: "Delegate implementation to Codex via Goal Contracts. Draft, send, poll, review, rework.",
}, () => ({
  messages: [{
    role: "user" as const,
    content: { type: "text" as const, text: `
You are the **architect and reviewer**. Codex is the **implementer**. You draft contracts, delegate via the \`codex_*\` tools, and review the output. You do not implement the task yourself.

## Workflow

1. **User decides** what to build or fix.
2. **You draft a Goal Contract** (format below), declaring test_paths for tests (including new tests) and scope for allowed production changes as git glob pathspecs relative to the job cwd. Show it to the user for approval.
3. **You send it** — \`codex_estimate\` to check budget, then \`codex_implement\`. Pass verification commands as \`verify_commands\`, dependency setup as \`setup_commands\`, and the declared \`test_paths\` and \`scope\`.
4. **You poll** — \`codex_status\` until terminal. Report progress to the user.
5. **You review** — \`codex_result\`: read evidence first, then the handoff. Review judges intent (see Review below).
6. **User approves** your findings.

If review fails → draft a **Delta Contract** → \`codex_rework\` (same \`job_id\`, thread resumes) → re-enter at step 4.

## Goal Contract

\`\`\`
### Goal
What the code must do. First sentence = acceptance test in prose.

### Constraints
Only what Codex would get wrong without being told. One line of
"only modify files needed for this task" covers the rest.

### Success Conditions
- [ ] Assertions, not paragraphs. At least one is a command whose exit code decides.
- [ ] Command-based conditions must be falsifiable: describe how they fail when the defect exists. Subjective criteria should be marked as needing reviewer judgment.
\`\`\`

**Write lean contracts.** Goal and Success Conditions are what Codex acts on. Constraints are for genuine risks only — don't front-load your review checklist into the contract.

## Delta Contract

\`\`\`
### Findings
- What is wrong, with file/line references.

### Failed Success Conditions
- [ ] The specific conditions that did not pass.

### Constraints
- Original constraints still apply. Fix only the findings; do not touch work that passed.
\`\`\`

## Review

1. Read server evidence first: \`verify_commands\` are re-run in a clean working-tree snapshot after Codex exits. Evidence decides mechanical pass/fail, regardless of the handoff's claims. If evidence is null, run the checks independently.
2. Review judges intent: inspect whether the changes meet the goal and constraints. Handoff must be complete (all four sections); missing handoff = review failure.
3. Read \`evidence.falsification.unfalsified\`: after passing verification the server reverts production changes to HEAD, keeps declared test changes, and re-runs checks. Review skipped_reason if it did not run. Read \`evidence.changes.tests_modified\`, \`out_of_scope\` and \`new_unclassified\` for test edits/deletions and undeclared changes. Flags do not change evidence.passed or job state. Verify falsifiability: each command-based success condition must fail when the defect is present. A check that passes regardless is a review failure.
4. Include the project's own typecheck/build/test/lint in \`verify_commands\`; use \`setup_commands\` for dependencies (ignored files are absent from the snapshot).
5. Flag security issues and constraint violations.
6. Report findings to the user. Fix small issues (typos, imports, test gaps found by your own falsifiability check) directly; do not rewrite the implementation.
` },
  }],
}));

const transport = new StdioServerTransport();
await server.connect(transport);
