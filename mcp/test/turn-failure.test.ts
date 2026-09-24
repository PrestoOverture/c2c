// A Codex turn that fails upstream (e.g. HTTP 400 for an unsupported model) must
// finalize the job as `error` with the upstream message — not as `done` after the
// quiet timer. Payload shapes in mock-codex.ts mirror codex-cli 0.156.1.

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ProgressNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

const mcpDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const clients: Client[] = [];
const dirs: string[] = [];

// Long enough that the pre-fix path (quiet timer → "done") cannot win the poll below.
const QUIET_MS = 4_000;
const UPSTREAM = "The 'gpt-bogus' model is not supported when using Codex with a ChatGPT account.";

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function payload(result: any) {
  return JSON.parse(result.content[0].text);
}

async function connect(extraEnv: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "c2c-turn-failure-"));
  dirs.push(root);
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const transport = new StdioClientTransport({
    command: "bun",
    args: [join(mcpDir, "src", "server.ts")],
    cwd: mcpDir,
    stderr: "pipe",
    env: {
      ...(process.env as Record<string, string>),
      C2C_STATE_DIR: join(root, "state"),
      C2C_LOG_LEVEL: "silent",
      CODEX_BIN: "bun",
      CODEX_ARGS: join(mcpDir, "test", "mock-codex.ts"),
      CODEX_QUIET_MS: String(QUIET_MS),
      ...extraEnv,
    },
  });
  const client = new Client({ name: "turn-failure", version: "1" });
  await client.connect(transport);
  clients.push(client);
  const events: { event: string; message: string }[] = [];
  client.setNotificationHandler(ProgressNotificationSchema, (n) => {
    events.push(JSON.parse(String(n.params.message)));
  });
  return { client, workspace, events };
}

async function implement(client: Client, cwd: string) {
  return payload(await client.callTool({
    name: "codex_implement",
    arguments: {
      cwd,
      goal: "Add the thing",
      constraints: ["Only modify files needed for this task"],
      success_conditions: ["`mock-test` exits 0"],
    },
  })).job_id as string;
}

async function waitTerminal(client: Client, jobId: string, withinMs: number) {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    const status = payload(await client.callTool({ name: "codex_status", arguments: { job_id: jobId } }));
    if (["done", "error", "timeout"].includes(status.state)) return status;
    await Bun.sleep(50);
  }
  throw new Error(`job ${jobId} not terminal within ${withinMs}ms`);
}

test("a failed turn finalizes the job as error with the unwrapped upstream message, without waiting for the quiet timer", async () => {
  const { client, workspace, events } = await connect({ FAIL_TURN_MESSAGE: UPSTREAM });
  const jobId = await implement(client, workspace);
  const started = Date.now();

  // Pre-fix, the job stays "running" until the quiet timer fires and then reports "done".
  const status = await waitTerminal(client, jobId, QUIET_MS - 1_000);
  expect(Date.now() - started).toBeLessThan(QUIET_MS);
  expect(status.state).toBe("error");
  expect(status.error).toBe(`Codex turn failed: ${UPSTREAM} (HTTP 400)`);
  expect(status.attempts).toBe(1); // failed after turn/started → never retried
  expect(status.transcript_tail.some((t: any) => t.kind === "error" && t.detail.includes(UPSTREAM))).toBe(true);
  expect(events.some((e) => e.event === "codex_error" && e.message.includes(UPSTREAM))).toBe(true);

  const result = payload(await client.callTool({ name: "codex_result", arguments: { job_id: jobId } }));
  expect(result.state).toBe("error");
  expect(result.error).toContain(UPSTREAM);
  expect(result.handoff).toBeNull();
});

test("a failed turn without its own error falls back to the preceding error notification", async () => {
  const { client, workspace } = await connect({ FAIL_TURN_MESSAGE: UPSTREAM, FAIL_TURN_NO_ERROR: "1" });
  const status = await waitTerminal(client, await implement(client, workspace), QUIET_MS - 1_000);
  expect(status.state).toBe("error");
  expect(status.error).toBe(`Codex turn failed: ${UPSTREAM} (HTTP 400)`);
});

test("a retryable error notification is recorded but does not fail the job", async () => {
  const { client, workspace, events } = await connect({ RETRYABLE_ERROR_MESSAGE: "stream disconnected", CODEX_QUIET_MS: "500" });
  const status = await waitTerminal(client, await implement(client, workspace), 10_000);
  expect(status.state).toBe("done");
  expect(status.error).toBeNull();
  expect(status.goal.status).toBe("complete");
  expect(events.some((e) => e.event === "codex_error" && e.message.includes("(Codex will retry)"))).toBe(true);
});
