// MCP server: Claude (architect/reviewer) delegates implementation to Codex
// (implementer) through typed Goal/Delta Contract tools. Codex runs each
// contract under its thread-goal loop (`/goal`) until the objective is met.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  renderGoalContract,
  renderDeltaContract,
  renderObjective,
  type GoalContract,
} from "./contracts.ts";
import { startJob, getJob, type Job, type JobConfig } from "./jobs.ts";
import { readCodexConfig } from "./config.ts";

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v ? Number.parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function config(cwd?: string): JobConfig {
  return {
    bin: process.env.CODEX_BIN ?? "codex",
    args: (process.env.CODEX_ARGS ?? "app-server").split(" ").filter(Boolean),
    cwd: cwd ?? process.env.CODEX_CWD ?? process.cwd(),
    model: process.env.CODEX_MODEL || undefined,
    approvalPolicy: process.env.CODEX_APPROVAL_POLICY ?? "never",
    permissions: process.env.CODEX_PERMISSIONS || undefined,
    jobTimeoutMs: envInt("CODEX_JOB_TIMEOUT_MS", 1_800_000),
    quietMs: envInt("CODEX_QUIET_MS", 30_000),
    retries: Math.max(0, envInt("C2C_RETRIES", 1)),
  };
}

const OBJECTIVE_MAX = envInt("GOAL_OBJECTIVE_MAX", 2000);

function jobSummary(job: Job, transcriptTail = 15) {
  return {
    job_id: job.id,
    kind: job.kind,
    state: job.state,
    thread_id: job.threadId ?? null,
    goal: job.goal ?? null,
    usage: job.usage ?? {},
    attempts: job.attempts ?? 1,
    turns: job.turns,
    started_at: job.startedAt,
    ended_at: job.endedAt ?? null,
    error: job.error ?? null,
    transcript_tail: job.transcript.slice(-transcriptTail),
  };
}

function textResult(obj: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }],
    isError,
  };
}

const server = new McpServer({ name: "c2c-codex", version: "0.1.0" });
const reasoningEffort = z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]);

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
      "contract's Success Conditions, not from this server.",
    inputSchema: {
      goal: z.string().min(1).describe("What the code must do when this task is done."),
      constraints: z
        .array(z.string())
        .describe("Technical boundaries: files to touch, patterns to follow, 'Do not modify' lists."),
      success_conditions: z
        .array(z.string())
        .min(1)
        .describe("Checkable criteria proving the goal is met. At least one must be a runnable command/test."),
      token_budget: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Optional token budget for the Codex goal loop (thread/goal/set tokenBudget)."),
      cwd: z.string().optional().describe("Working directory for Codex. Defaults to the project directory."),
      reasoning_effort: reasoningEffort.optional().describe("Optional Codex reasoning effort; omitted uses the Codex default."),
    },
  },
  async (input) => {
    const contract: GoalContract = {
      goal: input.goal,
      constraints: input.constraints,
      success_conditions: input.success_conditions,
    };
    const jobConfig = config(input.cwd);
    const job = startJob({
      kind: "implement",
      prompt: await renderGoalContract(contract, jobConfig.cwd),
      objective: renderObjective(contract, OBJECTIVE_MAX),
      tokenBudget: input.token_budget,
      config: jobConfig,
      reasoningEffort: input.reasoning_effort,
      onProgress: progressReporter(),
    });
    return textResult({
      job_id: job.id,
      state: job.state,
      note: "Job started. Poll codex_status until state is 'done', then call codex_result.",
    });
  },
);

server.registerTool(
  "codex_rework",
  {
    title: "Send a Delta Contract to Codex",
    description:
      "Resume the Codex thread from a previous implement job and hand it a Delta Contract " +
      "(review findings + failed success conditions). The existing thread goal re-engages, so the " +
      "/goal loop continues until the objective passes. Returns a new job_id.",
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
      reasoning_effort: reasoningEffort.optional().describe("Optional Codex reasoning effort; omitted uses the Codex default."),
    },
  },
  async (input) => {
    let threadId = input.thread_id;
    if (!threadId && input.job_id) {
      const prev = getJob(input.job_id);
      if (!prev) return textResult({ error: `unknown job_id ${input.job_id}` }, true);
      threadId = prev.threadId;
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
      }),
      resumeThreadId: threadId,
      config: config(input.cwd),
      reasoningEffort: input.reasoning_effort,
      onProgress: progressReporter(),
    });
    return textResult({
      job_id: job.id,
      resumed_thread_id: threadId,
      state: job.state,
      note: "Rework job started. Poll codex_status until state is 'done', then call codex_result.",
    });
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
      "Status of a running or finished Codex job: state, thread id, goal state (status/tokens), " +
      "turn count, and a tail of the activity transcript.",
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
      "itself a review failure), and final goal state. Errors if the job is still running.",
    inputSchema: {
      job_id: z.string().describe("Job id returned by codex_implement or codex_rework."),
    },
  },
  async (input) => {
    const job = getJob(input.job_id);
    if (!job) return textResult({ error: `unknown job_id ${input.job_id}` }, true);
    if (job.state === "starting" || job.state === "running") {
      return textResult({ error: `job ${job.id} is still ${job.state}; poll codex_status` }, true);
    }
    return textResult({
      ...jobSummary(job, 5),
      final_message: job.finalMessage ?? null,
      handoff: job.handoff ?? null,
    });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
