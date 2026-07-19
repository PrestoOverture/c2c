import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
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

function contract(goal: string, dependsOn?: string) {
  return {
    goal,
    constraints: [],
    success_conditions: [`${goal} completed`],
    ...(dependsOn ? { depends_on: dependsOn } : {}),
  };
}

async function connect(mock: string, extraEnv: Record<string, string> = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "c2c-dependency-state-"));
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
      C2C_MAX_CONCURRENT: "1",
      CODEX_BIN: "bun",
      CODEX_ARGS: join(mcpDir, "test", mock),
      CODEX_QUIET_MS: "50",
      CODEX_JOB_TIMEOUT_MS: "500",
      ...extraEnv,
    },
  });
  transport.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
  const client = new Client({ name: "dependencies", version: "1" });
  client.setNotificationHandler(ProgressNotificationSchema, (notification) => {
    progress.push(JSON.parse(String(notification.params.message)));
  });
  await client.connect(transport);
  return { client, stateDir, stderr: () => stderr, progress };
}

async function status(client: Client, jobId: string) {
  return payload(await client.callTool({ name: "codex_status", arguments: { job_id: jobId } }));
}

async function waitForState(client: Client, jobId: string, expected: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await status(client, jobId);
    if (current.state === expected) return current;
    await Bun.sleep(10);
  }
  throw new Error(`job ${jobId} did not reach ${expected}`);
}

async function waitForTerminal(client: Client, jobId: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await status(client, jobId);
    if (!["blocked", "queued", "starting", "running"].includes(current.state)) return current;
    await Bun.sleep(10);
  }
  throw new Error(`job ${jobId} did not finish`);
}

