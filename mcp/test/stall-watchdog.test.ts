import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ProgressNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

const mcpDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function payload(result: any) {
  return JSON.parse(result.content[0].text);
}

async function status(client: Client, jobId: string) {
  return payload(await client.callTool({ name: "codex_status", arguments: { job_id: jobId } }));
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 2_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  throw new Error(message);
}

async function connect(extraEnv: Record<string, string> = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "c2c-stall-state-"));
  dirs.push(stateDir);
  let stderr = "";
  const progress: any[] = [];
  const transport = new StdioClientTransport({
    command: "bun",
    args: [join(mcpDir, "src", "server.ts")],
    cwd: mcpDir,
    stderr: "pipe",
    env: {
      ...(process.env as Record<string, string>),
      C2C_STATE_DIR: stateDir,
      C2C_LOG_LEVEL: "info",
      C2C_RETRIES: "0",
      C2C_STALL_WARN_MS: "200",
      CODEX_BIN: "bun",
      CODEX_ARGS: join(mcpDir, "test", "stall-codex.ts"),
      CODEX_JOB_TIMEOUT_MS: "1300",
      ...extraEnv,
    },
  });
  transport.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
  const client = new Client({ name: "stall-watchdog", version: "1" });
  client.setNotificationHandler(ProgressNotificationSchema, (notification) => {
    progress.push(JSON.parse(String(notification.params.message)));
  });
  await client.connect(transport);
  return { client, stateDir, stderr: () => stderr, progress };
}

test("a silent active turn reports one stall and increasing activity age", async () => {
  const { client, stateDir, stderr, progress } = await connect();
  try {
    const started = payload(await client.callTool({
      name: "codex_implement",
      arguments: { goal: "stall", constraints: [], success_conditions: ["reported"] },
    }));
    await waitFor(
      () => progress.some((event) => event.jobId === started.job_id && event.event === "stalled"),
      "stalled progress event was not emitted",
    );

    const first = await status(client, started.job_id);
    expect(first.state).toBe("running");
    expect(first.last_activity_at).toBeString();
    expect(first.seconds_since_activity).toBeNumber();
    expect(first.transcript_tail.filter((entry: any) => entry.kind === "stalled")).toHaveLength(1);

    await Bun.sleep(120);
    const second = await status(client, started.job_id);
    expect(second.last_activity_at).toBe(first.last_activity_at);
    expect(second.seconds_since_activity).toBeGreaterThan(first.seconds_since_activity);
    expect(progress.filter((event) => event.jobId === started.job_id && event.event === "stalled")).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(stateDir, `${started.job_id}.json`), "utf8")).lastActivityAt)
      .toBe(first.last_activity_at);

    const stallLogs = stderr().trim().split("\n").filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.event === "job_stalled" && entry.job_id === started.job_id);
    expect(stallLogs).toHaveLength(1);
    expect(stallLogs[0].level).toBe("info");
    expect(stallLogs[0].stalled_for_ms).toBeGreaterThanOrEqual(200);
  } finally {
    await client.close();
  }
});

test("activity after a stall reports one resume and the job completes without timer spam", async () => {
  const { client, stderr, progress } = await connect({
    STALL_MODE: "resume",
    CODEX_JOB_TIMEOUT_MS: "2000",
  });
  try {
    const started = payload(await client.callTool({
      name: "codex_implement",
      arguments: { goal: "resume", constraints: [], success_conditions: ["done"] },
    }));
    let done: any;
    await waitFor(async () => {
      const current = await status(client, started.job_id);
      if (current.state === "done") {
        done = current;
        return true;
      }
      return false;
    }, "resumed job did not finish");

    expect(done.state).toBe("done");
    expect(done.last_activity_at).toBeUndefined();
    expect(done.seconds_since_activity).toBeUndefined();
    expect(done.transcript_tail.filter((entry: any) => entry.kind === "stalled")).toHaveLength(1);
    expect(done.transcript_tail.filter((entry: any) => entry.kind === "resumed")).toHaveLength(1);
    expect(progress.filter((event) => event.jobId === started.job_id && event.event === "stalled")).toHaveLength(1);
    expect(progress.filter((event) => event.jobId === started.job_id && event.event === "resumed")).toHaveLength(1);

    await Bun.sleep(300);
    expect(progress.filter((event) => event.jobId === started.job_id && event.event === "stalled")).toHaveLength(1);
    expect(progress.filter((event) => event.jobId === started.job_id && event.event === "resumed")).toHaveLength(1);

    const logs = stderr().trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(logs.filter((entry) => entry.event === "job_stalled" && entry.job_id === started.job_id)).toHaveLength(1);
    expect(logs.filter((entry) => entry.event === "job_resumed" && entry.job_id === started.job_id)).toHaveLength(1);
  } finally {
    await client.close();
  }
});

test("a normally active turn produces no stall warnings", async () => {
  const { client, stderr, progress } = await connect({
    STALL_MODE: "active",
    CODEX_JOB_TIMEOUT_MS: "2000",
  });
  try {
    const started = payload(await client.callTool({
      name: "codex_implement",
      arguments: { goal: "active", constraints: [], success_conditions: ["done"] },
    }));
    let firstActivity: string | undefined;
    await waitFor(async () => {
      const current = await status(client, started.job_id);
      if (current.state === "running") {
        firstActivity = current.last_activity_at;
        return true;
      }
      return false;
    }, "active job did not start its turn");
    await Bun.sleep(100);
    const refreshed = await status(client, started.job_id);
    expect(Date.parse(refreshed.last_activity_at)).toBeGreaterThan(Date.parse(firstActivity!));

    let done: any;
    await waitFor(async () => {
      const current = await status(client, started.job_id);
      if (current.state === "done") {
        done = current;
        return true;
      }
      return false;
    }, "active job did not finish");

    expect(done.transcript_tail.filter((entry: any) => entry.kind === "stalled")).toHaveLength(0);
    expect(progress.filter((event) => event.jobId === started.job_id && event.event === "stalled")).toHaveLength(0);
    const logs = stderr().trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(logs.filter((entry) => entry.event === "job_stalled" && entry.job_id === started.job_id)).toHaveLength(0);
  } finally {
    await client.close();
  }
});

test("C2C_STALL_WARN_MS=0 disables warnings but keeps activity status", async () => {
  const { client, stderr, progress } = await connect({
    C2C_STALL_WARN_MS: "0",
    CODEX_JOB_TIMEOUT_MS: "650",
  });
  try {
    const started = payload(await client.callTool({
      name: "codex_implement",
      arguments: { goal: "disabled", constraints: [], success_conditions: ["silent"] },
    }));
    await Bun.sleep(400);
    const running = await status(client, started.job_id);
    expect(running.state).toBe("running");
    expect(running.last_activity_at).toBeString();
    expect(running.seconds_since_activity).toBeGreaterThan(0.2);
    expect(running.transcript_tail.filter((entry: any) => entry.kind === "stalled")).toHaveLength(0);
    expect(progress.filter((event) => event.jobId === started.job_id && event.event === "stalled")).toHaveLength(0);

    let terminal: any;
    await waitFor(async () => {
      const current = await status(client, started.job_id);
      if (current.state === "timeout") {
        terminal = current;
        return true;
      }
      return false;
    }, "disabled watchdog job did not reach its backstop timeout");
    expect(terminal.transcript_tail.filter((entry: any) => entry.kind === "stalled")).toHaveLength(0);
    const logs = stderr().trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(logs.filter((entry) => entry.event === "job_stalled" && entry.job_id === started.job_id)).toHaveLength(0);
  } finally {
    await client.close();
  }
});
