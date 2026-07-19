// End-to-end: spawns the MCP server over stdio (with the mock codex
// app-server behind it) and drives implement → status → result → rework.

import { test, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ProgressNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const mcpDir = join(dirname(fileURLToPath(import.meta.url)), "..");

function parsePayload(result: any): any {
  expect(result.isError ?? false).toBe(false);
  return JSON.parse(result.content[0].text);
}

async function pollUntilDone(client: Client, jobId: string, timeoutMs = 15_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = parsePayload(
      await client.callTool({ name: "codex_status", arguments: { job_id: jobId } }),
    );
    if (status.state !== "starting" && status.state !== "running") return status;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`job ${jobId} did not finish within ${timeoutMs}ms`);
}

test("implement → goal loop → handoff, then rework resumes the thread", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "c2c-e2e-"));
  const stateDir = join(tempDir, "state");
  const workspaceDir = join(tempDir, "workspace");
  const reference = join(workspaceDir, "reference.md");
  const examples = join(workspaceDir, "examples");
  mkdirSync(stateDir);
  mkdirSync(workspaceDir);
  mkdirSync(examples);
  writeFileSync(reference, "reference material");
  const transport = new StdioClientTransport({
    command: "bun",
    args: [join(mcpDir, "src", "server.ts")],
    cwd: mcpDir,
    env: {
      ...(process.env as Record<string, string>),
      CODEX_BIN: "bun",
      CODEX_ARGS: join(mcpDir, "test", "mock-codex.ts"),
      CODEX_QUIET_MS: "500",
      CODEX_JOB_TIMEOUT_MS: "10000",
      EXPECT_REASONING_EFFORT: "high",
      EXPECT_CONTEXT_PATHS: JSON.stringify([reference, examples]),
      C2C_STATE_DIR: stateDir,
    },
  });
  const client = new Client({ name: "e2e", version: "0.0.1" });
  await client.connect(transport);

  try {
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      "codex_config",
      "codex_estimate",
      "codex_implement",
      "codex_result",
      "codex_rework",
      "codex_status",
    ]);

    const currentConfig = parsePayload(await client.callTool({ name: "codex_config", arguments: {} }));
    expect(currentConfig.model).toBe("gpt-mock");
    expect(currentConfig.version).toBe("mock-codex/0.0.1");

    const progress: any[] = [];
    client.setNotificationHandler(ProgressNotificationSchema, (notification) => {
      progress.push(notification.params);
    });

    // --- implement ---
    const started = parsePayload(
      await client.callTool({
        name: "codex_implement",
        arguments: {
          goal: "Add the thing",
          constraints: ["Do not modify docs/"],
          success_conditions: ["The thing exists — verified by the project's test command"],
          context_files: [
            { path: "reference.md", note: "Defines the expected behavior" },
            { path: "examples", note: "Contains representative inputs" },
          ],
          token_budget: 50000,
          cwd: workspaceDir,
          reasoning_effort: "high",
        },
      }),
    );
    expect(started.job_id).toBeTruthy();

    const status = await pollUntilDone(client, started.job_id);
    expect(status.state).toBe("done");
    expect(status.thread_id).toBe("thr_mock_1");
    expect(status.goal.status).toBe("complete");
    expect(status.usage).toEqual({ inputTokens: 20, outputTokens: 600, totalTokens: 1234 });
    expect(status.attempts).toBe(1);
    expect(status.turns).toBe(2); // initial turn + one goal continuation
    expect(status.context_files).toEqual([reference, examples]);
    expect(JSON.parse(readFileSync(join(stateDir, `${started.job_id}.json`), "utf8")).contextFiles)
      .toEqual([reference, examples]);
    expect(progress.some((event) => event.message?.includes("turn_started"))).toBe(true);
    expect(progress.some((event) => event.message?.includes("goal_updated"))).toBe(true);
    expect(progress.some((event) => event.message?.includes("agent_message"))).toBe(true);
    expect(progress.some((event) => event.message?.includes("turn_ended"))).toBe(true);

    const result = parsePayload(
      await client.callTool({ name: "codex_result", arguments: { job_id: started.job_id } }),
    );
    expect(result.final_message).toContain("### Changed Files");
    expect(result.handoff.valid).toBe(true);
    expect(result.handoff.missing).toEqual([]);
    expect(result.handoff.sections["Risks & Deviations"]).toContain("none");
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 600, totalTokens: 1234 });
    expect(result.context_files).toEqual([reference, examples]);

    // --- rework ---
    const rework = parsePayload(
      await client.callTool({
        name: "codex_rework",
        arguments: {
          job_id: started.job_id,
          findings: ["thing.ts:12 — edge case unhandled"],
          failed_conditions: ["The thing exists — verified by the project's test command"],
          context_files: [
            { path: "reference.md", note: "Defines the expected behavior" },
            { path: "examples", note: "Contains representative inputs" },
          ],
          cwd: workspaceDir,
          reasoning_effort: "high",
        },
      }),
    );
    expect(rework.resumed_thread_id).toBe("thr_mock_1");

    const reworkStatus = await pollUntilDone(client, rework.job_id);
    expect(reworkStatus.state).toBe("done");
    expect(reworkStatus.context_files).toEqual([reference, examples]);

    const reworkResult = parsePayload(
      await client.callTool({ name: "codex_result", arguments: { job_id: rework.job_id } }),
    );
    expect(reworkResult.handoff.valid).toBe(true);
    expect(reworkResult.context_files).toEqual([reference, examples]);
  } finally {
    await client.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}, 30_000);

