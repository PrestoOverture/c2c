import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const mcpDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const dirs: string[] = [];
const contract = { goal: "test", constraints: [], success_conditions: ["done"] };

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function payload(result: any) {
  return JSON.parse(result.content[0].text);
}

async function connect(env: Record<string, string>) {
  let stderr = "";
  const transport = new StdioClientTransport({
    command: "bun",
    args: [join(mcpDir, "src", "server.ts")],
    cwd: mcpDir,
    stderr: "pipe",
    env: { ...(process.env as Record<string, string>), ...env },
  });
  transport.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
  const client = new Client({ name: "observability", version: "1" });
  await client.connect(transport);
  return { client, stderr: () => stderr };
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

function tempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

test("logs are JSON lines on stderr and silent suppresses all server logs", async () => {
  const state = tempDir("c2c-log-state-");
  const info = await connect({
    C2C_STATE_DIR: state,
    C2C_LOG_LEVEL: "info",
    CODEX_BIN: "bun",
    CODEX_ARGS: join(mcpDir, "test", "mock-codex.ts"),
    CODEX_QUIET_MS: "200",
  });
  try {
    const started = payload(await info.client.callTool({ name: "codex_implement", arguments: contract }));
    expect((await wait(info.client, started.job_id)).state).toBe("done");
    const lines = info.stderr().trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const entry = JSON.parse(line);
      expect(entry.ts).toBeString();
      expect(["error", "info", "debug"]).toContain(entry.level);
      expect(entry.event).toBeString();
    }
  } finally {
    await info.client.close();
  }

  const silent = await connect({
    C2C_STATE_DIR: tempDir("c2c-silent-state-"),
    C2C_LOG_LEVEL: "silent",
    CODEX_BIN: "bun",
    CODEX_ARGS: join(mcpDir, "test", "mock-codex.ts"),
    CODEX_QUIET_MS: "200",
  });
  try {
    const started = payload(await silent.client.callTool({ name: "codex_implement", arguments: contract }));
    expect((await wait(silent.client, started.job_id)).state).toBe("done");
    await Bun.sleep(25);
    expect(silent.stderr()).toBe("");
  } finally {
    await silent.client.close();
  }
});

test("a starting-phase crash retries once and persists attempts", async () => {
  const state = tempDir("c2c-retry-state-");
  const scratch = tempDir("c2c-retry-marker-");
  const attemptFile = join(scratch, "attempts");
  const { client } = await connect({
    C2C_STATE_DIR: state,
    C2C_LOG_LEVEL: "silent",
    C2C_RETRIES: "1",
    CODEX_BIN: "bun",
    CODEX_ARGS: join(mcpDir, "test", "retry-codex.ts"),
    ATTEMPT_FILE: attemptFile,
  });
  try {
    const started = payload(await client.callTool({ name: "codex_implement", arguments: contract }));
    const status = await wait(client, started.job_id);
    expect(status.state).toBe("done");
    expect(status.attempts).toBe(2);
    expect(status.usage).toEqual({ inputTokens: 7, outputTokens: 11, totalTokens: 18 });
    expect(status.transcript_tail.filter((entry: any) => entry.kind === "attempt")).toHaveLength(2);
    expect(status.transcript_tail.some((entry: any) => entry.kind === "retry")).toBe(true);
    expect(JSON.parse(readFileSync(join(state, `${started.job_id}.json`), "utf8")).attempts).toBe(2);
  } finally {
    await client.close();
  }
});

test("a starting-phase crash does not retry with C2C_RETRIES=0", async () => {
  const state = tempDir("c2c-no-retry-state-");
  const scratch = tempDir("c2c-no-retry-marker-");
  const attemptFile = join(scratch, "attempts");
  const { client } = await connect({
    C2C_STATE_DIR: state,
    C2C_LOG_LEVEL: "silent",
    C2C_RETRIES: "0",
    CODEX_BIN: "bun",
    CODEX_ARGS: join(mcpDir, "test", "retry-codex.ts"),
    ATTEMPT_FILE: attemptFile,
  });
  try {
    const started = payload(await client.callTool({ name: "codex_implement", arguments: contract }));
    const status = await wait(client, started.job_id);
    expect(status.state).toBe("error");
    expect(status.attempts).toBe(1);
    expect(readFileSync(attemptFile, "utf8")).toBe("1");
  } finally {
    await client.close();
  }
});

test("a crash after turn/started is never retried", async () => {
  const state = tempDir("c2c-midturn-state-");
  const scratch = tempDir("c2c-midturn-marker-");
  const attemptFile = join(scratch, "attempts");
  const { client } = await connect({
    C2C_STATE_DIR: state,
    C2C_LOG_LEVEL: "silent",
    C2C_RETRIES: "3",
    CODEX_BIN: "bun",
    CODEX_ARGS: join(mcpDir, "test", "retry-codex.ts"),
    ATTEMPT_FILE: attemptFile,
    CRASH_PHASE: "midturn",
  });
  try {
    const started = payload(await client.callTool({ name: "codex_implement", arguments: contract }));
    const status = await wait(client, started.job_id);
    expect(status.state).toBe("error");
    expect(status.attempts).toBe(1);
    expect(status.turns).toBe(1);
    expect(readFileSync(attemptFile, "utf8")).toBe("1");
  } finally {
    await client.close();
  }
});