function logEvents(stderr: string) {
  return stderr.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function jobFileCount(stateDir: string) {
  return readdirSync(stateDir).filter((name) => name.endsWith(".json")).length;
}

test("a blocked dependency unblocks after success and starts on its own timeout clock", async () => {
  const { client, stderr, progress } = await connect("multi-job-codex.ts", {
    MULTI_JOB_DELAY_MS: "300",
    CODEX_JOB_TIMEOUT_MS: "500",
    C2C_MAX_CONCURRENT: "2",
  });
  try {
    const first = payload(await client.callTool({ name: "codex_implement", arguments: contract("first") }));
    await waitForState(client, first.job_id, "running");
    const second = payload(await client.callTool({
      name: "codex_implement",
      arguments: contract("second", first.job_id),
    }));

    expect(second.state).toBe("blocked");
    const blocked = await status(client, second.job_id);
    expect(blocked.state).toBe("blocked");
    expect(blocked.depends_on).toBe(first.job_id);
    expect(blocked.thread_id).toBeNull();
    expect(blocked.turns).toBe(0);
    expect(blocked.queue_position).toBeUndefined();
    expect(blocked.transcript_tail.some((entry: any) => entry.kind === "blocked")).toBe(true);
    expect(logEvents(stderr()).some((entry) =>
      entry.event === "codex_process_spawn" && entry.job_id === second.job_id
    )).toBe(false);

    const independent = payload(await client.callTool({
      name: "codex_implement",
      arguments: contract("third"),
    }));
    expect((await waitForState(client, independent.job_id, "running")).state).toBe("running");
    expect((await status(client, second.job_id)).state).toBe("blocked");

    const [firstDone, secondDone, independentDone] = await Promise.all([
      waitForTerminal(client, first.job_id),
      waitForTerminal(client, second.job_id),
      waitForTerminal(client, independent.job_id),
    ]);
    expect(firstDone.state).toBe("done");
    expect(secondDone.state).toBe("done");
    expect(independentDone.state).toBe("done");
    expect(secondDone.depends_on).toBe(first.job_id);
    expect(secondDone.transcript_tail.some((entry: any) => entry.kind === "unblocked")).toBe(true);

    const secondEvents = progress.filter((event) => event.jobId === second.job_id);
    expect(secondEvents.map((event) => event.event)).toContain("blocked");
    expect(secondEvents.map((event) => event.event)).toContain("unblocked");
    expect(secondEvents.findIndex((event) => event.event === "unblocked")).toBeLessThan(
      secondEvents.findIndex((event) => event.event === "turn_started"),
    );

    await Bun.sleep(20);
    const logs = logEvents(stderr());
    expect(logs.some((entry) => entry.level === "info" && entry.event === "job_blocked" && entry.job_id === second.job_id)).toBe(true);
    expect(logs.some((entry) => entry.level === "info" && entry.event === "job_unblocked" && entry.job_id === second.job_id)).toBe(true);
  } finally {
    await client.close();
  }
}, 15_000);

test("unknown and terminal dependencies validate before job creation", async () => {
  const crashMarker = join(mkdtempSync(join(tmpdir(), "c2c-dependency-crash-")), "marker");
  dirs.push(dirname(crashMarker));
  const { client, stateDir } = await connect("crash-codex.ts", {
    CRASH_MARKER: crashMarker,
    CRASH_DELAY_MS: "150",
  });
  try {
    const unknown: any = await client.callTool({
      name: "codex_implement",
      arguments: contract("unknown dependency", "missing-job"),
    });
    expect(unknown.isError).toBe(true);
    expect(payload(unknown).error).toContain("unknown depends_on job_id missing-job");
    expect(jobFileCount(stateDir)).toBe(0);

    const failed = payload(await client.callTool({ name: "codex_implement", arguments: contract("root failure") }));
    expect((await waitForTerminal(client, failed.job_id)).state).toBe("error");
    const countAfterFailure = jobFileCount(stateDir);
    const rejected: any = await client.callTool({
      name: "codex_implement",
      arguments: contract("rejected dependent", failed.job_id),
    });
    expect(rejected.isError).toBe(true);
    expect(payload(rejected).error).toContain(failed.job_id);
    expect(payload(rejected).error).toContain("fatal mock crash diagnostic");
    expect(jobFileCount(stateDir)).toBe(countAfterFailure);

    const completed = payload(await client.callTool({ name: "codex_implement", arguments: contract("completed root") }));
    expect((await waitForTerminal(client, completed.job_id)).state).toBe("done");
    const afterDone = payload(await client.callTool({
      name: "codex_implement",
      arguments: contract("completed dependent", completed.job_id),
    }));
    expect(afterDone.state).toBe("starting");
    const afterDoneResult = await waitForTerminal(client, afterDone.job_id);
    expect(afterDoneResult.state).toBe("done");
    expect(afterDoneResult.depends_on).toBe(completed.job_id);
  } finally {
    await client.close();
  }
}, 15_000);

test("three-level chains complete in order", async () => {
  const { client, progress } = await connect("multi-job-codex.ts", {
    MULTI_JOB_DELAY_MS: "150",
    CODEX_JOB_TIMEOUT_MS: "400",
  });
  try {
    const first = payload(await client.callTool({ name: "codex_implement", arguments: contract("first") }));
    const second = payload(await client.callTool({
      name: "codex_implement",
      arguments: contract("second", first.job_id),
    }));
    const third = payload(await client.callTool({
      name: "codex_implement",
      arguments: contract("third", second.job_id),
    }));
    const sibling = payload(await client.callTool({
      name: "codex_implement",
      arguments: contract("alpha", first.job_id),
    }));
    expect(second.state).toBe("blocked");
    expect(third.state).toBe("blocked");
    expect(sibling.state).toBe("blocked");

    const results = await Promise.all([
      waitForTerminal(client, first.job_id),
      waitForTerminal(client, second.job_id),
      waitForTerminal(client, third.job_id),
      waitForTerminal(client, sibling.job_id),
    ]);
    expect(results.map((result) => result.state)).toEqual(["done", "done", "done", "done"]);
    const started = progress.filter((event) => event.event === "turn_started").map((event) => event.jobId);
    expect(started).toEqual([first.job_id, second.job_id, sibling.job_id, third.job_id]);
  } finally {
    await client.close();
  }
}, 15_000);

test("a timed-out dependency fails blocked and newly submitted dependents", async () => {
  const { client, stateDir, stderr } = await connect("multi-job-codex.ts", {
    MULTI_JOB_DELAY_MS: "300",
    CODEX_JOB_TIMEOUT_MS: "100",
  });
  try {
    const first = payload(await client.callTool({ name: "codex_implement", arguments: contract("first") }));
    await waitForState(client, first.job_id, "running");
    const second = payload(await client.callTool({
      name: "codex_implement",
      arguments: contract("second", first.job_id),
    }));

    const [firstTimedOut, secondFailed] = await Promise.all([
      waitForTerminal(client, first.job_id),
      waitForTerminal(client, second.job_id),
    ]);
    expect(firstTimedOut.state).toBe("timeout");
    expect(secondFailed.state).toBe("error");
    expect(secondFailed.error).toContain(first.job_id);
    expect(secondFailed.error).toContain("job exceeded 100ms");
    expect(logEvents(stderr()).some((entry) =>
      entry.event === "codex_process_spawn" && entry.job_id === second.job_id
    )).toBe(false);

    const count = jobFileCount(stateDir);
    const rejected: any = await client.callTool({
      name: "codex_implement",
      arguments: contract("third", first.job_id),
    });
    expect(rejected.isError).toBe(true);
    expect(payload(rejected).error).toContain("job exceeded 100ms");
    expect(jobFileCount(stateDir)).toBe(count);
  } finally {
    await client.close();
  }
}, 15_000);

test("a root crash fails a three-level chain without spawning dependent processes", async () => {
  const crashMarker = join(mkdtempSync(join(tmpdir(), "c2c-dependency-cascade-")), "marker");
  dirs.push(dirname(crashMarker));
  const { client, stderr, progress } = await connect("crash-codex.ts", {
    CRASH_MARKER: crashMarker,
    CRASH_DELAY_MS: "200",
  });
  try {
    const first = payload(await client.callTool({ name: "codex_implement", arguments: contract("first") }));
    await waitForState(client, first.job_id, "running");
    const second = payload(await client.callTool({
      name: "codex_implement",
      arguments: contract("second", first.job_id),
    }));
    const third = payload(await client.callTool({
      name: "codex_implement",
      arguments: contract("third", second.job_id),
    }));

    const [firstFailed, secondFailed, thirdFailed] = await Promise.all([
      waitForTerminal(client, first.job_id),
      waitForTerminal(client, second.job_id),
      waitForTerminal(client, third.job_id),
    ]);
    expect(firstFailed.state).toBe("error");
    expect(secondFailed.state).toBe("error");
    expect(thirdFailed.state).toBe("error");
    expect(secondFailed.error).toContain(first.job_id);
    expect(secondFailed.error).toContain("fatal mock crash diagnostic");
    expect(thirdFailed.error).toContain(second.job_id);
    expect(thirdFailed.error).toContain("fatal mock crash diagnostic");

    for (const dependent of [secondFailed, thirdFailed]) {
      expect(dependent.transcript_tail.some((entry: any) => entry.kind === "dependency_failed")).toBe(true);
      expect(dependent.transcript_tail.some((entry: any) => entry.kind === "attempt" || entry.kind === "thread")).toBe(false);
    }
    const logs = logEvents(stderr());
    expect(logs.some((entry) => entry.event === "codex_process_spawn" && entry.job_id === second.job_id)).toBe(false);
    expect(logs.some((entry) => entry.event === "codex_process_spawn" && entry.job_id === third.job_id)).toBe(false);
    expect(logs.filter((entry) =>
      entry.level === "info" && entry.event === "job_dependency_failed"
    ).map((entry) => entry.job_id)).toEqual([second.job_id, third.job_id]);
    expect(progress.filter((event) => event.event === "dependency_failed").map((event) => event.jobId)).toEqual([
      second.job_id,
      third.job_id,
    ]);
  } finally {
    await client.close();
  }
}, 15_000);