test("missing context files reject implement and rework before creating jobs", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "c2c-context-validation-"));
  const stateDir = join(tempDir, "state");
  const workspaceDir = join(tempDir, "workspace");
  mkdirSync(stateDir);
  mkdirSync(workspaceDir);
  writeFileSync(join(workspaceDir, "exists.md"), "available reference");
  const missing = [join(workspaceDir, "missing-a.md"), join(workspaceDir, "missing-b")];
  const transport = new StdioClientTransport({
    command: "bun",
    args: [join(mcpDir, "src", "server.ts")],
    cwd: mcpDir,
    env: {
      ...(process.env as Record<string, string>),
      CODEX_BIN: "bun",
      CODEX_ARGS: join(mcpDir, "test", "mock-codex.ts"),
      C2C_STATE_DIR: stateDir,
    },
  });
  const client = new Client({ name: "context-validation", version: "0.0.1" });
  await client.connect(transport);

  try {
    const initialJobs = readdirSync(stateDir);
    const implement: any = await client.callTool({
      name: "codex_implement",
      arguments: {
        goal: "Should not start",
        constraints: [],
        success_conditions: ["done"],
        cwd: workspaceDir,
        context_files: [
          { path: "exists.md" },
          { path: "missing-a.md" },
          { path: "missing-b" },
        ],
      },
    });
    expect(implement.isError).toBe(true);
    const implementPayload = JSON.parse(implement.content[0].text);
    expect(implementPayload.job_id).toBeUndefined();
    expect(implementPayload.error).toContain(missing[0]);
    expect(implementPayload.error).toContain(missing[1]);
    expect(readdirSync(stateDir)).toEqual(initialJobs);

    const rework: any = await client.callTool({
      name: "codex_rework",
      arguments: {
        thread_id: "thr_mock_1",
        findings: ["Needs rework"],
        failed_conditions: ["done"],
        cwd: workspaceDir,
        context_files: [{ path: "missing-a.md" }, { path: "missing-b" }],
      },
    });
    expect(rework.isError).toBe(true);
    const reworkPayload = JSON.parse(rework.content[0].text);
    expect(reworkPayload.job_id).toBeUndefined();
    expect(reworkPayload.error).toContain(missing[0]);
    expect(reworkPayload.error).toContain(missing[1]);
    expect(readdirSync(stateDir)).toEqual(initialJobs);

    const unknown: any = await client.callTool({
      name: "codex_status",
      arguments: { job_id: "missing-context-job" },
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0].text).toContain("unknown job_id missing-context-job");
  } finally {
    await client.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("codex_result on unknown job errors cleanly", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "c2c-e2e-"));
  const transport = new StdioClientTransport({
    command: "bun",
    args: [join(mcpDir, "src", "server.ts")],
    cwd: mcpDir,
    env: {
      ...(process.env as Record<string, string>),
      CODEX_BIN: "bun",
      CODEX_ARGS: join(mcpDir, "test", "mock-codex.ts"),
      EXPECT_REASONING_ABSENT: "1",
      C2C_STATE_DIR: stateDir,
    },
  });
  const client = new Client({ name: "e2e2", version: "0.0.1" });
  await client.connect(transport);
  try {
    const res: any = await client.callTool({ name: "codex_result", arguments: { job_id: "nope" } });
    expect(res.isError).toBe(true);
    const started = parsePayload(await client.callTool({
      name: "codex_implement",
      arguments: { goal: "Default effort", constraints: [], success_conditions: ["done"] },
    }));
    expect((await pollUntilDone(client, started.job_id)).state).toBe("done");
  } finally {
    await client.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
