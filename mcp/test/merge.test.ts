import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const mcpDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const dirs: string[] = [];
const clients: Client[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function scratch() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "c2c-integration-test-")));
  dirs.push(dir);
  return dir;
}
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, {
  cwd, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, stdio: ["ignore", "pipe", "pipe"],
}).trim();
function commit(repo: string, message = "target change") {
  git(repo, "add", ".");
  git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--no-verify", "-qm", message);
}
function repository() {
  const repo = scratch();
  const cwd = join(repo, "sub dir");
  mkdirSync(cwd);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, ".gitignore"), "ignored.txt\n");
  writeFileSync(join(cwd, "production.txt"), "before\n");
  commit(repo, "base");
  return { repo, cwd, base: git(repo, "rev-parse", "HEAD") };
}
async function connect(state: string, maxConcurrent = 2, env: Record<string, string> = {}) {
  const client = new Client({ name: "merge-test", version: "1" });
  await client.connect(new StdioClientTransport({
    command: "bun", args: [join(mcpDir, "src/server.ts")], cwd: mcpDir, stderr: "pipe",
    env: { ...process.env as Record<string, string>, CODEX_BIN: "bun", CODEX_ARGS: join(mcpDir, "test/isolation-worker.ts"),
      C2C_STATE_DIR: state, C2C_LOG_LEVEL: "silent", C2C_RETRIES: "0", C2C_MAX_CONCURRENT: String(maxConcurrent),
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...env },
  }));
  clients.push(client);
  return client;
}
async function raw(client: Client, name: string, args: Record<string, unknown>) {
  const result: any = await client.callTool({ name, arguments: args });
  let data;
  try { data = JSON.parse(result.content[0].text); } catch { data = { error: result.content[0].text }; }
  return { data, isError: result.isError ?? false };
}
async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await raw(client, name, args);
  expect(result.isError).toBe(false);
  return result.data;
}
async function done(client: Client, id: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const status = await call(client, "codex_status", { job_id: id });
    if (["done", "error", "timeout"].includes(status.state)) return status;
    await Bun.sleep(20);
  }
  throw new Error("merge fixture job did not finish");
}
async function submit(client: Client, cwd: string, extra: Record<string, unknown> = {}) {
  return call(client, "codex_implement", { goal: "write:alpha", constraints: [], success_conditions: ["fixture passes"],
    cwd, isolation: "worktree", verify_commands: ["test -f alpha.txt"], ...extra });
}
const outcomes = (state: string) => readFileSync(join(state, "outcomes.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
const treeState = (repo: string) => ({
  head: git(repo, "rev-parse", "HEAD"), status: git(repo, "status", "--porcelain", "--untracked-files=all"),
  diff: git(repo, "diff", "--binary", "HEAD"),
  index: readFileSync(join(git(repo, "rev-parse", "--absolute-git-dir"), "index")).toString("base64"),
});
function noTemporaryTrees(repo: string, count: number) {
  const trees = git(repo, "worktree", "list", "--porcelain");
  expect(trees).not.toContain("c2c-merge-");
  expect(trees.match(/^worktree /gm)).toHaveLength(count);
}

test("captures uncommitted worker output after evidence; merges, updates source, cleans up and records outcome", async () => {
  const { repo, cwd, base } = repository();
  // Both capture and merge commits must bypass hooks and work without repo identity.
  writeFileSync(join(repo, ".git/hooks/pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  writeFileSync(join(repo, ".git/hooks/pre-merge-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const state = scratch();
  const client = await connect(state);
  const started = await submit(client, cwd, {
    setup_commands: ["echo setup-ran > ignored.txt"],
    verify_commands: ["test -f alpha.txt && test -f ignored.txt && test -n \"$(git status --porcelain)\""],
  });
  const status = await done(client, started.job_id);
  expect(status.state).toBe("done");
  expect(status.evidence.passed).toBe(true);
  const tree = status.isolation.worktree_path;
  expect(status.isolation.target_branch).toBe("main");
  expect(git(tree, "status", "--porcelain")).toBe("");
  const tip = git(tree, "rev-parse", "HEAD");
  expect(tip).not.toBe(base);
  expect(git(tree, "show", `${tip}:sub dir/alpha.txt`)).toBe(readFileSync(join(tree, "sub dir/alpha.txt"), "utf8"));
  expect(git(tree, "log", "-1", "--format=%an <%ae>")).toBe("c2c <c2c@localhost>");
  // Set verification for a clean merge run via rework: setup should execute again.
  const rework = await call(client, "codex_rework", { job_id: started.job_id, findings: ["write:alpha"], failed_conditions: [],
    verify_commands: ["test -f alpha.txt && grep -q setup-ran ignored.txt"] });
  const latest = await done(client, rework.job_id);
  expect(latest.evidence.passed).toBe(true);
  const output = readFileSync(join(tree, "sub dir/alpha.txt"), "utf8");
  const merged = await call(client, "codex_merge", { job_id: started.job_id });
  expect(merged).toMatchObject({ job_id: rework.job_id, status: "merged", cleaned_up: true });
  expect(git(repo, "rev-parse", "HEAD")).toBe(merged.commit);
  expect(git(repo, "show", `${merged.commit}:sub dir/alpha.txt`)).toBe(output);
  expect(readFileSync(join(cwd, "alpha.txt"), "utf8")).toBe(output);
  expect(git(repo, "rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toHaveLength(3);
  expect(git(repo, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain("ignored.txt");
  expect(existsSync(tree)).toBe(false);
  expect(git(repo, "branch", "--list", status.isolation.branch)).toBe("");
  expect((await call(client, "codex_result", { job_id: rework.job_id })).merge).toEqual(merged);
  expect(outcomes(state).filter((o) => o.kind === "merge")).toHaveLength(1);
  expect(outcomes(state).at(-1)).toMatchObject({ kind: "merge", job_id: rework.job_id, merge: { status: "merged" } });
  expect(outcomes(state).at(-1).evidence).not.toHaveProperty("commands");
  noTemporaryTrees(repo, 1);
  const rejected = await raw(client, "codex_rework", { job_id: started.job_id, findings: ["write:alpha"], failed_conditions: [] });
  expect(rejected.isError).toBe(true);
  expect(rejected.data.error).toContain("isolated worktree no longer exists");
});

test("refuses missing/failing evidence and running latest rework; all attempts are recorded", async () => {
  const { repo, cwd } = repository();
  const state = scratch();
  const client = await connect(state);
  for (const verify_commands of [[], ["false"]]) {
    const start = await submit(client, cwd, { verify_commands });
    const status = await done(client, start.job_id);
    expect(status.state).toBe("done");
    expect(status.evidence?.passed ?? null).toBe(verify_commands.length ? false : null);
    expect(git(status.isolation.worktree_path, "status", "--porcelain")).toBe("");
    expect(git(status.isolation.worktree_path, "ls-tree", "-r", "--name-only", "HEAD")).toContain("sub dir/alpha.txt");
    const before = treeState(repo);
    const isolated = treeState(status.isolation.worktree_path);
    const rejected = await raw(client, "codex_merge", { job_id: start.job_id });
    expect(rejected.isError).toBe(true);
    expect(rejected.data).toMatchObject({ status: "refused" });
    expect(rejected.data.error).toContain("passing server evidence");
    expect(treeState(repo)).toEqual(before);
    expect(treeState(status.isolation.worktree_path)).toEqual(isolated);
  }
  const first = await submit(client, cwd);
  await done(client, first.job_id);
  const next = await call(client, "codex_rework", { job_id: first.job_id, findings: ["write:alpha"], failed_conditions: [], verify_commands: ["sleep 0.3; test -f alpha.txt"] });
  const rejected = await raw(client, "codex_merge", { job_id: first.job_id });
  expect(rejected.isError).toBe(true);
  expect(rejected.data.job_id).toBe(next.job_id);
  expect(rejected.data.error).toContain("not done");
  await done(client, next.job_id);
  expect(outcomes(state).filter((o) => o.kind === "merge")).toHaveLength(3);
});

test("conflict reports files and preserves target and job worktree byte for byte", async () => {
  const { repo, cwd } = repository();
  const client = await connect(scratch());
  const first = await submit(client, cwd);
  const status = await done(client, first.job_id);
  writeFileSync(join(cwd, "alpha.txt"), "target version\n");
  commit(repo);
  writeFileSync(join(cwd, "production.txt"), "dirty unrelated\n");
  const source = treeState(repo);
  const worker = treeState(status.isolation.worktree_path);
  const result = await call(client, "codex_merge", { job_id: first.job_id });
  expect(result).toMatchObject({ status: "conflict", files: ["sub dir/alpha.txt"] });
  expect(treeState(repo)).toEqual(source);
  expect(treeState(status.isolation.worktree_path)).toEqual(worker);
  expect(readFileSync(join(cwd, "production.txt"), "utf8")).toBe("dirty unrelated\n");
  noTemporaryTrees(repo, 2);
});

test("passing job evidence cannot bypass verification of the merged tree", async () => {
  const { repo, cwd } = repository();
  const state = scratch();
  const client = await connect(state);
  const first = await submit(client, cwd, { setup_commands: ["echo ready > ignored.txt"], verify_commands: ["test -f ignored.txt && test -f alpha.txt && test ! -f incompatible.txt"] });
  const status = await done(client, first.job_id);
  expect(status.evidence.passed).toBe(true);
  writeFileSync(join(cwd, "incompatible.txt"), "target-only incompatibility\n");
  commit(repo);
  const source = treeState(repo);
  const worker = treeState(status.isolation.worktree_path);
  const result = await call(client, "codex_merge", { job_id: first.job_id });
  expect(result.status).toBe("verification_failed");
  expect(result.evidence.passed).toBe(false);
  expect(result.evidence.setup[0].exit_code).toBe(0);
  expect(result.evidence.commands[0].exit_code).toBe(1);
  expect(treeState(repo)).toEqual(source);
  expect(treeState(status.isolation.worktree_path)).toEqual(worker);
  expect(outcomes(state).at(-1)).toMatchObject({ kind: "merge", merge: { status: "verification_failed" }, evidence: { passed: false } });
  noTemporaryTrees(repo, 2);
});

test("dirty overlap blocks final fast-forward and preserves target and job tree", async () => {
  const { repo, cwd } = repository();
  const client = await connect(scratch());
  const first = await submit(client, cwd);
  const status = await done(client, first.job_id);
  writeFileSync(join(cwd, "alpha.txt"), "untracked caller output\n");
  const source = treeState(repo);
  const worker = treeState(status.isolation.worktree_path);
  const result = await call(client, "codex_merge", { job_id: first.job_id });
  expect(result.status).toBe("target_blocked");
  expect(treeState(repo)).toEqual(source);
  expect(treeState(status.isolation.worktree_path)).toEqual(worker);
  expect(readFileSync(join(cwd, "alpha.txt"), "utf8")).toBe("untracked caller output\n");
  noTemporaryTrees(repo, 2);
});

test("a target moved during verification is blocked; no stale merge is applied", async () => {
  const { repo, cwd } = repository();
  const state = scratch();
  const marker = join(state, "merged-check");
  const client = await connect(state);
  const first = await submit(client, cwd, { verify_commands: [`test -f alpha.txt; if test "$(git rev-list --parents -n 1 HEAD | wc -w)" -eq 3; then touch '${marker}'; sleep 0.4; fi`] });
  const status = await done(client, first.job_id);
  const worker = treeState(status.isolation.worktree_path);
  const pending = call(client, "codex_merge", { job_id: first.job_id });
  const deadline = Date.now() + 5000;
  while (!existsSync(marker) && Date.now() < deadline) await Bun.sleep(10);
  expect(existsSync(marker)).toBe(true);
  const rejected = await raw(client, "codex_rework", { job_id: first.job_id, findings: ["write:alpha"], failed_conditions: [] });
  expect(rejected.isError).toBe(true);
  expect(rejected.data.error).toContain("worktree is being merged");
  writeFileSync(join(cwd, "target.txt"), "moved target\n");
  commit(repo);
  const source = treeState(repo);
  const result = await pending;
  expect(result.status).toBe("target_blocked");
  expect(result.error).toContain("moved");
  expect(treeState(repo)).toEqual(source);
  expect(treeState(status.isolation.worktree_path)).toEqual(worker);
  noTemporaryTrees(repo, 2);
});

test("discard removes branch/worktree without changing target and rejects rework after restart", async () => {
  const { repo, cwd } = repository();
  const state = scratch();
  let client = await connect(state);
  const first = await submit(client, cwd);
  const status = await done(client, first.job_id);
  const source = treeState(repo);
  const result = await call(client, "codex_merge", { job_id: first.job_id, discard: true });
  expect(result).toMatchObject({ status: "discarded", cleaned_up: true });
  expect(treeState(repo)).toEqual(source);
  expect(existsSync(status.isolation.worktree_path)).toBe(false);
  expect(git(repo, "branch", "--list", status.isolation.branch)).toBe("");
  noTemporaryTrees(repo, 1);
  await client.close();
  client = await connect(state);
  for (const identity of [{ job_id: first.job_id }, { thread_id: status.thread_id }]) {
    const rejected = await raw(client, "codex_rework", { ...identity, findings: ["write:alpha"], failed_conditions: [] });
    expect(rejected.isError).toBe(true);
    expect(rejected.data.error).toContain("isolated worktree no longer exists");
  }
  expect((await call(client, "codex_result", { job_id: first.job_id })).merge).toEqual(result);
});

test("discard drops work whose evidence failed, but not while a rework is running", async () => {
  const { repo, cwd } = repository();
  const client = await connect(scratch());
  const failed = await submit(client, cwd, { verify_commands: ["false"] });
  const status = await done(client, failed.job_id);
  expect(status.evidence.passed).toBe(false);
  const next = await call(client, "codex_rework", { job_id: failed.job_id, findings: ["write:alpha"], failed_conditions: [], verify_commands: ["sleep 0.3; false"] });
  const busy = await raw(client, "codex_merge", { job_id: failed.job_id, discard: true });
  expect(busy.isError).toBe(true);
  expect(busy.data.error).toContain("active or pending");
  expect(existsSync(status.isolation.worktree_path)).toBe(true);
  await done(client, next.job_id);
  const source = treeState(repo);
  expect(await call(client, "codex_merge", { job_id: failed.job_id, discard: true })).toMatchObject({ status: "discarded", cleaned_up: true });
  expect(treeState(repo)).toEqual(source);
  expect(existsSync(status.isolation.worktree_path)).toBe(false);
  expect(git(repo, "branch", "--list", status.isolation.branch)).toBe("");
});

test("isolated dependent branches from dependency tip and inherits its original target", async () => {
  const { repo, cwd } = repository();
  const client = await connect(scratch());
  const first = await submit(client, cwd);
  const second = await submit(client, cwd, { goal: "write:beta", depends_on: first.job_id, verify_commands: ["test -f alpha.txt && test -f beta.txt"] });
  const dependency = await done(client, first.job_id);
  const dependent = await done(client, second.job_id);
  expect(dependent.state).toBe("done");
  expect(dependent.evidence.passed).toBe(true);
  expect(dependent.isolation.base_commit).toBe(git(dependency.isolation.worktree_path, "rev-parse", "HEAD"));
  expect(dependent.isolation.target_branch).toBe(dependency.isolation.target_branch);
  expect(dependent.isolation.target_branch).toBe("main");
  expect(existsSync(join(dependent.isolation.worktree_path, "sub dir/alpha.txt"))).toBe(true);
  const result = await call(client, "codex_merge", { job_id: second.job_id });
  expect(result.status).toBe("merged");
  expect(existsSync(join(cwd, "alpha.txt"))).toBe(true);
  expect(existsSync(join(cwd, "beta.txt"))).toBe(true);
  noTemporaryTrees(repo, 2);
});

test("concurrent merge calls land serially with cleanup=false; unrelated dirty files survive", async () => {
  const { repo, cwd } = repository();
  const state = scratch();
  const lock = join(state, "verify-lock");
  const client = await connect(state);
  const started = await Promise.all(["alpha", "beta"].map((name) => submit(client, cwd, { goal: `write:${name}`, verify_commands: [
    `test -f ${name}.txt && if test "$(git rev-list --parents -n 1 HEAD | wc -w)" -eq 3; then mkdir '${lock}' || exit 1; sleep 0.15; rmdir '${lock}'; fi`,
  ] })));
  const statuses = await Promise.all(started.map((s) => done(client, s.job_id)));
  writeFileSync(join(cwd, "production.txt"), "dirty unrelated\n");
  const results = await Promise.all(started.map((s) => call(client, "codex_merge", { job_id: s.job_id, cleanup: false })));
  expect(results.map((r) => r.status)).toEqual(["merged", "merged"]);
  expect(git(repo, "rev-parse", "HEAD")).toBe(results[1].commit);
  expect(git(repo, "rev-parse", `${results[1].commit}^1`)).toBe(results[0].commit);
  expect(readFileSync(join(cwd, "production.txt"), "utf8")).toBe("dirty unrelated\n");
  for (const name of ["alpha", "beta"]) expect(existsSync(join(cwd, `${name}.txt`))).toBe(true);
  for (const status of statuses) {
    expect(existsSync(status.isolation.worktree_path)).toBe(true);
    expect(git(repo, "branch", "--list", status.isolation.branch)).toContain(status.isolation.branch);
  }
  expect(outcomes(state).filter((o) => o.kind === "merge").map((o) => o.merge.status)).toEqual(["merged", "merged"]);
  noTemporaryTrees(repo, 3);
});

test("target branch not checked out uses compare-and-swap; detached creation has no target", async () => {
  const { repo, cwd, base } = repository();
  const client = await connect(scratch());
  const first = await submit(client, cwd);
  await done(client, first.job_id);
  git(repo, "checkout", "--detach", "-q");
  const result = await call(client, "codex_merge", { job_id: first.job_id });
  expect(result.status).toBe("merged");
  expect(git(repo, "rev-parse", "main")).toBe(result.commit);
  expect(git(repo, "rev-parse", "HEAD")).toBe(base);
  expect(existsSync(join(cwd, "alpha.txt"))).toBe(false);
  const detached = await submit(client, cwd);
  const status = await done(client, detached.job_id);
  expect(status.isolation.target_branch).toBeNull();
  const source = treeState(repo);
  expect((await call(client, "codex_merge", { job_id: detached.job_id })).status).toBe("target_blocked");
  expect(treeState(repo)).toEqual(source);
});


test("latest failed evidence governs merging an older job id, including after restart", async () => {
  const { repo, cwd } = repository();
  const state = scratch();
  let client = await connect(state);
  const first = await submit(client, cwd);
  expect((await done(client, first.job_id)).evidence.passed).toBe(true);
  const rework = await call(client, "codex_rework", { job_id: first.job_id, findings: ["write:alpha"], failed_conditions: [], verify_commands: ["false"] });
  const status = await done(client, rework.job_id);
  expect(status.evidence.passed).toBe(false);
  await client.close();
  // Millisecond timestamps can tie. Restart disk order must not let an older
  // passing round override the latest failing round's evidence.
  const older = JSON.parse(readFileSync(join(state, `${first.job_id}.json`), "utf8"));
  older.startedAt = status.started_at;
  renameSync(join(state, `${first.job_id}.json`), join(state, "zzz-older.json"));
  writeFileSync(join(state, "zzz-older.json"), JSON.stringify(older));
  client = await connect(state);
  const source = treeState(repo);
  const worker = treeState(status.isolation.worktree_path);
  const result = await raw(client, "codex_merge", { job_id: first.job_id });
  expect(result.isError).toBe(true);
  expect(result.data).toMatchObject({ status: "refused", job_id: rework.job_id });
  expect(treeState(repo)).toEqual(source);
  expect(treeState(status.isolation.worktree_path)).toEqual(worker);
  expect(outcomes(state).at(-1)).toMatchObject({ kind: "merge", job_id: rework.job_id, merge: { status: "refused" } });
});

test("merged setup failure stops verification and preserves both trees", async () => {
  const { repo, cwd } = repository();
  const client = await connect(scratch());
  const first = await submit(client, cwd, {
    setup_commands: ['test "$(git rev-list --parents -n 1 HEAD | wc -w)" -ne 3'],
  });
  const status = await done(client, first.job_id);
  expect(status.evidence.passed).toBe(true);
  const source = treeState(repo);
  const worker = treeState(status.isolation.worktree_path);
  const result = await call(client, "codex_merge", { job_id: first.job_id });
  expect(result.status).toBe("verification_failed");
  expect(result.evidence.setup[0].exit_code).toBe(1);
  expect(result.evidence.commands).toEqual([]);
  expect(treeState(repo)).toEqual(source);
  expect(treeState(status.isolation.worktree_path)).toEqual(worker);
  noTemporaryTrees(repo, 2);
});

test("server capture includes modifications and deletions but excludes ignored worker output", async () => {
  const { repo, cwd } = repository();
  writeFileSync(join(cwd, "deleted.check"), "true\n");
  writeFileSync(join(repo, ".gitignore"), "ignored.txt\nalpha.txt\n");
  commit(repo);
  const client = await connect(scratch());
  const first = await submit(client, cwd, { goal: "write:alpha falsify:true", verify_commands: ["grep -q after production.txt && test ! -e deleted.check && test ! -e alpha.txt"] });
  const status = await done(client, first.job_id);
  expect(status.state).toBe("done");
  expect(status.evidence.passed).toBe(true);
  const worker = status.isolation.worktree_path;
  expect(existsSync(join(worker, "sub dir/alpha.txt"))).toBe(true);
  expect(git(worker, "status", "--porcelain")).toBe("");
  expect(git(worker, "show", "HEAD:sub dir/production.txt")).toBe("after");
  expect(git(worker, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain("deleted.check");
  expect(git(worker, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain("alpha.txt");
  const result = await call(client, "codex_merge", { job_id: first.job_id });
  expect(result.status).toBe("merged");
  expect(readFileSync(join(cwd, "production.txt"), "utf8")).toBe("after\n");
  expect(existsSync(join(cwd, "deleted.check"))).toBe(false);
  expect(existsSync(join(cwd, "alpha.txt"))).toBe(false);
  noTemporaryTrees(repo, 1);
});

test("tracked dirty overlap blocks integration without rewriting caller files or index", async () => {
  const { repo, cwd } = repository();
  writeFileSync(join(cwd, "alpha.txt"), JSON.stringify({ rounds: 0 }));
  commit(repo);
  const client = await connect(scratch());
  const first = await submit(client, cwd);
  const status = await done(client, first.job_id);
  writeFileSync(join(cwd, "alpha.txt"), "dirty caller version\n");
  const source = treeState(repo);
  const worker = treeState(status.isolation.worktree_path);
  const result = await call(client, "codex_merge", { job_id: first.job_id });
  expect(result.status).toBe("target_blocked");
  expect(treeState(repo)).toEqual(source);
  expect(readFileSync(join(cwd, "alpha.txt"), "utf8")).toBe("dirty caller version\n");
  expect(treeState(status.isolation.worktree_path)).toEqual(worker);
  noTemporaryTrees(repo, 2);
});

async function conflictFixture(env: Record<string, string> = {}) {
  const { repo, cwd, base } = repository();
  const state = scratch();
  const client = await connect(state, 2, env);
  const first = await submit(client, cwd, { test_paths: ["*.check"], scope: ["alpha.txt"] });
  const original = await done(client, first.job_id);
  writeFileSync(join(cwd, "alpha.txt"), JSON.stringify({ target: true, rounds: 0 }));
  writeFileSync(join(cwd, "target.txt"), "target production\n");
  writeFileSync(join(cwd, "target.check"), "target test\n");
  commit(repo);
  const target = git(repo, "rev-parse", "HEAD");
  expect(await call(client, "codex_merge", { job_id: first.job_id })).toMatchObject({ status: "conflict", files: ["sub dir/alpha.txt"] });
  return { repo, cwd, base, state, client, first, original, target };
}

test("conflict -> sync resolution -> job-only evidence -> merged target contains both sides", async () => {
  const { repo, cwd, state, client, first, original, target } = await conflictFixture();
  const source = treeState(repo);
  // Server commits must ignore signing and every commit/merge hook, including post hooks.
  git(repo, "config", "commit.gpgSign", "true");
  for (const hook of ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "pre-merge-commit", "post-merge"]) {
    writeFileSync(join(repo, `.git/hooks/${hook}`), "#!/bin/sh\ntouch hook-ran\nexit 1\n", { mode: 0o755 });
  }
  const next = await call(client, "codex_rework", { job_id: first.job_id, findings: ["write:alpha resolve:conflict observe:sync"], failed_conditions: [], sync_target: true,
    verify_commands: ["grep -q '\"resolved\":true' alpha.txt && test -f target.txt && test -f target.check"] });
  const status = await done(client, next.job_id);
  expect(status.state).toBe("done");
  expect(status.sync).toEqual({ target_branch: "main", target_commit: target, status: "conflict", files: ["sub dir/alpha.txt"], unresolved: [] });
  expect(status.isolation.base_commit).toBe(target);
  expect(status.isolation.base_commit).not.toBe(original.isolation.base_commit);
  expect(status.evidence.base_commit).toBe(target);
  expect(status.evidence.passed).toBe(true);
  expect(status.evidence.changes.files).toEqual([{ path: "sub dir/alpha.txt", status: "modified", class: "production" }]);
  expect(status.evidence.changes.tests_modified).toEqual([]);
  expect(status.evidence.changes.out_of_scope).toEqual([]);
  expect(status.evidence.changes.new_unclassified).toEqual([]);
  expect(status.evidence.falsification.ran).toBe(true);
  expect(status.evidence.falsification.unfalsified).toEqual([]);
  const tree = status.isolation.worktree_path;
  const observation = JSON.parse(readFileSync(join(tree, "sub dir/ignored.txt"), "utf8"));
  expect(observation.unmerged).toBe("sub dir/alpha.txt");
  expect(observation.prompt).toContain('Merged target "main"');
  expect(observation.prompt).toContain('"sub dir/alpha.txt"');
  expect(git(tree, "merge-base", "--is-ancestor", target, "HEAD")).toBe("");
  expect(git(tree, "rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toHaveLength(3);
  expect(git(tree, "status", "--porcelain")).toBe("");
  expect(existsSync(join(tree, "hook-ran"))).toBe(false);
  expect(treeState(repo)).toEqual(source);
  expect((await call(client, "codex_result", { job_id: next.job_id })).sync).toEqual(status.sync);
  expect(outcomes(state).find((o) => o.job_id === next.job_id)).toMatchObject({ sync: status.sync, evidence: { passed: true } });
  // Rework from an older id, after restart, must inherit the moved base.
  await client.close();
  const restarted = await connect(state);
  const later = await call(restarted, "codex_rework", { job_id: first.job_id, findings: ["write:alpha"], failed_conditions: [],
    verify_commands: ["test -f alpha.txt && test -f target.txt"] });
  const inherited = await done(restarted, later.job_id);
  expect(inherited.isolation.base_commit).toBe(target);
  expect(inherited.evidence.changes.files.map((f: any) => f.path)).toEqual(["sub dir/alpha.txt"]);
  const result = await call(restarted, "codex_merge", { job_id: first.job_id });
  expect(result).toMatchObject({ status: "merged", job_id: later.job_id });
  const alpha = JSON.parse(readFileSync(join(cwd, "alpha.txt"), "utf8"));
  expect(alpha).toMatchObject({ target: true, resolved: true, rounds: 3 });
  expect(alpha.threadId).toBe(original.thread_id);
  expect(readFileSync(join(cwd, "target.txt"), "utf8")).toBe("target production\n");
  expect(readFileSync(join(cwd, "target.check"), "utf8")).toBe("target test\n");
  expect(git(repo, "merge-base", "--is-ancestor", target, "HEAD")).toBe("");
  noTemporaryTrees(repo, 1);
});

test("unresolved conflict markers fail evidence even when verification passes, log caught_by and refuse merge", async () => {
  const { repo, client, first, state, target } = await conflictFixture();
  const source = treeState(repo);
  const next = await call(client, "codex_rework", { job_id: first.job_id, sync_target: true,
    findings: ["write:alpha leave:conflict"], failed_conditions: [], verify_commands: ["test -f alpha.txt"] });
  const status = await done(client, next.job_id);
  expect(status.state).toBe("done");
  expect(status.sync).toMatchObject({ status: "conflict", target_commit: target, unresolved: ["sub dir/alpha.txt"] });
  expect(status.evidence.commands[0].exit_code).toBe(0);
  expect(status.evidence.passed).toBe(false);
  expect(status.evidence.error).toContain("sub dir/alpha.txt");
  expect(status.evidence.changes.files.map((f: any) => f.path)).toEqual(["sub dir/alpha.txt"]);
  expect(git(status.isolation.worktree_path, "status", "--porcelain")).toBe("");
  expect(outcomes(state).find((o) => o.job_id === next.job_id)).toMatchObject({ sync: status.sync, caught_by: expect.arrayContaining(["conflict_unresolved"]) });
  expect((await call(client, "codex_result", { job_id: next.job_id })).sync).toEqual(status.sync);
  const refused = await raw(client, "codex_merge", { job_id: first.job_id });
  expect(refused.isError).toBe(true);
  expect(refused.data.status).toBe("refused");
  expect(treeState(repo)).toEqual(source);
});

test("clean sync commits target before the worker and excludes target files from flags and falsification", async () => {
  const { repo, cwd } = repository();
  const client = await connect(scratch());
  const first = await submit(client, cwd, { test_paths: ["*.check"], scope: ["alpha.txt"] });
  const original = await done(client, first.job_id);
  writeFileSync(join(cwd, "target.txt"), "target\n");
  writeFileSync(join(cwd, "target.check"), "target test\n");
  commit(repo);
  const target = git(repo, "rev-parse", "HEAD");
  const source = treeState(repo);
  git(repo, "config", "commit.gpgSign", "true");
  writeFileSync(join(repo, ".git/hooks/post-merge"), "#!/bin/sh\ntouch hook-ran\n", { mode: 0o755 });
  const next = await call(client, "codex_rework", { job_id: first.job_id, sync_target: true, findings: ["write:alpha observe:sync"], failed_conditions: [],
    verify_commands: ["test -f alpha.txt && test -f target.txt && test -f target.check"] });
  const status = await done(client, next.job_id);
  expect(status.state).toBe("done");
  expect(status.sync).toEqual({ target_branch: "main", target_commit: target, status: "clean", files: [], unresolved: [] });
  expect(status.isolation.base_commit).toBe(target);
  expect(status.evidence.passed).toBe(true);
  expect(status.evidence.changes).toEqual({ files: [{ path: "sub dir/alpha.txt", status: "added", class: "production" }], tests_modified: [], out_of_scope: [], new_unclassified: [] });
  expect(status.evidence.falsification.ran).toBe(true);
  expect(status.evidence.falsification.unfalsified).toEqual([]);
  const tree = status.isolation.worktree_path;
  const observation = JSON.parse(readFileSync(join(tree, "sub dir/ignored.txt"), "utf8"));
  expect(observation.unmerged).toBe("");
  expect(git(tree, "rev-parse", `${observation.head}^2`)).toBe(target);
  expect(git(tree, "rev-parse", `${observation.head}^1`)).not.toBe(target);
  expect(original.isolation.base_commit).not.toBe(target);
  expect(existsSync(join(tree, "hook-ran"))).toBe(false);
  expect(treeState(repo)).toEqual(source);
  expect((await call(client, "codex_merge", { job_id: next.job_id })).status).toBe("merged");
  expect(existsSync(join(cwd, "alpha.txt"))).toBe(true);
  expect(existsSync(join(cwd, "target.txt"))).toBe(true);
});

test("up_to_date sync keeps the evidence base and makes no commit before the worker", async () => {
  const { repo, cwd, base } = repository();
  const client = await connect(scratch());
  const first = await submit(client, cwd);
  const original = await done(client, first.job_id);
  writeFileSync(join(cwd, "target.txt"), "already merged by worker\n");
  commit(repo);
  const target = git(repo, "rev-parse", "HEAD");
  git(original.isolation.worktree_path, "-c", "user.name=Test", "-c", "user.email=test@example.com", "merge", "--no-ff", "--no-edit", target);
  const tip = git(original.isolation.worktree_path, "rev-parse", "HEAD");
  const next = await call(client, "codex_rework", { job_id: first.job_id, sync_target: true, findings: ["write:alpha observe:sync"], failed_conditions: [] });
  const status = await done(client, next.job_id);
  expect(status.sync).toEqual({ target_branch: "main", target_commit: target, status: "up_to_date", files: [], unresolved: [] });
  expect(target).not.toBe(base);
  expect(status.isolation.base_commit).toBe(original.isolation.base_commit);
  expect(status.evidence.base_commit).toBe(base);
  expect(status.evidence.changes.files.map((f: any) => f.path)).toEqual(["sub dir/alpha.txt", "sub dir/target.txt"]);
  const observation = JSON.parse(readFileSync(join(status.isolation.worktree_path, "sub dir/ignored.txt"), "utf8"));
  expect(observation.head).toBe(tip);
});

test("sync_target rejects non-isolated, unknown-thread and detached-target jobs at submit", async () => {
  const { repo, cwd } = repository();
  const state = scratch();
  const client = await connect(state);
  const plain = await submit(client, cwd, { isolation: undefined });
  await done(client, plain.job_id);
  git(repo, "checkout", "--detach", "-q");
  const detached = await submit(client, cwd);
  const status = await done(client, detached.job_id);
  expect(status.isolation.target_branch).toBeNull();
  const before = outcomes(state).length;
  for (const identity of [{ job_id: plain.job_id }, { thread_id: "unknown-thread" }, { job_id: detached.job_id }]) {
    const rejected = await raw(client, "codex_rework", { ...identity, sync_target: true, findings: ["write:alpha"], failed_conditions: [] });
    expect(rejected.isError).toBe(true);
    expect(rejected.data.error).toContain("sync_target requires");
  }
  expect(outcomes(state)).toHaveLength(before);
});

for (const discard of [false, true]) test(`dependent of ${discard ? "discarded" : "merged and cleaned"} latest rework lineage handles missing branch after restart`, async () => {
  const { repo, cwd } = repository();
  const state = scratch();
  let client = await connect(state);
  const first = await submit(client, cwd);
  await done(client, first.job_id);
  const next = await call(client, "codex_rework", { job_id: first.job_id, findings: ["write:alpha"], failed_conditions: [] });
  const latest = await done(client, next.job_id);
  const merged = await call(client, "codex_merge", { job_id: first.job_id, discard });
  expect(merged).toMatchObject({ status: discard ? "discarded" : "merged", job_id: next.job_id, cleaned_up: true });
  expect(existsSync(latest.isolation.worktree_path)).toBe(false);
  expect((await call(client, "codex_result", { job_id: first.job_id })).merge).toBeUndefined();
  writeFileSync(join(cwd, "later-target.txt"), "later\n");
  commit(repo);
  const target = git(repo, "rev-parse", "HEAD");
  await client.close();
  client = await connect(state);
  const dependent = await submit(client, cwd, { goal: "write:beta", depends_on: first.job_id, verify_commands: ["test -f alpha.txt && test -f beta.txt && test -f later-target.txt"] });
  const status = await done(client, dependent.job_id);
  if (discard) {
    expect(status.state).toBe("error");
    expect(status.error).toContain("discarded");
    expect(status.error).toContain(latest.isolation.branch);
    expect(status.turns).toBe(0);
  } else {
    expect(status.state).toBe("done");
    expect(status.evidence.passed).toBe(true);
    expect(status.isolation.base_commit).toBe(target);
    expect(status.isolation.target_branch).toBe("main");
    expect(JSON.parse(readFileSync(join(status.isolation.worktree_path, "sub dir/alpha.txt"), "utf8")).rounds).toBe(2);
    expect(status.evidence.changes.files.map((f: any) => f.path)).toEqual(["sub dir/beta.txt"]);
  }
});

test("sync resolves the target tip at dequeue, after submission", async () => {
  const { repo, cwd } = repository();
  const client = await connect(scratch(), 1);
  const first = await submit(client, cwd);
  const original = await done(client, first.job_id);
  const blocker = await submit(client, cwd, { goal: "write:beta", verify_commands: ["sleep 0.5; test -f beta.txt"] });
  const next = await call(client, "codex_rework", { job_id: first.job_id, sync_target: true,
    findings: ["write:alpha"], failed_conditions: [], verify_commands: ["test -f alpha.txt && test -f target.txt"] });
  expect(next.state).toBe("queued");
  writeFileSync(join(cwd, "target.txt"), "target moved after rework submission\n");
  commit(repo);
  const target = git(repo, "rev-parse", "HEAD");
  const status = await done(client, next.job_id);
  expect(status.state).toBe("done");
  expect(status.sync).toMatchObject({ status: "clean", target_commit: target });
  expect(status.isolation.base_commit).toBe(target);
  expect(status.evidence.passed).toBe(true);
  expect(status.evidence.changes.files.map((f: any) => f.path)).toEqual(["sub dir/alpha.txt"]);
  expect(original.isolation.base_commit).not.toBe(target);
  await done(client, blocker.job_id);
});

test("non-conflict sync git failure errors before worker launch and preserves both trees", async () => {
  const { repo, cwd } = repository();
  const client = await connect(scratch());
  const first = await submit(client, cwd);
  const original = await done(client, first.job_id);
  writeFileSync(join(cwd, "target.txt"), "target\n");
  commit(repo);
  writeFileSync(join(original.isolation.worktree_path, "sub dir/target.txt"), "untracked overlap\n");
  const source = treeState(repo);
  const worker = treeState(original.isolation.worktree_path);
  const next = await call(client, "codex_rework", { job_id: first.job_id, sync_target: true, findings: ["write:alpha"], failed_conditions: [] });
  const status = await done(client, next.job_id);
  expect(status.state).toBe("error");
  expect(status.turns).toBe(0);
  expect(status.error).toContain("would be overwritten by merge");
  expect(treeState(repo)).toEqual(source);
  expect(treeState(original.isolation.worktree_path)).toEqual(worker);
});

test("pending markers survive ordinary rework and restart until a later rework resolves them", async () => {
  const { repo, cwd, client, first, state, target } = await conflictFixture();
  const initial = await call(client, "codex_rework", { job_id: first.job_id, sync_target: true,
    findings: ["write:alpha leave:conflict"], failed_conditions: [], verify_commands: ["test -f alpha.txt"] });
  const initialStatus = await done(client, initial.job_id);
  expect(initialStatus.evidence.passed).toBe(false);
  expect(initialStatus.sync.unresolved).toEqual(["sub dir/alpha.txt"]);
  await client.close();
  const restarted = await connect(state);
  const source = treeState(repo);
  const ordinary = await call(restarted, "codex_rework", { job_id: first.job_id,
    findings: ["write:alpha leave:conflict observe:sync"], failed_conditions: [] });
  const status = await done(restarted, ordinary.job_id);
  expect(status.state).toBe("done");
  expect(status.sync).toEqual(initialStatus.sync);
  expect(status.isolation.base_commit).toBe(target);
  expect(status.evidence.commands[0].exit_code).toBe(0);
  expect(status.evidence.passed).toBe(false);
  expect(status.evidence.error).toContain("sub dir/alpha.txt");
  expect(outcomes(state).find((o) => o.job_id === ordinary.job_id)).toMatchObject({ sync: status.sync,
    caught_by: expect.arrayContaining(["conflict_unresolved"]) });
  const observation = JSON.parse(readFileSync(join(status.isolation.worktree_path, "sub dir/ignored.txt"), "utf8"));
  expect(observation.prompt).toContain('Merged target "main"');
  expect(observation.prompt).toContain('"sub dir/alpha.txt"');
  expect(observation.unmerged).toBe("");
  const refused = await raw(restarted, "codex_merge", { job_id: first.job_id });
  expect(refused.isError).toBe(true);
  expect(refused.data.status).toBe("refused");
  expect(treeState(repo)).toEqual(source);
  const resolved = await call(restarted, "codex_rework", { job_id: ordinary.job_id,
    findings: ["write:alpha resolve:pending observe:sync"], failed_conditions: [],
    verify_commands: ["grep -q '\"resolved\":true' alpha.txt && test -f target.txt && test -f target.check"] });
  const resolution = await done(restarted, resolved.job_id);
  expect(resolution.state).toBe("done");
  expect(resolution.sync).toMatchObject({ status: "conflict", target_commit: target, files: ["sub dir/alpha.txt"], unresolved: [] });
  expect(resolution.evidence.passed).toBe(true);
  expect(resolution.evidence.base_commit).toBe(target);
  expect(resolution.evidence.changes.files).toEqual([{ path: "sub dir/alpha.txt", status: "modified", class: "production" }]);
  expect(outcomes(state).find((o) => o.job_id === resolved.job_id).caught_by).not.toContain("conflict_unresolved");
  expect(treeState(repo)).toEqual(source);
  expect((await call(restarted, "codex_merge", { job_id: first.job_id })).status).toBe("merged");
  expect(JSON.parse(readFileSync(join(cwd, "alpha.txt"), "utf8")).resolved).toBe(true);
  expect(readFileSync(join(cwd, "target.txt"), "utf8")).toBe("target production\n");
});

for (const failure of ["die", "stall"]) for (const syncTarget of [false, true]) {
  test(`${failure} during conflict recovers with ${syncTarget ? "sync_target" : "ordinary"} rework without replacing the pending merge`, async () => {
    const { repo, cwd, client, first, state, target, original } = await conflictFixture(
      failure === "stall" ? { C2C_IDLE_TIMEOUT_MS: "700" } : {});
    const broken = await call(client, "codex_rework", { job_id: first.job_id, sync_target: true,
      findings: [`write:alpha ${failure}:conflict observe:sync`], failed_conditions: [] });
    const failed = await done(client, broken.job_id);
    expect(failed.state).toBe(failure === "die" ? "error" : "timeout");
    expect(failed.turns).toBe(1);
    expect(failed.sync).toMatchObject({ status: "conflict", target_commit: target, files: ["sub dir/alpha.txt"], unresolved: [] });
    expect(failed.isolation.base_commit).toBe(target);
    const tree = failed.isolation.worktree_path;
    const oldTip = git(tree, "rev-parse", "HEAD");
    expect(git(tree, "rev-parse", "MERGE_HEAD")).toBe(target);
    expect(git(tree, "diff", "--name-only", "--diff-filter=U")).toBe("sub dir/alpha.txt");
    // A second sync must continue MERGE_HEAD, even though the target now has a newer tip.
    writeFileSync(join(cwd, "later-target.txt"), "newer target\n");
    commit(repo);
    expect(git(repo, "rev-parse", "HEAD")).not.toBe(target);
    const source = treeState(repo);
    await client.close();
    const restarted = await connect(state);
    const recovery = await call(restarted, "codex_rework", { job_id: first.job_id,
      ...(syncTarget ? { sync_target: true } : {}), findings: ["write:alpha resolve:conflict observe:sync"], failed_conditions: [],
      verify_commands: ["grep -q '\"resolved\":true' alpha.txt && test -f target.txt && test -f target.check"] });
    const recovered = await done(restarted, recovery.job_id);
    expect(recovered.state).toBe("done");
    expect(recovered.sync).toEqual({ target_branch: "main", target_commit: target, status: "conflict", files: ["sub dir/alpha.txt"], unresolved: [] });
    expect(recovered.evidence.passed).toBe(true);
    expect(recovered.isolation.base_commit).toBe(target);
    expect(recovered.evidence.base_commit).toBe(target);
    expect(recovered.evidence.changes.files).toEqual([{ path: "sub dir/alpha.txt", status: "modified", class: "production" }]);
    expect(git(tree, "rev-parse", "HEAD^1")).toBe(oldTip);
    expect(git(tree, "rev-parse", "HEAD^2")).toBe(target);
    expect(git(tree, "status", "--porcelain")).toBe("");
    expect(existsSync(join(git(tree, "rev-parse", "--absolute-git-dir"), "MERGE_HEAD"))).toBe(false);
    const observation = JSON.parse(readFileSync(join(tree, "sub dir/ignored.txt"), "utf8"));
    expect(observation.unmerged).toBe("sub dir/alpha.txt");
    expect(observation.head).toBe(oldTip);
    expect(observation.prompt).toContain('"sub dir/alpha.txt"');
    expect(outcomes(state).find((o) => o.job_id === recovery.job_id).sync).toEqual(recovered.sync);
    expect(treeState(repo)).toEqual(source);
    expect((await call(restarted, "codex_merge", { job_id: first.job_id })).status).toBe("merged");
    expect(JSON.parse(readFileSync(join(cwd, "alpha.txt"), "utf8"))).toMatchObject({ target: true, resolved: true, threadId: original.thread_id });
    expect(readFileSync(join(cwd, "target.txt"), "utf8")).toBe("target production\n");
    expect(readFileSync(join(cwd, "later-target.txt"), "utf8")).toBe("newer target\n");
  });
}

for (const resolution of ["setext", "marker"]) test(`conflict resolution with ${resolution} uses only exact opening and closing markers`, async () => {
  const { repo, cwd, client, first, state, target } = await conflictFixture();
  const rework = await call(client, "codex_rework", { job_id: first.job_id, sync_target: true,
    findings: [`write:alpha resolution:${resolution}`], failed_conditions: [], verify_commands: ["test -f alpha.txt && test -f target.txt"] });
  const status = await done(client, rework.job_id);
  expect(status.state).toBe("done");
  expect(status.evidence.commands[0].exit_code).toBe(0);
  expect(status.evidence.base_commit).toBe(target);
  expect(status.sync.unresolved).toEqual(resolution === "marker" ? ["sub dir/alpha.txt"] : []);
  expect(status.evidence.passed).toBe(resolution === "setext");
  expect(status.evidence.changes.files.map((f: any) => f.path)).toEqual(["sub dir/alpha.txt"]);
  const merge = await raw(client, "codex_merge", { job_id: first.job_id });
  expect(merge.data.status).toBe(resolution === "setext" ? "merged" : "refused");
  expect(outcomes(state).find((o) => o.job_id === rework.job_id).caught_by.includes("conflict_unresolved")).toBe(resolution === "marker");
  if (resolution === "setext") {
    expect(readFileSync(join(cwd, "alpha.txt"), "utf8")).toContain("Title\n=======\n|||||||\n");
    expect(git(repo, "merge-base", "--is-ancestor", target, "HEAD")).toBe("");
  }
});

test("sync_target combines inherited pending files with newly conflicted files", async () => {
  const { repo, cwd, client, first, target } = await conflictFixture();
  const initial = await call(client, "codex_rework", { job_id: first.job_id, sync_target: true,
    findings: ["write:alpha leave:conflict"], failed_conditions: [] });
  const pending = await done(client, initial.job_id);
  expect(pending.sync.unresolved).toEqual(["sub dir/alpha.txt"]);
  writeFileSync(join(pending.isolation.worktree_path, "sub dir/production.txt"), "job version\n");
  commit(pending.isolation.worktree_path);
  writeFileSync(join(cwd, "production.txt"), "target version\n");
  commit(repo);
  const newTarget = git(repo, "rev-parse", "HEAD");
  expect(newTarget).not.toBe(target);
  const next = await call(client, "codex_rework", { job_id: initial.job_id, sync_target: true,
    findings: ["write:alpha leave:conflict observe:sync"], failed_conditions: [] });
  const status = await done(client, next.job_id);
  expect(status.state).toBe("done");
  expect(status.sync).toEqual({ status: "conflict", target_branch: "main", target_commit: newTarget,
    files: ["sub dir/alpha.txt", "sub dir/production.txt"], unresolved: ["sub dir/alpha.txt", "sub dir/production.txt"] });
  expect(status.evidence.passed).toBe(false);
  expect(status.isolation.base_commit).toBe(newTarget);
  const observation = JSON.parse(readFileSync(join(status.isolation.worktree_path, "sub dir/ignored.txt"), "utf8"));
  expect(observation.unmerged).toBe("sub dir/production.txt");
  expect(observation.prompt).toContain('"sub dir/alpha.txt"');
  expect(observation.prompt).toContain('"sub dir/production.txt"');
  expect((await raw(client, "codex_merge", { job_id: first.job_id })).data.status).toBe("refused");
});

test("ordinary rework concludes a merge started outside sync before taking evidence", async () => {
  const { repo, cwd } = repository();
  const client = await connect(scratch());
  const first = await submit(client, cwd);
  const original = await done(client, first.job_id);
  writeFileSync(join(cwd, "alpha.txt"), JSON.stringify({ target: true, rounds: 0 }));
  commit(repo);
  const target = git(repo, "rev-parse", "HEAD");
  const tree = original.isolation.worktree_path;
  expect(() => git(tree, "-c", "user.name=Test", "-c", "user.email=test@example.com", "merge", "--no-ff", "--no-commit", target)).toThrow();
  expect(git(tree, "rev-parse", "MERGE_HEAD")).toBe(target);
  const mergeHead = join(git(tree, "rev-parse", "--absolute-git-dir"), "MERGE_HEAD");
  const next = await call(client, "codex_rework", { job_id: first.job_id, findings: ["write:alpha resolve:conflict"], failed_conditions: [],
    verify_commands: [`test ! -f '${mergeHead}' && grep -q '\"resolved\":true' alpha.txt`] });
  const status = await done(client, next.job_id);
  expect(status.state).toBe("done");
  expect(status.sync).toBeUndefined();
  expect(status.evidence.passed).toBe(true);
  expect(git(tree, "rev-parse", "HEAD^2")).toBe(target);
  expect(git(tree, "status", "--porcelain")).toBe("");
  expect(existsSync(join(git(tree, "rev-parse", "--absolute-git-dir"), "MERGE_HEAD"))).toBe(false);
  expect((await call(client, "codex_merge", { job_id: first.job_id })).status).toBe("merged");
});
