import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const mcpDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function payload(result: any) {
  return JSON.parse(result.content[0].text);
}

async function connect(env: Record<string, string>) {
  const transport = new StdioClientTransport({
    command: "bun", args: [join(mcpDir, "src", "server.ts")], cwd: mcpDir,
    env: { ...(process.env as Record<string, string>), ...env },
  });
  const client = new Client({ name: "robustness", version: "1" });
  await client.connect(transport);
  return client;
}

async function wait(client: Client, id: string, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const status = payload(await client.callTool({ name: "codex_status", arguments: { job_id: id } }));
    if (status.state !== "starting" && status.state !== "running") return status;
    await Bun.sleep(25);
  }
  throw new Error("job did not finish");
}

const contract = { goal: "test", constraints: [], success_conditions: ["done"] };

test("a mid-turn crash includes stderr and the next job succeeds", async () => {
  const state = mkdtempSync(join(tmpdir(), "c2c-crash-state-"));
  const scratch = mkdtempSync(join(tmpdir(), "c2c-crash-marker-"));
  dirs.push(state, scratch);
  const client = await connect({
    C2C_STATE_DIR: state, CODEX_BIN: "bun", CODEX_ARGS: join(mcpDir, "test", "crash-codex.ts"),
    CRASH_MARKER: join(scratch, "marker"), CODEX_JOB_TIMEOUT_MS: "30000", CODEX_QUIET_MS: "100",
  });
  try {
    const first = payload(await client.callTool({ name: "codex_implement", arguments: contract }));
    const failed = await wait(client, first.job_id);
    expect(failed.state).toBe("error");
    expect(failed.error).toContain("fatal mock crash diagnostic");

    const second = payload(await client.callTool({ name: "codex_implement", arguments: contract }));
    expect((await wait(client, second.job_id)).state).toBe("done");
  } finally {
    await client.close();
  }
});

test("spawn failure finalizes well before the request timeout", async () => {
  const state = mkdtempSync(join(tmpdir(), "c2c-spawn-state-"));
  dirs.push(state);
  const client = await connect({
    C2C_STATE_DIR: state, CODEX_BIN: join(state, "does-not-exist"), CODEX_JOB_TIMEOUT_MS: "30000",
  });
  try {
    const start = Date.now();
    const started = payload(await client.callTool({ name: "codex_implement", arguments: contract }));
    const failed = await wait(client, started.job_id);
    expect(failed.state).toBe("error");
    expect(failed.attempts).toBe(2); // default C2C_RETRIES=1
    expect(Date.now() - start).toBeLessThan(5000);
  } finally {
    await client.close();
  }
});

test("status, result, and rework resolve a persisted job after server restart", async () => {
  const state = mkdtempSync(join(tmpdir(), "c2c-restart-state-"));
  dirs.push(state);
  const env = {
    C2C_STATE_DIR: state, CODEX_BIN: "bun", CODEX_ARGS: join(mcpDir, "test", "mock-codex.ts"),
    CODEX_JOB_TIMEOUT_MS: "10000", CODEX_QUIET_MS: "200",
  };
  const firstClient = await connect(env);
  const started = payload(await firstClient.callTool({ name: "codex_implement", arguments: contract }));
  expect((await wait(firstClient, started.job_id)).state).toBe("done");
  await firstClient.close();

  const restarted = await connect(env);
  try {
    const status = payload(await restarted.callTool({ name: "codex_status", arguments: { job_id: started.job_id } }));
    expect(status.state).toBe("done");
    expect(status.thread_id).toBe("thr_mock_1");
    expect(status.attempts).toBe(1);
    expect(status.usage).toEqual({ inputTokens: 20, outputTokens: 600, totalTokens: 1234 });
    const result = payload(await restarted.callTool({ name: "codex_result", arguments: { job_id: started.job_id } }));
    expect(result.handoff.valid).toBe(true);
    const rework = payload(await restarted.callTool({
      name: "codex_rework",
      arguments: { job_id: started.job_id, findings: ["review finding"], failed_conditions: ["done"] },
    }));
    expect(rework.resumed_thread_id).toBe("thr_mock_1");
    expect((await wait(restarted, rework.job_id)).state).toBe("done");
  } finally {
    await restarted.close();
  }
});

test("an unwritable state path degrades to in-memory jobs", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "c2c-unwritable-"));
  dirs.push(scratch);
  const blockingFile = join(scratch, "not-a-directory");
  writeFileSync(blockingFile, "file");
  const client = await connect({
    C2C_STATE_DIR: join(blockingFile, "jobs"), CODEX_BIN: "bun",
    CODEX_ARGS: join(mcpDir, "test", "crash-codex.ts"), CODEX_QUIET_MS: "100",
  });
  try {
    const started = payload(await client.callTool({ name: "codex_implement", arguments: contract }));
    expect((await wait(client, started.job_id)).state).toBe("done");
    expect(payload(await client.callTool({ name: "codex_result", arguments: { job_id: started.job_id } })).final_message)
      .toBe("healthy result");
  } finally {
    await client.close();
  }
});
