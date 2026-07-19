import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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

function contract(goal: string) {
  return { goal, constraints: [], success_conditions: [`${goal} completed`] };
}

async function connect(extraEnv: Record<string, string>) {
  const stateDir = mkdtempSync(join(tmpdir(), "c2c-multi-state-"));
  dirs.push(stateDir);
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
      C2C_RETRIES: "0",
      CODEX_BIN: "bun",
      CODEX_ARGS: join(mcpDir, "test", "multi-job-codex.ts"),
      CODEX_QUIET_MS: "50",
      ...extraEnv,
    },
  });
  transport.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
  const client = new Client({ name: "multi-job", version: "1" });
  await client.connect(transport);
  return { client, stderr: () => stderr };
}

async function status(client: Client, jobId: string) {
  return payload(await client.callTool({ name: "codex_status", arguments: { job_id: jobId } }));
}

async function waitForTerminal(client: Client, jobId: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await status(client, jobId);
    if (!["queued", "starting", "running"].includes(current.state)) return current;
    await Bun.sleep(20);
  }
  throw new Error(`job ${jobId} did not finish`);
}

test("two jobs run in parallel without goal or usage cross-contamination", async () => {
  const { client } = await connect({
    C2C_MAX_CONCURRENT: "2",
    CODEX_JOB_TIMEOUT_MS: "2000",
    MULTI_JOB_DELAY_MS: "350",
  });
  try {
    const alpha = payload(await client.callTool({ name: "codex_implement", arguments: contract("alpha") }));
    const beta = payload(await client.callTool({ name: "codex_implement", arguments: contract("beta") }));
    expect(alpha.state).toBe("starting");
    expect(beta.state).toBe("starting");

    let overlappingRunning = false;
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      const [alphaStatus, betaStatus] = await Promise.all([
        status(client, alpha.job_id),
        status(client, beta.job_id),
      ]);
      if (alphaStatus.state === "running" && betaStatus.state === "running") {
        overlappingRunning = true;
        break;
      }
      await Bun.sleep(10);
    }
    expect(overlappingRunning).toBe(true);

    const [alphaDone, betaDone] = await Promise.all([
      waitForTerminal(client, alpha.job_id),
      waitForTerminal(client, beta.job_id),
    ]);
    expect(alphaDone.state).toBe("done");
    expect(betaDone.state).toBe("done");
    expect(alphaDone.thread_id).not.toBe(betaDone.thread_id);
    expect(alphaDone.goal.tokensUsed).toBe(100);
    expect(betaDone.goal.tokensUsed).toBe(101);
    expect(alphaDone.usage).toEqual({ inputTokens: 10, totalTokens: 100 });
    expect(betaDone.usage).toEqual({ inputTokens: 11, totalTokens: 101 });

    const [alphaResult, betaResult] = await Promise.all([
      client.callTool({ name: "codex_result", arguments: { job_id: alpha.job_id } }),
      client.callTool({ name: "codex_result", arguments: { job_id: beta.job_id } }),
    ]);
    expect(payload(alphaResult).handoff.valid).toBe(true);
    expect(payload(betaResult).handoff.valid).toBe(true);
    expect(payload(alphaResult).final_message).toContain("Completed alpha");
    expect(payload(betaResult).final_message).toContain("Completed beta");
  } finally {
    await client.close();
  }
}, 10_000);

test("jobs beyond the cap queue visibly and start after the active job", async () => {
  const { client, stderr } = await connect({
    C2C_MAX_CONCURRENT: "1",
    CODEX_JOB_TIMEOUT_MS: "600",
    MULTI_JOB_DELAY_MS: "350",
  });
  const progress: any[] = [];
  client.setNotificationHandler(ProgressNotificationSchema, (notification) => {
    progress.push(notification.params);
  });
  try {
    const first = payload(await client.callTool({ name: "codex_implement", arguments: contract("first") }));
    const second = payload(await client.callTool({ name: "codex_implement", arguments: contract("second") }));

    const queued = await status(client, second.job_id);
    expect(second.state).toBe("queued");
    expect(queued.state).toBe("queued");
    expect(queued.queue_position).toBe(1);
    expect(queued.transcript_tail.some((entry: any) => entry.kind === "queue" && entry.detail.includes("enqueued"))).toBe(true);

    const premature: any = await client.callTool({ name: "codex_result", arguments: { job_id: second.job_id } });
    expect(premature.isError).toBe(true);

    const firstDone = await waitForTerminal(client, first.job_id);
    const secondDone = await waitForTerminal(client, second.job_id);
    expect(firstDone.state).toBe("done");
    expect(secondDone.state).toBe("done");
    expect(secondDone.handoff).toBeUndefined();
    expect(secondDone.transcript_tail.some((entry: any) => entry.kind === "queue" && entry.detail.includes("dequeued"))).toBe(true);

    const result = payload(await client.callTool({ name: "codex_result", arguments: { job_id: second.job_id } }));
    expect(result.handoff.valid).toBe(true);
    expect(result.queue_position ?? null).toBeNull();
    expect(progress.some((entry) => entry.message?.includes('"event":"queued"'))).toBe(true);
    expect(progress.some((entry) => entry.message?.includes('"event":"dequeued"'))).toBe(true);

    await Bun.sleep(20);
    const logEvents = stderr().trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(logEvents.some((entry) => entry.level === "info" && entry.event === "job_enqueued" && entry.job_id === second.job_id)).toBe(true);
    expect(logEvents.some((entry) => entry.level === "info" && entry.event === "job_dequeued" && entry.job_id === second.job_id)).toBe(true);
  } finally {
    await client.close();
  }
}, 15_000);

test("implement and rework jobs share one FIFO queue", async () => {
  const { client } = await connect({
    C2C_MAX_CONCURRENT: "1",
    CODEX_JOB_TIMEOUT_MS: "2000",
    MULTI_JOB_DELAY_MS: "200",
  });
  const progress: any[] = [];
  client.setNotificationHandler(ProgressNotificationSchema, (notification) => {
    progress.push(notification.params);
  });
  try {
    const seed = payload(await client.callTool({ name: "codex_implement", arguments: contract("seed") }));
    expect((await waitForTerminal(client, seed.job_id)).state).toBe("done");

    const blocker = payload(await client.callTool({ name: "codex_implement", arguments: contract("blocker") }));
    const implement = payload(await client.callTool({ name: "codex_implement", arguments: contract("third") }));
    const rework = payload(await client.callTool({
      name: "codex_rework",
      arguments: { job_id: seed.job_id, findings: ["fix seed"], failed_conditions: ["seed completed"] },
    }));

    expect((await status(client, implement.job_id)).queue_position).toBe(1);
    expect((await status(client, rework.job_id)).queue_position).toBe(2);
    expect((await status(client, rework.job_id)).kind).toBe("rework");

    const [blockerDone, implementDone, reworkDone] = await Promise.all([
      waitForTerminal(client, blocker.job_id),
      waitForTerminal(client, implement.job_id),
      waitForTerminal(client, rework.job_id),
    ]);
    expect(blockerDone.state).toBe("done");
    expect(implementDone.state).toBe("done");
    expect(reworkDone.state).toBe("done");
    expect(payload(await client.callTool({ name: "codex_result", arguments: { job_id: rework.job_id } })).handoff.valid).toBe(true);

    const dequeued = progress
      .map((entry) => JSON.parse(entry.message))
      .filter((entry) => entry.event === "dequeued")
      .map((entry) => entry.jobId);
    expect(dequeued).toEqual([implement.job_id, rework.job_id]);
  } finally {
    await client.close();
  }
}, 15_000);
