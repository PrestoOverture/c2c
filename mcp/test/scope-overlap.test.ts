import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "c2c-overlap-")));
  dirs.push(dir);
  return dir;
}
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, {
  cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  stdio: ["ignore", "pipe", "pipe"],
}).trim();
function commit(repo: string) {
  git(repo, "add", ".");
  git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture");
}
function repository() {
  const repo = scratch(), cwd = join(repo, "sub dir");
  mkdirSync(join(cwd, "shared"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, ".gitignore"), "ignored.txt\n");
  for (const file of ["shared/z.txt", "shared/a.txt", "deleted.txt", "rename.txt", "planned.txt", "new staged.txt"]) writeFileSync(join(cwd, file), "before\n");
  writeFileSync(join(repo, "root.txt"), "before\n");
  commit(repo);
  return { repo, cwd };
}
async function connect(state = scratch()) {
  const client = new Client({ name: "scope-overlap-test", version: "1" });
  await client.connect(new StdioClientTransport({
    command: "bun", args: [join(mcpDir, "src/server.ts")], cwd: mcpDir, stderr: "pipe",
    env: { ...process.env as Record<string, string>, CODEX_BIN: "bun", CODEX_ARGS: join(mcpDir, "test/isolation-worker.ts"),
      C2C_STATE_DIR: state, C2C_LOG_LEVEL: "silent", C2C_RETRIES: "0",
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  }));
  clients.push(client);
  return client;
}
async function call(client: Client, name: string, args: Record<string, unknown>) {
  const response: any = await client.callTool({ name, arguments: args });
  expect(response.isError ?? false).toBe(false);
  return JSON.parse(response.content[0].text);
}
const status = (client: Client, id: string) => call(client, "codex_status", { job_id: id });
const result = (client: Client, id: string) => call(client, "codex_result", { job_id: id });
async function done(client: Client, id: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const current = await status(client, id);
    if (["done", "error", "timeout"].includes(current.state)) {
      expect(current.state).toBe("done");
      return current;
    }
    await Bun.sleep(20);
  }
  throw new Error("overlap fixture did not finish");
}
async function submit(client: Client, cwd: string, name: string, extra: Record<string, unknown> = {}) {
  const start = await call(client, "codex_implement", { goal: `write:${name}`, constraints: [], success_conditions: ["fixture passes"],
    cwd, isolation: "worktree", scope: [`${name}.txt`], verify_commands: [`test -f ${name}.txt`], ...extra });
  return done(client, start.job_id);
}
const overlap = (job: any, files = ["sub dir/shared/a.txt", "sub dir/shared/z.txt"]) => [{ job_id: job.job_id, files }];

// Nonempty exact assertions fail when scope_overlap is missing or always [].
test("declared scopes overlap symmetrically in status/result without changing persisted state or indexes", async () => {
  const { cwd } = repository(), state = scratch(), client = await connect(state);
  const a = await submit(client, cwd, "alpha", { scope: ["shared/*.txt", " "] });
  const b = await submit(client, cwd, "beta", { scope: ["shared/*.txt"] });
  const paths = [join(state, `${a.job_id}.json`), join(state, `${b.job_id}.json`), join(state, "outcomes.jsonl"),
    ...[a, b].map((job) => join(git(job.isolation.worktree_path, "rev-parse", "--absolute-git-dir"), "index"))];
  const before = paths.map((path) => readFileSync(path));
  for (const fetch of [status, result]) {
    expect((await fetch(client, a.job_id)).scope_overlap).toEqual(overlap(b));
    expect((await fetch(client, b.job_id)).scope_overlap).toEqual(overlap(a));
  }
  expect(paths.map((path) => readFileSync(path))).toEqual(before);
  const c = await submit(client, cwd, "gamma", { scope: ["shared/*.txt"] });
  expect((await status(client, a.job_id)).scope_overlap).toEqual([overlap(b)[0], overlap(c)[0]].sort((x, y) => x.job_id.localeCompare(y.job_id)));
});

test("disjoint scopes and changes yield an explicit empty list", async () => {
  const { cwd } = repository(), client = await connect();
  const a = await submit(client, cwd, "alpha"), b = await submit(client, cwd, "beta");
  for (const job of [a, b]) for (const fetch of [status, result]) expect((await fetch(client, job.job_id)).scope_overlap).toEqual([]);
});

for (const discard of [false, true]) test(`${discard ? "discarded" : "merged without cleanup"} lineages stop appearing on demand`, async () => {
  const { cwd } = repository(), client = await connect();
  const a = await submit(client, cwd, "alpha", { scope: ["shared/*.txt"] });
  const b = await submit(client, cwd, "beta", { scope: ["shared/*.txt"] });
  expect((await status(client, a.job_id)).scope_overlap).toEqual(overlap(b));
  const merged = await call(client, "codex_merge", { job_id: b.job_id, discard, cleanup: false });
  expect(merged.status).toBe(discard ? "discarded" : "merged");
  for (const fetch of [status, result]) expect((await fetch(client, a.job_id)).scope_overlap).toEqual([]);
  if (!discard) {
    // The latest merge attempt belongs to the lineage even when a newer rework has none.
    const next = await call(client, "codex_rework", { job_id: b.job_id, findings: ["write:beta"], failed_conditions: [] });
    await done(client, next.job_id);
    expect((await status(client, a.job_id)).scope_overlap).toEqual([]);
  }
});

