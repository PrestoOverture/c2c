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
async function connect(state: string) {
  const client = new Client({ name: "merge-test", version: "1" });
  await client.connect(new StdioClientTransport({
    command: "bun", args: [join(mcpDir, "src/server.ts")], cwd: mcpDir, stderr: "pipe",
    env: { ...process.env as Record<string, string>, CODEX_BIN: "bun", CODEX_ARGS: join(mcpDir, "test/isolation-worker.ts"),
      C2C_STATE_DIR: state, C2C_LOG_LEVEL: "silent", C2C_RETRIES: "0", C2C_MAX_CONCURRENT: "2",
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
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
