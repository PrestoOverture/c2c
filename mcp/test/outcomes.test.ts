import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createJobStore } from "../src/store.ts";

const mcpDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const dirs: string[] = [];
const clients: Client[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "c2c-outcomes-"));
  dirs.push(dir);
  return dir;
}

async function connect(state: string, env: Record<string, string> = {}) {
  let stderr = "";
  const transport = new StdioClientTransport({
    command: "bun", args: [join(mcpDir, "src/server.ts")], cwd: mcpDir, stderr: "pipe",
    env: {
      ...process.env as Record<string, string>,
      CODEX_BIN: "bun", CODEX_ARGS: join(mcpDir, "test/mock-codex.ts"),
      C2C_STATE_DIR: state, C2C_MAX_JOBS: "500", C2C_LOG_LEVEL: "error",
      CODEX_JOB_TIMEOUT_MS: "10000", C2C_IDLE_TIMEOUT_MS: "0", CODEX_QUIET_MS: "500",
      ...env,
    },
  });
  transport.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
  const client = new Client({ name: "outcomes-test", version: "1" });
  await client.connect(transport);
  clients.push(client);
  return { client, stderr: () => stderr };
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result: any = await client.callTool({ name, arguments: args });
  expect(result.isError ?? false).toBe(false);
  return JSON.parse(result.content[0].text);
}

async function done(client: Client, id: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const status = await call(client, "codex_status", { job_id: id });
    if (["done", "error", "timeout"].includes(status.state)) return status;
    await Bun.sleep(20);
  }
  throw new Error(`job ${id} did not finish`);
}

