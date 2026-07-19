import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { renderGoalContract } from "../src/contracts.ts";

const mcpDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function payload(result: any) {
  return JSON.parse(result.content[0].text);
}

async function connect(stateDir: string, extraEnv: Record<string, string> = {}) {
  let stderr = "";
  const transport = new StdioClientTransport({
    command: "bun",
    args: [join(mcpDir, "src", "server.ts")],
    cwd: mcpDir,
    stderr: "pipe",
    env: {
      ...(process.env as Record<string, string>),
      C2C_STATE_DIR: stateDir,
      C2C_LOG_LEVEL: "info",
      CODEX_BIN: "codex-must-not-spawn-during-estimate",
      ...extraEnv,
    },
  });
  transport.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
  const client = new Client({ name: "estimate", version: "1" });
  await client.connect(transport);
  return { client, stderr: () => stderr };
}

async function waitForDone(client: Client, jobId: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const status = payload(await client.callTool({
      name: "codex_status",
      arguments: { job_id: jobId },
    }));
    if (status.state === "done") return status;
    if (["error", "timeout"].includes(status.state)) throw new Error(`job ended in ${status.state}`);
    await Bun.sleep(20);
  }
  throw new Error(`job ${jobId} did not finish`);
}

test("estimate without history measures the rendered prompt and has no side effects", async () => {
  const root = mkdtempSync(join(tmpdir(), "c2c-estimate-empty-"));
  dirs.push(root);
  const stateDir = join(root, "state");
  const workspace = join(root, "workspace");
  mkdirSync(stateDir);
  mkdirSync(workspace);
  writeFileSync(join(workspace, "AGENTS.md"), "PROJECT ESTIMATE INSTRUCTION");
  const input = {
    goal: "Estimate this task",
    constraints: ["Keep it small"],
    success_conditions: ["Tests pass"],
    cwd: workspace,
  };
  const expectedPrompt = await renderGoalContract(input, workspace);
  const { client, stderr } = await connect(stateDir);

  try {
    const tools = await client.listTools();
    const tool = tools.tools.find((candidate) => candidate.name === "codex_estimate");
    expect(tool?.annotations?.readOnlyHint).toBe(true);

    const before = readdirSync(stateDir);
    const result: any = await client.callTool({ name: "codex_estimate", arguments: input });
    expect(result.isError ?? false).toBe(false);
    expect(payload(result)).toEqual({
      prompt_chars: expectedPrompt.length,
      approx_prompt_tokens: Math.ceil(expectedPrompt.length / 4),
      history: null,
      estimated_total_tokens: null,
      note: expect.any(String),
    });
    expect(payload(result).note).toContain("No completed implement job history");
    expect(readdirSync(stateDir)).toEqual(before);
    expect(stderr()).not.toContain("codex_process_spawn");
  } finally {
    await client.close();
  }
});

test("estimate uses statistics from completed implement jobs only", async () => {
  const root = mkdtempSync(join(tmpdir(), "c2c-estimate-history-"));
  dirs.push(root);
  const stateDir = join(root, "state");
  const workspace = join(root, "workspace");
  mkdirSync(stateDir);
  mkdirSync(workspace);
  writeFileSync(join(workspace, "AGENTS.md"), "HISTORY PROJECT INSTRUCTION");
  writeFileSync(join(workspace, "reference.md"), "reference material");
  const { client } = await connect(stateDir, {
    CODEX_BIN: "bun",
    CODEX_ARGS: join(mcpDir, "test", "multi-job-codex.ts"),
    CODEX_QUIET_MS: "20",
    CODEX_JOB_TIMEOUT_MS: "5000",
    C2C_MAX_CONCURRENT: "5",
    MULTI_JOB_DELAY_MS: "20",
  });

  try {
    const totals = [100, 200, 400, 800, 1600];
    const jobs = await Promise.all(totals.map(async (total) => payload(await client.callTool({
      name: "codex_implement",
      arguments: {
        goal: `tokens-${total}`,
        constraints: [],
        success_conditions: ["done"],
        cwd: workspace,
      },
    }))));
    await Promise.all(jobs.map((job) => waitForDone(client, job.job_id)));

    const rework = payload(await client.callTool({
      name: "codex_rework",
      arguments: {
        job_id: jobs[0].job_id,
        findings: ["recheck"],
        failed_conditions: ["done"],
        cwd: workspace,
      },
    }));
    expect((await waitForDone(client, rework.job_id)).usage.totalTokens).toBe(9999);

    const input = {
      goal: "Estimate with context",
      constraints: ["Keep it focused"],
      success_conditions: ["Validation passes"],
      context_files: [{ path: "reference.md", note: "Required input" }],
      cwd: workspace,
    };
    const expectedPrompt = await renderGoalContract({
      ...input,
      context_files: [{ path: join(workspace, "reference.md"), note: "Required input" }],
    }, workspace);
    const result: any = await client.callTool({ name: "codex_estimate", arguments: input });

    expect(result.isError ?? false).toBe(false);
    expect(payload(result)).toEqual({
      prompt_chars: expectedPrompt.length,
      approx_prompt_tokens: Math.ceil(expectedPrompt.length / 4),
      history: {
        samples: 5,
        median_total_tokens: 400,
        p90_total_tokens: 1600,
        mean_total_tokens: 620,
      },
      estimated_total_tokens: 400,
      note: expect.any(String),
    });
    expect(payload(result).note).toContain("local history");
    expect(payload(result).note).toContain("task complexity");
  } finally {
    await client.close();
  }
}, 20_000);

test("estimate rejects every missing context path without creating state", async () => {
  const root = mkdtempSync(join(tmpdir(), "c2c-estimate-missing-"));
  dirs.push(root);
  const stateDir = join(root, "state");
  const workspace = join(root, "workspace");
  mkdirSync(stateDir);
  mkdirSync(workspace);
  writeFileSync(join(workspace, "exists.md"), "available");
  const missing = [join(workspace, "missing-a.md"), join(workspace, "missing-b")];
  const { client, stderr } = await connect(stateDir);

  try {
    const before = readdirSync(stateDir);
    const result: any = await client.callTool({
      name: "codex_estimate",
      arguments: {
        goal: "Should not estimate",
        constraints: [],
        success_conditions: ["done"],
        cwd: workspace,
        context_files: [
          { path: "exists.md" },
          { path: "missing-a.md" },
          { path: "missing-b" },
        ],
      },
    });

    expect(result.isError).toBe(true);
    expect(payload(result).error).toContain(missing[0]);
    expect(payload(result).error).toContain(missing[1]);
    expect(readdirSync(stateDir)).toEqual(before);
    expect(stderr()).not.toContain("codex_process_spawn");
  } finally {
    await client.close();
  }
});
