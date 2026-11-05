import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const mcpDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const dirs: string[] = [];
const idleMs = 250;

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function payload(result: any) {
  return JSON.parse(result.content[0].text);
}

async function connect(extraEnv: Record<string, string> = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "c2c-idle-state-"));
  dirs.push(stateDir);
  const transport = new StdioClientTransport({
    command: "bun",
    args: [join(mcpDir, "src", "server.ts")],
    cwd: mcpDir,
    stderr: "pipe",
    env: {
      ...(process.env as Record<string, string>),
      C2C_STATE_DIR: stateDir,
      C2C_LOG_LEVEL: "silent",
      C2C_RETRIES: "0",
      C2C_MAX_CONCURRENT: "1",
      C2C_IDLE_TIMEOUT_MS: String(idleMs),
      C2C_STALL_WARN_MS: "0",
      CODEX_BIN: "bun",
      CODEX_ARGS: join(mcpDir, "test", "stall-codex.ts"),
      CODEX_JOB_TIMEOUT_MS: "10000",
      STALL_MODE: "silent",
      ...extraEnv,
    },
  });
  const client = new Client({ name: "idle-timeout", version: "1" });
  await client.connect(transport);
  return client;
}

async function start(client: Client, dependsOn?: string) {
  return payload(await client.callTool({
    name: "codex_implement",
    arguments: {
      goal: "verify idle timeout", constraints: [], success_conditions: ["verified"],
      ...(dependsOn ? { depends_on: dependsOn } : {}),
    },
  })).job_id as string;
}

async function status(client: Client, jobId: string) {
  return payload(await client.callTool({ name: "codex_status", arguments: { job_id: jobId } }));
}

async function waitForState(client: Client, jobId: string, state: string, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  let current: any;
  while (Date.now() < deadline) {
    current = await status(client, jobId);
    if (current.state === state) return current;
    if (["done", "error", "timeout"].includes(current.state)) break;
    await Bun.sleep(10);
  }
  throw new Error(`expected ${state}, got ${JSON.stringify(current)}`);
}

test("a silent mid-turn job hits C2C_IDLE_TIMEOUT_MS well before the hard cap", async () => {
  const client = await connect();
  try {
    const id = await start(client);
    const running = await waitForState(client, id, "running");
    // This deadline is far below the 10s hard cap: removing the idle timer must fail.
    const done = await waitForState(client, id, "timeout", idleMs + 800);
    const idleElapsed = Date.parse(done.ended_at) - Date.parse(running.last_activity_at);
    expect(idleElapsed).toBeGreaterThanOrEqual(idleMs);
    expect(idleElapsed).toBeLessThan(idleMs + 800);
    expect(done.error).toContain("C2C_IDLE_TIMEOUT_MS");
    expect(done.error).not.toContain("CODEX_JOB_TIMEOUT_MS");
    expect(done.turns).toBe(1);
  } finally {
    await client.close();
  }
});

test("notifications below the idle interval keep a longer attempt alive", async () => {
  const client = await connect({ STALL_MODE: "active" });
  try {
    const id = await start(client);
    const done = await waitForState(client, id, "done");
    expect(Date.parse(done.ended_at) - Date.parse(done.started_at)).toBeGreaterThan(idleMs);
    expect(done.error).toBeNull();
  } finally {
    await client.close();
  }
});

test("C2C_IDLE_TIMEOUT_MS=0 lets a silent attempt resume and finish", async () => {
  const client = await connect({ C2C_IDLE_TIMEOUT_MS: "0", STALL_MODE: "resume" });
  try {
    const id = await start(client);
    await waitForState(client, id, "running");
    await Bun.sleep(idleMs + 50);
    expect((await status(client, id)).state).toBe("running");
    expect((await waitForState(client, id, "done")).error).toBeNull();
  } finally {
    await client.close();
  }
});

test("the overall hard cap still fires during continuous notifications", async () => {
  const client = await connect({ STALL_MODE: "active", CODEX_JOB_TIMEOUT_MS: "350" });
  try {
    const done = await waitForState(client, await start(client), "timeout");
    expect(done.error).toContain("CODEX_JOB_TIMEOUT_MS");
    expect(done.error).not.toContain("C2C_IDLE_TIMEOUT_MS");
  } finally {
    await client.close();
  }
});

for (const waitingState of ["queued", "blocked"] as const) {
  test(`${waitingState} time does not count toward idle timeout`, async () => {
    const client = await connect({ STALL_MODE: "active" });
    try {
      const first = await start(client);
      await waitForState(client, first, "running");
      const second = await start(client, waitingState === "blocked" ? first : undefined);
      expect((await status(client, second)).state).toBe(waitingState);
      await Bun.sleep(idleMs + 50);
      expect((await status(client, second)).state).toBe(waitingState);
      expect((await waitForState(client, second, "done")).error).toBeNull();
    } finally {
      await client.close();
    }
  });
}
