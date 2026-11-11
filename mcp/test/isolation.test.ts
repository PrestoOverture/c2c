import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "c2c-isolation-test-")));
  dirs.push(dir);
  return dir;
}
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }).trim();
function repository() {
  const repo = scratch();
  const cwd = join(repo, "sub dir");
  mkdirSync(cwd);
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Isolation Test");
  writeFileSync(join(cwd, "production.txt"), "before\n");
  writeFileSync(join(cwd, "deleted.check"), "true\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  return { repo, cwd, base: git(repo, "rev-parse", "HEAD") };
}
async function connect(state: string) {
  const client = new Client({ name: "isolation-test", version: "1" });
  await client.connect(new StdioClientTransport({
    command: "bun", args: [join(mcpDir, "src/server.ts")], cwd: mcpDir, stderr: "pipe",
    env: { ...process.env as Record<string, string>, CODEX_BIN: "bun", CODEX_ARGS: join(mcpDir, "test/isolation-worker.ts"),
      C2C_STATE_DIR: state, C2C_LOG_LEVEL: "silent", C2C_RETRIES: "0", C2C_MAX_CONCURRENT: "2" },
  }));
  clients.push(client);
  return client;
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
  throw new Error("isolation job did not finish");
}
const contract = { goal: "write:alpha", constraints: [], success_conditions: ["fixture passes"] };
const delta = { findings: ["write:alpha"], failed_conditions: [] };
const outcomes = (state: string) => readFileSync(join(state, "outcomes.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));

test("isolated worker uses the matching subdirectory, excludes dirty source edits, and retains its worktree", async () => {
  const { repo, cwd, base } = repository();
  writeFileSync(join(cwd, "production.txt"), "staged\n");
  git(repo, "add", ".");
  writeFileSync(join(cwd, "production.txt"), "unstaged\n");
  writeFileSync(join(cwd, "source-only"), "private\n");
  const before = { status: git(repo, "status", "--porcelain"), index: readFileSync(join(repo, ".git/index")), head: git(repo, "rev-parse", "HEAD") };
  const state = scratch();
  const client = await connect(state);
  const started = await call(client, "codex_implement", { ...contract, cwd, isolation: "worktree",
    verify_commands: ["grep -q before production.txt && test ! -e source-only && test -f alpha.txt; touch snapshot-only"] });
  const status = await done(client, started.job_id);
  expect(status.state).toBe("done");
  const path = join(state, "worktrees", started.job_id);
  expect(status.isolation).toEqual({ mode: "worktree", worktree_path: path, branch: `c2c/${started.job_id}`, base_commit: base, target_branch: git(repo, "branch", "--show-current"), source_dirty: true, note: null });
  expect(JSON.parse(readFileSync(join(path, "sub dir/alpha.txt"), "utf8"))).toMatchObject({ cwd: join(path, "sub dir"), threadCwd: join(path, "sub dir"), branch: status.isolation.branch });
  expect(status.evidence.passed).toBe(true);
  expect(status.evidence.changes.files.map((f: any) => f.path)).toEqual(["sub dir/alpha.txt"]);
  expect(existsSync(join(cwd, "alpha.txt"))).toBe(false);
  expect(existsSync(join(path, "sub dir/snapshot-only"))).toBe(false);
  expect({ status: git(repo, "status", "--porcelain"), index: readFileSync(join(repo, ".git/index")), head: git(repo, "rev-parse", "HEAD") }).toEqual(before);
  expect(readFileSync(join(cwd, "production.txt"), "utf8")).toBe("unstaged\n");
  expect(git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(2);
  expect((await call(client, "codex_result", { job_id: started.job_id })).isolation).toEqual(status.isolation);
  expect(outcomes(state)[0]).toMatchObject({ isolation: "worktree", branch: status.isolation.branch });
});

test("rework by job and thread reuses the worktree, branch and base, including after restart", async () => {
  const { repo, cwd } = repository();
  const state = scratch();
  let client = await connect(state);
  const first = await call(client, "codex_implement", { ...contract, goal: "write:alpha commit:true", cwd, isolation: "worktree", verify_commands: ["test -f alpha.txt"] });
  const initial = await done(client, first.job_id);
  expect(initial.state).toBe("done");
  const second = await call(client, "codex_rework", { ...delta, job_id: first.job_id, cwd: scratch() });
  expect((await done(client, second.job_id)).isolation).toEqual(initial.isolation);
  await client.close();
  client = await connect(state);
  const third = await call(client, "codex_rework", { ...delta, thread_id: initial.thread_id });
  const final = await done(client, third.job_id);
  expect(final.state).toBe("done");
  expect(final.parent_job_id).toBe(second.job_id);
  expect(final.isolation).toEqual(initial.isolation);
  expect(final.evidence.changes.files).toEqual([{ path: "sub dir/alpha.txt", status: "added", class: "production" }]);
  expect(JSON.parse(readFileSync(join(initial.isolation.worktree_path, "sub dir/alpha.txt"), "utf8"))).toMatchObject({ rounds: 3, branch: initial.isolation.branch, cwd: join(initial.isolation.worktree_path, "sub dir") });
  expect(git(repo, "status", "--porcelain")).toBe("");
  expect(outcomes(state).map((o) => [o.isolation, o.branch])).toEqual(Array(3).fill(["worktree", initial.isolation.branch]));
  expect(createJobStore(state).listJobs()).toHaveLength(3);
  // The store must never recurse into persistent worktrees looking for records.
  writeFileSync(join(initial.isolation.worktree_path, "fake.json"), JSON.stringify({ id: "fake", startedAt: new Date().toISOString(), transcript: [] }));
  expect(createJobStore(state).getJob("fake")).toBeUndefined();
  rmSync(initial.isolation.worktree_path, { recursive: true, force: true });
  for (const identity of [{ job_id: first.job_id }, { thread_id: initial.thread_id }]) {
    const rejected: any = await client.callTool({ name: "codex_rework", arguments: { ...delta, ...identity } });
    expect(rejected.isError).toBe(true);
    expect(rejected.content[0].text).toContain("isolated worktree no longer exists");
  }
  expect(outcomes(state)).toHaveLength(3);
});

test("committed changes and deleted committed tests are classified against the base and falsified", async () => {
  const { repo, cwd, base } = repository();
  const client = await connect(scratch());
  const started = await call(client, "codex_implement", { ...contract, goal: "write:alpha commit:true falsify:true", cwd, isolation: "worktree",
    verify_commands: ["sh added.check"], test_paths: ["*.check"], scope: ["production.txt", "alpha.txt"] });
  const status = await done(client, started.job_id);
  expect(status.state).toBe("done");
  expect(git(status.isolation.worktree_path, "rev-parse", "HEAD")).not.toBe(base);
  expect(status.evidence.base_commit).toBe(base);
  expect(status.evidence.passed).toBe(true);
  expect(status.evidence.changes).toEqual({ files: [
    { path: "sub dir/added.check", status: "added", class: "test" },
    { path: "sub dir/alpha.txt", status: "added", class: "production" },
    { path: "sub dir/deleted.check", status: "deleted", class: "test" },
    { path: "sub dir/production.txt", status: "modified", class: "production" },
  ], tests_modified: ["sub dir/deleted.check"], out_of_scope: [], new_unclassified: [] });
  expect(status.evidence.falsification.ran).toBe(true);
  expect(status.evidence.falsification.commands[0]).toMatchObject({ exit_code: 1, still_passes: false });
  expect(status.evidence.falsification.commands[0].output_tail).toContain("checking-committed-test");
  expect(status.evidence.falsification.unfalsified).toEqual([]);
  expect(git(repo, "status", "--porcelain")).toBe("");
  expect(git(repo, "rev-parse", "HEAD")).toBe(base);
});

test("two concurrent isolated jobs only see their own changes in evidence and keep the source clean", async () => {
  const { repo, cwd } = repository();
  const client = await connect(scratch());
  const started = await Promise.all(["alpha", "beta"].map((name) => call(client, "codex_implement", {
    ...contract, goal: `write:${name}`, cwd, isolation: "worktree", verify_commands: [
      `test -f ${name}.txt && test ! -e ${name === "alpha" ? "beta" : "alpha"}.txt && sleep 0.2`,
    ],
  })));
  const statuses = await Promise.all(started.map((job) => done(client, job.job_id)));
  expect(started.map((job) => job.state)).toEqual(["starting", "starting"]);
  expect(statuses[0].isolation.worktree_path).not.toBe(statuses[1].isolation.worktree_path);
  expect(statuses[0].isolation.branch).not.toBe(statuses[1].isolation.branch);
  statuses.forEach((status, i) => {
    expect(status.state).toBe("done");
    expect(status.isolation.source_dirty).toBe(false);
    expect(status.evidence.passed).toBe(true);
    expect(status.evidence.changes.files.map((f: any) => f.path)).toEqual([`sub dir/${i === 0 ? "alpha" : "beta"}.txt`]);
  });
  expect(git(repo, "status", "--porcelain")).toBe("");
  expect(git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(3);
});

test("non-git isolation falls back with a note; default jobs keep outputs and records unchanged", async () => {
  const state = scratch();
  const client = await connect(state);
  const cwd = scratch();
  const isolated = await call(client, "codex_implement", { ...contract, cwd, isolation: "worktree" });
  const status = await done(client, isolated.job_id);
  expect(status.state).toBe("done");
  expect(status.isolation).toMatchObject({ mode: "in_place", worktree_path: null, branch: null, base_commit: null, source_dirty: false });
  expect(status.isolation.note).toContain("not inside a git repository");
  expect(JSON.parse(readFileSync(join(cwd, "alpha.txt"), "utf8"))).toMatchObject({ cwd, threadCwd: cwd });
  expect(outcomes(state)[0]).toMatchObject({ isolation: "in_place", branch: null });
  const plain = await call(client, "codex_implement", { ...contract, cwd: scratch() });
  expect((await done(client, plain.job_id)).isolation).toBeUndefined();
  expect((await call(client, "codex_result", { job_id: plain.job_id })).isolation).toBeUndefined();
  expect(JSON.parse(readFileSync(join(state, `${plain.job_id}.json`), "utf8"))).not.toHaveProperty("isolation");
  expect(outcomes(state)[1]).not.toHaveProperty("isolation");
});

test("worktree creation failures fail the job with the git message and never run the worker in place", async () => {
  for (const failure of ["hook", "branch"]) {
    const { repo, cwd } = repository();
    if (failure === "hook") writeFileSync(join(repo, ".git/hooks/post-checkout"), "#!/bin/sh\necho isolation-checkout-failed >&2\nexit 5\n", { mode: 0o755 });
    else git(repo, "branch", "c2c"); // Blocks the c2c/<job_id> ref namespace.
    const client = await connect(scratch());
    const started = await call(client, "codex_implement", { ...contract, cwd, isolation: "worktree" });
    const status = await done(client, started.job_id);
    expect(status.state).toBe("error");
    expect(status.error).toContain(failure === "hook" ? "isolation-checkout-failed" : "cannot lock ref");
    expect(status.turns).toBe(0);
    expect(existsSync(join(cwd, "alpha.txt"))).toBe(false);
    expect(git(repo, "status", "--porcelain")).toBe("");
  }
});