const contract = { goal: "fixture", constraints: [], success_conditions: ["done"] };
const delta = { findings: ["fix fixture"], failed_conditions: ["done"] };
const lines = (state: string): any[] => readFileSync(join(state, "outcomes.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));

function assertPrivate(value: unknown) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    expect(["output_tail", "prompt", "transcript", "finalMessage", "final_message", "contract"].includes(key)).toBe(false);
    assertPrivate(child);
  }
}

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function repository() {
  const cwd = scratch();
  git(cwd, "init", "-q");
  git(cwd, "config", "user.email", "outcomes@example.com");
  git(cwd, "config", "user.name", "Outcomes Test");
  writeFileSync(join(cwd, "production"), "before\n");
  writeFileSync(join(cwd, "existing.check"), "true\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "fixture");
  return cwd;
}

test("implement and two job-id reworks log chained lineage; status/result persist it across restart without logging interruption rewrites", async () => {
  const state = scratch();
  let { client } = await connect(state);
  const jobs: any[] = [];
  const first = await call(client, "codex_implement", contract);
  jobs.push(await done(client, first.job_id));
  for (let index = 0; index < 2; index++) {
    const rework = await call(client, "codex_rework", { ...delta, job_id: jobs.at(-1).job_id });
    jobs.push(await done(client, rework.job_id));
  }
  const expected = jobs.map((job, round) => ({
    job_id: job.job_id, parent_job_id: jobs[round - 1]?.job_id ?? null,
    root_job_id: first.job_id, rework_round: round,
  }));
  const logged = lines(state);
  expect(logged).toHaveLength(3);
  for (const [index, line] of logged.entries()) {
    expect(line).toMatchObject({ ...expected[index], state: "done", caught_by: [], evidence: null, handoff_valid: true });
    expect(line.at).toBe(jobs[index].ended_at);
    expect(line.duration_ms).toBe(Date.parse(jobs[index].ended_at) - Date.parse(jobs[index].started_at));
    expect(line.usage).toEqual(jobs[index].usage);
    expect(line.turns).toBe(jobs[index].turns);
    expect(line.attempts).toBe(1);
    assertPrivate(line);
  }
  expect(statSync(join(state, "outcomes.jsonl")).mode & 0o777).toBe(0o600);
  const before = readFileSync(join(state, "outcomes.jsonl"), "utf8");
  await client.close();
  // A persisted active job is interrupted by startup, not a new finished run.
  writeFileSync(join(state, "interrupted.json"), JSON.stringify({
    id: "interrupted", kind: "implement", state: "running", goalSet: false,
    turns: 1, startedAt: new Date().toISOString(), transcript: [],
  }));
  ({ client } = await connect(state));
  for (const lineage of expected) {
    for (const name of ["codex_status", "codex_result"]) {
      expect(await call(client, name, { job_id: lineage.job_id })).toMatchObject(lineage);
    }
  }
  expect(await call(client, "codex_status", { job_id: "interrupted" })).toMatchObject({
    state: "error", error: "interrupted by server restart",
  });
  expect(readFileSync(join(state, "outcomes.jsonl"), "utf8")).toBe(before);
});

test("thread-only rework selects the latest known parent, including after restart; unknown thread starts an unknown chain", async () => {
  const state = scratch();
  let { client } = await connect(state);
  const first = await call(client, "codex_implement", contract);
  const implement = await done(client, first.job_id);
  const second = await call(client, "codex_rework", { ...delta, thread_id: implement.thread_id });
  expect(await done(client, second.job_id)).toMatchObject({ parent_job_id: first.job_id, root_job_id: first.job_id, rework_round: 1 });
  await client.close();
  ({ client } = await connect(state));
  const third = await call(client, "codex_rework", { ...delta, thread_id: implement.thread_id });
  expect(await done(client, third.job_id)).toMatchObject({ parent_job_id: second.job_id, root_job_id: first.job_id, rework_round: 2 });
  const unknown = await call(client, "codex_rework", { ...delta, thread_id: "unknown-thread" });
  expect(await done(client, unknown.job_id)).toMatchObject({ parent_job_id: null, root_job_id: null, rework_round: 1 });
  expect(lines(state).map((line) => [line.parent_job_id, line.root_job_id, line.rework_round])).toEqual([
    [null, first.job_id, 0], [first.job_id, first.job_id, 1], [second.job_id, first.job_id, 2], [null, null, 1],
  ]);
});

test("caught_by distinguishes worker crash, timeout, incomplete handoff, verify, setup and a clean pass", async () => {
  const cases = [
    { name: "crash", env: { CODEX_ARGS: join(mcpDir, "test/crash-codex.ts"), CRASH_MARKER: join(scratch(), "marker") }, args: {}, state: "error", flags: ["worker_error"] },
    { name: "timeout", env: { CODEX_ARGS: join(mcpDir, "test/stall-codex.ts"), CODEX_JOB_TIMEOUT_MS: "250" }, args: {}, state: "timeout", flags: ["timeout"] },
    { name: "handoff", env: { MOCK_HANDOFF: "### Changed Files\n- fixture\n### Validation\n- pass\n### Success Conditions\n- [x] done" }, args: {}, state: "done", flags: ["handoff_invalid"] },
    { name: "verify", env: {}, args: { verify_commands: ["printf private-output; exit 7", "true"] }, state: "done", flags: ["verify"] },
    { name: "setup", env: {}, args: { verify_commands: ["false"], setup_commands: ["exit 8", "false"] }, state: "done", flags: ["setup"] },
    { name: "clean", env: {}, args: { verify_commands: ["true"] }, state: "done", flags: [] },
  ];
  for (const fixture of cases) {
    const state = scratch();
    const cwd = scratch();
    const { client } = await connect(state, fixture.env as Record<string, string>);
    const started = await call(client, "codex_implement", { ...contract, cwd, ...fixture.args });
    expect((await done(client, started.job_id)).state).toBe(fixture.state);
    const logged = lines(state);
    expect(logged).toHaveLength(1);
    expect(logged[0].caught_by).toEqual(fixture.flags);
    assertPrivate(logged[0]);
    if (fixture.name === "verify") {
      expect(logged[0].evidence).toEqual({
        passed: false, environment: "in_place", error: null,
        failed_setup: [], failed_commands: ["printf private-output; exit 7"], timed_out: [],
        falsification_ran: false, falsification_skipped_reason: "evidence failed",
        unfalsified: [], tests_modified: [], out_of_scope: [], new_unclassified: [],
      });
    }
    if (fixture.name === "setup") {
      expect(logged[0].evidence.failed_setup).toEqual(["exit 8"]);
      expect(logged[0].evidence.failed_commands).toEqual([]);
    }
    await client.close();
  }
}, 20_000);

test("outcomes summarize timed-out evidence commands and snapshot errors", async () => {
  const state = scratch();
  const { client } = await connect(state, { C2C_VERIFY_TIMEOUT_MS: "100" });
  const started = await call(client, "codex_implement", { ...contract, cwd: scratch(), verify_commands: ["sleep 5", "false"] });
  await done(client, started.job_id);
  expect(lines(state)[0]).toMatchObject({
    caught_by: ["verify"], evidence: { failed_commands: ["sleep 5", "false"], timed_out: ["sleep 5"] },
  });
  const cwd = repository();
  writeFileSync(join(cwd, ".git/hooks/post-checkout"), "#!/bin/sh\nexit 5\n", { mode: 0o755 });
  const snapshot = await call(client, "codex_implement", { ...contract, cwd, verify_commands: ["true"] });
  await done(client, snapshot.job_id);
  expect(lines(state)[1]).toMatchObject({ caught_by: ["snapshot_error"], evidence: { passed: false, failed_commands: [] } });
  expect(lines(state)[1].evidence.error).toContain("git worktree failed");
});

test("unfalsified commands, edited existing tests and an out-of-scope new file produce all four sorted flags", async () => {
  const state = scratch();
  const cwd = repository();
  const { client } = await connect(state, {
    MOCK_WRITE_FILES: JSON.stringify({ production: "after\n", "existing.check": "true\n# edited\n", "rogue.txt": "extra\n" }),
  });
  const started = await call(client, "codex_implement", {
    ...contract, cwd, verify_commands: ["sh existing.check"], test_paths: ["*.check"], scope: ["production"],
  });
  await done(client, started.job_id);
  expect(lines(state)).toHaveLength(1);
  expect(lines(state)[0]).toMatchObject({
    caught_by: ["falsification", "new_unclassified", "out_of_scope", "tests_modified"],
    evidence: {
      passed: true, environment: "worktree", error: null,
      failed_setup: [], failed_commands: [], timed_out: [],
      falsification_ran: true, falsification_skipped_reason: null,
      unfalsified: ["sh existing.check"], tests_modified: ["existing.check"],
      out_of_scope: ["rogue.txt"], new_unclassified: ["rogue.txt"],
    },
  });
  assertPrivate(lines(state)[0]);
});

test("a pre-turn retry writes only one outcome, after verification finishes", async () => {
  const state = scratch();
  const cwd = scratch();
  const { client } = await connect(state, {
    CODEX_ARGS: join(mcpDir, "test/retry-codex.ts"), ATTEMPT_FILE: join(cwd, "attempt"),
    CRASH_PHASE: "starting", C2C_RETRIES: "1",
  });
  const started = await call(client, "codex_implement", {
    ...contract, cwd, verify_commands: ["sleep 0.2; true"],
  });
  const finished = await done(client, started.job_id);
  expect(finished.attempts).toBe(2);
  expect(lines(state)).toHaveLength(1);
  expect(lines(state)[0]).toMatchObject({ job_id: started.job_id, attempts: 2, state: "done", evidence: { passed: true } });
  // Polling/result lookup and asynchronous finalization callbacks cannot append again.
  await call(client, "codex_result", { job_id: started.job_id });
  await Bun.sleep(100);
  expect(lines(state)).toHaveLength(1);
});

test("dependency fail-fast cascades append one line per dependent without running verification", async () => {
  const state = scratch();
  const { client } = await connect(state, {
    CODEX_ARGS: join(mcpDir, "test/crash-codex.ts"), CRASH_MARKER: join(scratch(), "marker"), CRASH_DELAY_MS: "500",
  });
  const first = await call(client, "codex_implement", contract);
  const second = await call(client, "codex_implement", { ...contract, depends_on: first.job_id, verify_commands: ["false"] });
  const third = await call(client, "codex_implement", { ...contract, depends_on: second.job_id, verify_commands: ["false"] });
  expect(second.state).toBe("blocked");
  expect(third.state).toBe("blocked");
  for (const job of [first, second, third]) expect((await done(client, job.job_id)).state).toBe("error");
  const logged = lines(state);
  expect(logged.map((line) => line.job_id).sort()).toEqual([first.job_id, second.job_id, third.job_id].sort());
  for (const line of logged) expect(line).toMatchObject({ caught_by: ["worker_error"], evidence: null });
  expect(logged.find((line) => line.job_id === third.job_id).error).toContain(second.job_id);
});

test("unwritable state directories and failed appends never fail a job and warn at most once", async () => {
  for (const appendOnlyFailure of [false, true]) {
    const dir = scratch();
    const state = appendOnlyFailure ? join(dir, "state") : join(dir, "blocker/state");
    if (appendOnlyFailure) mkdirSync(join(state, "outcomes.jsonl"), { recursive: true });
    else writeFileSync(join(dir, "blocker"), "file");
    const { client, stderr } = await connect(state);
    for (let index = 0; index < 2; index++) {
      const started = await call(client, "codex_implement", contract);
      expect((await done(client, started.job_id)).state).toBe("done");
      expect(await call(client, "codex_result", { job_id: started.job_id })).toMatchObject({ state: "done", error: null });
    }
    await client.close();
    const warnings = stderr().trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(warnings).toHaveLength(1);
    expect(warnings[0].event).toBe("persistence_degraded");
  }
});

test("C2C_MAX_JOBS=3 keeps three job files and all five append-only outcome lines across restart and pruning", async () => {
  const state = scratch();
  let { client } = await connect(state, { C2C_MAX_JOBS: "3" });
  const ids: string[] = [];
  let prefix = "";
  for (let index = 0; index < 5; index++) {
    const started = await call(client, "codex_implement", contract);
    ids.push(started.job_id);
    await done(client, started.job_id);
    const contents = readFileSync(join(state, "outcomes.jsonl"), "utf8");
    expect(contents.startsWith(prefix)).toBe(true);
    prefix = contents;
  }
  const jobFiles = () => readdirSync(state).filter((name) => name.endsWith(".json")).sort();
  expect(jobFiles()).toEqual(ids.slice(-3).map((id) => `${id}.json`).sort());
  expect(lines(state).map((line) => line.job_id)).toEqual(ids);
  await client.close();
  ({ client } = await connect(state, { C2C_MAX_JOBS: "3" }));
  expect(jobFiles()).toHaveLength(3);
  expect(lines(state)).toHaveLength(5);
  expect(readFileSync(join(state, "outcomes.jsonl"), "utf8")).toBe(prefix);
  expect(statSync(join(state, "outcomes.jsonl")).mode & 0o777).toBe(0o600);
  expect(existsSync(join(state, `${ids[0]}.json`))).toBe(false);
});

test("C2C_MAX_JOBS clamps to one and falls back to 500 for invalid configuration", () => {
  const original = process.env.C2C_MAX_JOBS;
  try {
    for (const value of ["0", "-3", "invalid"]) {
      process.env.C2C_MAX_JOBS = value;
      const store = createJobStore(scratch());
      for (let i = 0; i < 3; i++) {
        store.save({ id: String(i), kind: "implement", state: "done", goalSet: false, turns: 1, transcript: [], startedAt: new Date(i).toISOString() });
      }
      expect(store.listJobs()).toHaveLength(value === "invalid" ? 3 : 1);
    }
  } finally {
    if (original === undefined) delete process.env.C2C_MAX_JOBS;
    else process.env.C2C_MAX_JOBS = original;
  }
});