test("out-of-scope changes intersect another scope across commits, index, worktree, deletions and untracked files", async () => {
  const { cwd } = repository(), client = await connect();
  const a = await submit(client, cwd, "alpha");
  const b = await submit(client, cwd, "beta", { scope: ["../root.txt", "planned.txt", "deleted.txt", "rename*.txt", "new*.txt"] });
  expect((await status(client, a.job_id)).scope_overlap).toEqual([]);
  const tree = a.isolation.worktree_path;
  writeFileSync(join(tree, "root.txt"), "committed outside the job cwd\n");
  commit(tree);
  writeFileSync(join(tree, "sub dir/planned.txt"), "unstaged\n");
  unlinkSync(join(tree, "sub dir/deleted.txt"));
  git(tree, "mv", "sub dir/rename.txt", "sub dir/renamed.txt");
  writeFileSync(join(tree, "sub dir/new staged.txt"), "staged\n");
  git(tree, "add", "sub dir/new staged.txt");
  for (const job of [a, b]) writeFileSync(join(job.isolation.worktree_path, "sub dir/new untracked.txt"), "untracked\n");
  const shared = ["root.txt", "sub dir/deleted.txt", "sub dir/new staged.txt", "sub dir/new untracked.txt", "sub dir/planned.txt", "sub dir/rename.txt"];
  for (const fetch of [status, result]) {
    expect((await fetch(client, a.job_id)).scope_overlap).toEqual(overlap(b, shared));
    expect((await fetch(client, b.job_id)).scope_overlap).toEqual(overlap(a, shared));
  }
  // Changed-vs-changed paths outside both scopes also count; ignored files do not.
  for (const job of [a, b]) {
    writeFileSync(join(job.isolation.worktree_path, "outside.txt"), "untracked\n");
    writeFileSync(join(job.isolation.worktree_path, "ignored.txt"), "ignored\n");
  }
  expect((await result(client, a.job_id)).scope_overlap).toEqual(overlap(b, ["outside.txt", ...shared].sort()));
});

test("default and non-git fallback in-place jobs omit overlap fields", async () => {
  const { cwd } = repository(), client = await connect();
  const jobs = [await submit(client, cwd, "alpha", { isolation: undefined }), await submit(client, scratch(), "beta")];
  expect(jobs[1].isolation.mode).toBe("in_place");
  for (const job of jobs) for (const fetch of [status, result]) {
    const summary = await fetch(client, job.job_id);
    expect(summary).not.toHaveProperty("scope_overlap");
    expect(summary).not.toHaveProperty("scope_overlap_error");
  }
});

test("identical paths in another git common directory never appear", async () => {
  const client = await connect();
  const a = await submit(client, repository().cwd, "alpha", { scope: ["shared/*.txt"] });
  await submit(client, repository().cwd, "alpha", { scope: ["shared/*.txt"] });
  for (const fetch of [status, result]) expect((await fetch(client, a.job_id)).scope_overlap).toEqual([]);
});

test("latest job represents each lineage after restart; own lineage is excluded and missing worktrees disappear", async () => {
  const { cwd } = repository(), state = scratch();
  let client = await connect(state);
  const a = await submit(client, cwd, "alpha", { scope: ["shared/*.txt"] });
  const b = await submit(client, cwd, "beta", { scope: ["shared/*.txt"] });
  const next = await call(client, "codex_rework", { job_id: b.job_id, findings: ["write:beta"], failed_conditions: [], scope: ["shared/a.txt"] });
  await done(client, next.job_id);
  await client.close();
  client = await connect(state);
  expect((await status(client, a.job_id)).scope_overlap).toEqual(overlap(next, ["sub dir/shared/a.txt"]));
  expect((await result(client, b.job_id)).scope_overlap).toEqual(overlap(a));
  git(b.isolation.worktree_path, "worktree", "remove", "--force", b.isolation.worktree_path);
  expect((await status(client, a.job_id)).scope_overlap).toEqual([]);
  expect((await result(client, b.job_id)).scope_overlap).toEqual([]);
});

test("a broken worktree reports errors while preserving summaries and healthy overlaps", async () => {
  const { cwd } = repository(), client = await connect();
  const a = await submit(client, cwd, "alpha", { scope: ["shared/*.txt"] });
  const b = await submit(client, cwd, "beta", { scope: ["shared/*.txt"] });
  const c = await submit(client, cwd, "gamma", { scope: ["shared/*.txt"] });
  const marker = join(b.isolation.worktree_path, ".git");
  renameSync(marker, `${marker}.saved`);
  for (const fetch of [status, result]) {
    const summary = await fetch(client, a.job_id);
    expect(summary.scope_overlap).toEqual(overlap(c));
    expect(summary.scope_overlap_error).toContain(b.job_id);
    expect(summary.state).toBe(a.state);
    expect(summary.evidence).toEqual(a.evidence);
    const broken = await fetch(client, b.job_id);
    expect(broken.scope_overlap).toEqual([]);
    expect(broken.scope_overlap_error).toContain(b.job_id);
    expect(broken.evidence).toEqual(b.evidence);
  }
});
