import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ProgressNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { collectEvidence } from "../src/evidence.ts";
import { renderGoalContract, renderObjectiveDetails } from "../src/contracts.ts";

const mcpDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const dirs: string[] = [];
const clients: Client[] = [];
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "c2c-evidence-test-"));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
}

function repository() {
  const dir = scratch();
  const repo = join(dir, "repo");
  const cwd = join(repo, "sub dir");
  mkdirSync(cwd, { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Evidence Test");
  writeFileSync(join(repo, ".gitignore"), "ignored.txt\n");
  writeFileSync(join(cwd, "tracked.txt"), "before\n");
  writeFileSync(join(cwd, "deleted.txt"), "delete me\n");
  writeFileSync(join(cwd, "binary.dat"), Buffer.from([0, 1, 2]));
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "fixture");
  return { dir, repo, cwd };
}

function sourceState(repo: string) {
  return {
    status: git(repo, "status", "--porcelain", "--untracked-files=all"),
    worktrees: git(repo, "worktree", "list", "--porcelain"),
    index: readFileSync(join(repo, ".git", "index")).toString("base64"),
    head: git(repo, "rev-parse", "HEAD"),
    branches: git(repo, "show-ref", "--heads"),
  };
}

async function connect(dir: string, env: Record<string, string> = {}) {
  const client = new Client({ name: "evidence-test", version: "1" });
  await client.connect(new StdioClientTransport({
    command: "bun", args: [join(mcpDir, "src/server.ts")], cwd: mcpDir, stderr: "pipe",
    env: {
      ...process.env as Record<string, string>,
      CODEX_BIN: "bun", CODEX_ARGS: join(mcpDir, "test/mock-codex.ts"),
      C2C_STATE_DIR: join(dir, "state"), C2C_LOG_LEVEL: "silent", CODEX_QUIET_MS: "500",
      ...env,
    },
  }));
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result: any = await client.callTool({ name, arguments: args });
  expect(result.isError ?? false).toBe(false);
  return JSON.parse(result.content[0].text);
}

async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (ready(value)) return value;
    await pause(25);
  }
  throw new Error("timed out waiting for evidence job");
}

const status = (client: Client, id: string) => call(client, "codex_status", { job_id: id });
const done = (client: Client, id: string) => until(() => status(client, id), (s) => ["done", "error", "timeout"].includes(s.state));
const contract = { goal: "Implement the fixture", constraints: [], success_conditions: ["All conditions pass"] };

test("snapshot preserves staged/unstaged tracked edits, binary changes, deletion, untracked names and symlinks, and subdirectory cwd", async () => {
  const { repo, cwd } = repository();
  writeFileSync(join(cwd, "tracked.txt"), "staged\n");
  git(repo, "add", ".");
  writeFileSync(join(cwd, "tracked.txt"), "after\n");
  rmSync(join(cwd, "deleted.txt"));
  writeFileSync(join(cwd, "binary.dat"), Buffer.from([0, 254, 255]));
  writeFileSync(join(cwd, "new\n'file.txt"), "new content\n");
  symlinkSync("tracked.txt", join(cwd, "link"));
  const before = sourceState(repo);
  const evidence = await collectEvidence({ cwd, verify_commands: [
    "test \"$(cat tracked.txt)\" = after && test ! -e deleted.txt && test -L link && test \"$(cat link)\" = after",
    `test "$(cat ${quote("new\n'file.txt")})" = 'new content'`,
    "test \"$(od -An -tx1 binary.dat | tr -d ' \\n')\" = 00feff",
    "printf snapshot-only > tracked.txt; touch verifier-output",
  ] });
  expect(evidence?.passed).toBe(true);
  expect(evidence?.environment).toBe("worktree");
  expect(evidence?.base_commit).toBe(before.head.trim());
  expect(sourceState(repo)).toEqual(before);
  expect(readFileSync(join(cwd, "tracked.txt"), "utf8")).toBe("after\n");
  expect(existsSync(join(cwd, "verifier-output"))).toBe(false);
});

test("snapshot keeps non-UTF-8 tracked edits byte-exact", async () => {
  const { repo, cwd } = repository();
  writeFileSync(join(cwd, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x31, 0x0a]));
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "latin1");
  writeFileSync(join(cwd, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x32, 0x0a]));
  const evidence = await collectEvidence({ cwd, verify_commands: [
    "test \"$(od -An -tx1 latin1.txt | tr -d ' \\n')\" = 636166e920320a",
  ] });
  expect(evidence?.error).toBeUndefined();
  expect(evidence?.passed).toBe(true);
});

test("ignored files are absent; every verify command runs after a failure; combined output is capped at its last 4000 chars", async () => {
  const { repo, cwd } = repository();
  writeFileSync(join(cwd, "ignored.txt"), "local only");
  const before = sourceState(repo);
  const evidence = await collectEvidence({ cwd, verify_commands: [
    "test -f ignored.txt", "printf stdout; printf stderr >&2; exit 7",
    "i=0; while [ $i -lt 4100 ]; do printf x; i=$((i+1)); done; printf end >&2",
  ] });
  expect(evidence?.passed).toBe(false);
  expect(evidence?.commands.map((c) => c.exit_code)).toEqual([1, 7, 0]);
  expect(evidence?.commands[1].output_tail).toContain("stdout");
  expect(evidence?.commands[1].output_tail).toContain("stderr");
  expect(evidence?.commands[2].output_tail).toBe("x".repeat(3997) + "end");
  expect(sourceState(repo)).toEqual(before);
});

test("setup stops on the first failure; setup and verification share the snapshot", async () => {
  const { repo, cwd } = repository();
  const before = sourceState(repo);
  const failed = await collectEvidence({ cwd, setup_commands: ["echo setup-failed; exit 3", "touch should-not-run"], verify_commands: ["touch verify-should-not-run"] });
  expect(failed?.passed).toBe(false);
  expect(failed?.setup).toHaveLength(1);
  expect(failed?.setup[0].exit_code).toBe(3);
  expect(failed?.commands).toEqual([]);
  const passed = await collectEvidence({ cwd, setup_commands: ["mkdir dependencies; echo ready > dependencies/marker"], verify_commands: ["grep -q ready dependencies/marker"] });
  expect(passed?.passed).toBe(true);
  expect(passed?.setup[0].exit_code).toBe(0);
  expect(sourceState(repo)).toEqual(before);
  expect(existsSync(join(cwd, "dependencies"))).toBe(false);
});

test("timeout kills the whole shell process group and cleans the worktree without changing the source", async () => {
  const { repo, cwd, dir } = repository();
  const before = sourceState(repo);
  const marker = join(dir, "escaped-child");
  const evidence = await collectEvidence({ cwd, timeoutMs: 100, verify_commands: [
    `(sleep 0.5; touch ${quote(marker)}) & echo waiting; wait`, "echo still-runs",
  ] });
  expect(evidence?.passed).toBe(false);
  expect(evidence?.commands[0].timed_out).toBe(true);
  expect(evidence?.commands[0].exit_code).not.toBe(0);
  expect(evidence?.commands[0].output_tail).toContain("waiting");
  expect(evidence?.commands[0].duration_ms).toBeLessThan(1500);
  expect(evidence?.commands[1].exit_code).toBe(0);
  expect(sourceState(repo)).toEqual(before);
  await pause(600);
  expect(existsSync(marker)).toBe(false);
});

test("non-git runs in place with the server environment; no verify commands skips even setup and invalid cwd", async () => {
  const cwd = scratch();
  const evidence = await collectEvidence({ cwd, setup_commands: ["echo ready > setup.txt"], verify_commands: ["test -n \"$PATH\" && grep -q ready setup.txt"] });
  expect(evidence?.environment).toBe("in_place");
  expect(evidence?.base_commit).toBeNull();
  expect(evidence?.passed).toBe(true);
  expect(await collectEvidence({ cwd: join(cwd, "missing"), setup_commands: ["exit 1"] })).toBeNull();
  expect(await collectEvidence({ cwd, setup_commands: ["touch should-not-run"], verify_commands: [] })).toBeNull();
  expect(existsSync(join(cwd, "should-not-run"))).toBe(false);
});

test("snapshot failures produce failed evidence with an error and no commands", async () => {
  const { repo, cwd } = repository();
  // worktree add checks out successfully, then reports the failing hook. Even
  // partial creation must leave no worktree registration or source changes.
  writeFileSync(join(repo, ".git/hooks/post-checkout"), "#!/bin/sh\nexit 5\n", { mode: 0o755 });
  const before = sourceState(repo);
  const evidence = await collectEvidence({ cwd, verify_commands: ["echo must-not-run"] });
  expect(evidence?.passed).toBe(false);
  expect(evidence?.error).toBeString();
  expect(evidence?.commands).toEqual([]);
  expect(sourceState(repo)).toEqual(before);
});

test("server evidence rejects a handoff claiming every condition passed, survives restart, and is inherited by rework", async () => {
  const { dir, repo, cwd } = repository();
  const promptFile = join(dir, "prompt.txt");
  const goalFile = join(dir, "goal.json");
  const traceFile = join(dir, "verification-runs.txt");
  let client = await connect(dir, {
    MOCK_HANDOFF: "### Changed Files\n- fixture\n### Validation\n- all checks passed\n### Success Conditions\n- [x] Every condition passed\n### Risks & Deviations\n- none",
    MOCK_PROMPT_FILE: promptFile, MOCK_GOAL_FILE: goalFile,
  });
  const before = sourceState(repo);
  const input = {
    ...contract, cwd,
    verify_commands: [`echo verify >> ${quote(traceFile)}; echo server-failure >&2; exit 9`],
    setup_commands: [`echo setup >> ${quote(traceFile)}; echo installed > installed.txt`],
  };
  const estimate = await call(client, "codex_estimate", input);
  const started = await call(client, "codex_implement", input);
  const finished = await done(client, started.job_id);
  expect(finished.state).toBe("done");
  expect(finished.evidence.environment).toBe("worktree");
  expect(finished.evidence.passed).toBe(false);
  expect(finished.evidence.commands[0]).toMatchObject({ exit_code: 9, timed_out: false, output_tail: "server-failure\n" });
  const result = await call(client, "codex_result", { job_id: started.job_id });
  expect(result.handoff.valid).toBe(true);
  expect(result.final_message).toContain("[x] Every condition passed");
  expect(result.evidence).toEqual(finished.evidence);
  expect(readFileSync(traceFile, "utf8")).toBe("setup\nverify\n");
  expect(estimate.prompt_chars).toBe(readFileSync(promptFile, "utf8").length);
  expect(sourceState(repo)).toEqual(before);
  await client.close();
  clients.splice(clients.indexOf(client), 1);
  client = await connect(dir, { MOCK_GOAL_FILE: goalFile, MOCK_PROMPT_FILE: promptFile });
  expect((await call(client, "codex_result", { job_id: started.job_id })).evidence).toEqual(finished.evidence);
  expect((await status(client, started.job_id)).evidence).toEqual(finished.evidence);
  const rework = await call(client, "codex_rework", { job_id: started.job_id, cwd, findings: ["Fix verification"], failed_conditions: ["Checks failed"] });
  const reworked = await done(client, rework.job_id);
  expect(reworked.state).toBe("done");
  expect(reworked.evidence.passed).toBe(false);
  expect(reworked.evidence.setup[0].command).toBe(input.setup_commands[0]);
  expect(reworked.evidence.commands[0].command).toBe(input.verify_commands[0]);
  expect(readFileSync(traceFile, "utf8")).toBe("setup\nverify\nsetup\nverify\n");
  expect(readFileSync(promptFile, "utf8")).toContain(input.verify_commands[0]);
  expect(sourceState(repo)).toEqual(before);
  const persisted = JSON.parse(readFileSync(join(dir, "state", `${rework.job_id}.json`), "utf8"));
  expect(persisted.verify_commands).toEqual(input.verify_commands);
  expect(persisted.setup_commands).toEqual(input.setup_commands);
  expect(persisted.evidence).toEqual(reworked.evidence);
  const override = await call(client, "codex_rework", {
    job_id: rework.job_id, cwd, findings: ["Replace checks"], failed_conditions: [], verify_commands: ["test ! -e installed.txt"], setup_commands: [],
  });
  expect((await done(client, override.job_id)).evidence.passed).toBe(true);
});

test("snapshot includes tracked edits and new untracked files created by the worker, after its process is gone", async () => {
  const { dir, repo, cwd } = repository();
  const pidFile = join(dir, "pid.txt");
  const client = await connect(dir, {
    MOCK_WRITE_FILES: JSON.stringify({ "tracked.txt": "worker edit\n", "new.txt": "worker new\n" }),
    MOCK_PID_FILE: pidFile, MOCK_EXIT_DELAY_MS: "200",
  });
  const started = await call(client, "codex_implement", {
    ...contract, cwd, verify_commands: [
      `! kill -0 "$(cat ${quote(pidFile)})" 2>/dev/null`,
      "grep -q 'worker edit' tracked.txt && grep -q 'worker new' new.txt",
    ],
  });
  const finished = await done(client, started.job_id);
  expect(finished.state).toBe("done");
  expect(finished.evidence).toMatchObject({ passed: true, environment: "worktree" });
  expect(git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
  expect(readFileSync(join(cwd, "tracked.txt"), "utf8")).toBe("worker edit\n");
  expect(readFileSync(join(cwd, "new.txt"), "utf8")).toBe("worker new\n");
});

test("verification holds the slot and running state, emits progress, ignores worker timers, then times out as done", async () => {
  const { dir, repo, cwd } = repository();
  const marker = join(dir, "verifying");
  const client = await connect(dir, {
    C2C_VERIFY_TIMEOUT_MS: "800", CODEX_JOB_TIMEOUT_MS: "650", C2C_IDLE_TIMEOUT_MS: "350", C2C_STALL_WARN_MS: "350", C2C_MAX_CONCURRENT: "1",
  });
  const progress: any[] = [];
  client.setNotificationHandler(ProgressNotificationSchema, (n) => { progress.push(JSON.parse(n.params.message!)); });
  const before = sourceState(repo);
  const first = await call(client, "codex_implement", { ...contract, cwd, verify_commands: [`touch ${quote(marker)}; echo timeout-output; sleep 5`] });
  const verifying = await until(() => status(client, first.job_id), (s) => s.transcript_tail.some((e: any) => e.kind === "verify") && existsSync(marker));
  expect(verifying.state).toBe("running");
  expect(verifying.evidence).toBeNull();
  const early: any = await client.callTool({ name: "codex_result", arguments: { job_id: first.job_id } });
  expect(early.isError).toBe(true);
  const second = await call(client, "codex_implement", { ...contract, cwd });
  expect(second.state).toBe("queued");
  const finished = await done(client, first.job_id);
  expect(finished.state).toBe("done");
  expect(finished.error).toBeNull();
  expect(finished.evidence.passed).toBe(false);
  expect(finished.evidence.commands[0]).toMatchObject({ timed_out: true, output_tail: "timeout-output\n" });
  expect(progress.some((p) => p.jobId === first.job_id && p.event === "verify")).toBe(true);
  expect(progress.some((p) => p.jobId === first.job_id && p.event === "stalled")).toBe(false);
  expect((await done(client, second.job_id)).state).toBe("done");
  expect(sourceState(repo)).toEqual(before);
});

test("server skips all verification work without verify_commands; setup failure and non-git evidence still finish done", async () => {
  const { dir, repo, cwd } = repository();
  const wrapperDir = join(dir, "bin");
  mkdirSync(wrapperDir);
  const gitPath = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const gitMarker = join(dir, "git-invoked");
  writeFileSync(join(wrapperDir, "git"), `#!/bin/sh\ntouch ${quote(gitMarker)}\nexec ${quote(gitPath)} "$@"\n`, { mode: 0o755 });
  const client = await connect(dir, { PATH: `${wrapperDir}:${process.env.PATH}` });
  const before = sourceState(repo);
  const skipped = await call(client, "codex_implement", { ...contract, cwd, setup_commands: ["touch should-not-run"] });
  expect((await done(client, skipped.job_id)).evidence).toBeNull();
  expect(existsSync(gitMarker)).toBe(false);
  expect(existsSync(join(cwd, "should-not-run"))).toBe(false);
  expect(sourceState(repo)).toEqual(before);
  const failed = await call(client, "codex_implement", { ...contract, cwd, setup_commands: ["echo setup-error; exit 4", "touch should-not-run"], verify_commands: ["echo verify-should-not-run"] });
  const finished = await done(client, failed.job_id);
  expect(finished.state).toBe("done");
  expect(finished.evidence.passed).toBe(false);
  expect(finished.evidence.setup).toHaveLength(1);
  expect(finished.evidence.setup[0].exit_code).toBe(4);
  expect(finished.evidence.commands).toEqual([]);
  expect(sourceState(repo)).toEqual(before);
  const nonGit = scratch();
  const inPlace = await call(client, "codex_implement", { ...contract, cwd: nonGit, verify_commands: ["echo in-place"] });
  expect((await done(client, inPlace.job_id)).evidence).toMatchObject({ passed: true, environment: "in_place", base_commit: null });
});

test("worker errors never run evidence; verification appears only in the turn prompt, not the goal objective", async () => {
  const dir = scratch();
  const client = await connect(dir, { FAIL_TURN_MESSAGE: "worker failed" });
  const started = await call(client, "codex_implement", { ...contract, cwd: dir, verify_commands: ["touch should-not-run"] });
  const finished = await done(client, started.job_id);
  expect(finished.state).toBe("error");
  expect(finished.evidence).toBeNull();
  expect(existsSync(join(dir, "should-not-run"))).toBe(false);
  const full = { ...contract, setup_commands: ["unique-setup"], verify_commands: ["unique-verification"] };
  expect(renderGoalContract(full)).toContain("unique-verification");
  expect(renderGoalContract(full)).toContain("unique-setup");
  expect(renderObjectiveDetails(full, 2000)).toEqual(renderObjectiveDetails(contract, 2000));
});

test("falsification removes the production fix so a new test exercising it fails, without changing source state", async () => {
  const { repo, cwd } = repository();
  writeFileSync(join(cwd, "tracked.txt"), "value=broken\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "buggy production");
  writeFileSync(join(cwd, "tracked.txt"), "value=fixed\n");
  git(repo, "add", ".");
  writeFileSync(join(cwd, "regression.check"), '. ./tracked.txt\ntest "$value" = fixed\n');
  const before = sourceState(repo);
  const evidence = await collectEvidence({
    cwd, test_paths: ["*.check"], scope: ["tracked.txt"], verify_commands: ["sh regression.check"],
  });
  expect(evidence?.passed).toBe(true);
  expect(evidence?.falsification).toMatchObject({ ran: true, setup: [], unfalsified: [] });
  expect(evidence?.falsification.skipped_reason).toBeUndefined();
  expect(evidence?.falsification.commands).toHaveLength(1);
  expect(evidence?.falsification.commands[0]).toMatchObject({ command: "sh regression.check", still_passes: false, exit_code: 1, timed_out: false });
  expect(sourceState(repo)).toEqual(before);
  expect(git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
});

test("reverted snapshot keeps new, edited and deleted declared tests, restores production, and classifies every change", async () => {
  const { repo, cwd } = repository();
  mkdirSync(join(cwd, "checks"));
  writeFileSync(join(cwd, "checks/edit"), "old test\n");
  writeFileSync(join(cwd, "checks/delete"), "old test\n");
  writeFileSync(join(cwd, "checks/staged-delete"), "old test\n");
  writeFileSync(join(repo, "outside.txt"), "old outside\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "test fixtures");
  writeFileSync(join(cwd, "checks/edit"), "changed test\n");
  git(repo, "add", ".");
  // Keep raw non-UTF-8 test edits and unusual names, too.
  writeFileSync(join(cwd, "checks/edit"), Buffer.from([0xe9, 0x0a]));
  rmSync(join(cwd, "checks/delete"));
  git(repo, "rm", "-q", "sub dir/checks/staged-delete");
  writeFileSync(join(cwd, "checks/new\n'check"), "new test\n");
  writeFileSync(join(cwd, "checks/staged-new"), "staged test\n");
  git(repo, "add", "sub dir/checks/staged-new");
  writeFileSync(join(cwd, "tracked.txt"), "after\n");
  rmSync(join(cwd, "deleted.txt"));
  writeFileSync(join(cwd, "new-production"), "new production\n");
  writeFileSync(join(repo, "outside.txt"), "changed outside\n");
  writeFileSync(join(repo, "unclassified"), "unclassified\n");
  writeFileSync(join(cwd, "ignored.txt"), "ignored\n");
  const before = sourceState(repo);
  const command = [
    "test \"$(od -An -tx1 checks/edit | tr -d ' \\n')\" = e90a",
    "test ! -e checks/delete", "test ! -e checks/staged-delete",
    `test "$(cat ${quote("checks/new\n'check")})" = 'new test'`,
    "test \"$(cat checks/staged-new)\" = 'staged test'",
    "test ! -e ignored.txt",
    "if test \"$(cat tracked.txt)\" = after; then test ! -e deleted.txt && test -e new-production && test -e ../unclassified && grep -q changed ../outside.txt && echo full-ok; else test \"$(cat tracked.txt)\" = before && test -f deleted.txt && test ! -e new-production && test ! -e ../unclassified && grep -q old ../outside.txt && echo reverted-ok; fi",
  ].join(" && ");
  const evidence = await collectEvidence({
    cwd, test_paths: ["checks/**"], scope: ["tracked.txt", "deleted.txt", "new-production"], verify_commands: [command],
  });
  expect(evidence?.passed).toBe(true);
  expect(evidence?.commands[0].output_tail).toBe("full-ok\n");
  expect(evidence?.falsification.commands[0]).toMatchObject({ still_passes: true, output_tail: "reverted-ok\n" });
  expect(evidence?.falsification.unfalsified).toEqual([command]);
  const changes = evidence!.changes!;
  const file = (path: string, status: string, kind: string) => ({ path, status, class: kind });
  expect(changes.files).toHaveLength(10);
  expect(changes.files).toEqual(expect.arrayContaining([
    file("sub dir/checks/edit", "modified", "test"),
    file("sub dir/checks/delete", "deleted", "test"),
    file("sub dir/checks/staged-delete", "deleted", "test"),
    file("sub dir/checks/new\n'check", "added", "test"),
    file("sub dir/checks/staged-new", "added", "test"),
    file("sub dir/tracked.txt", "modified", "production"),
    file("sub dir/deleted.txt", "deleted", "production"),
    file("sub dir/new-production", "added", "production"),
    file("outside.txt", "modified", "production"),
    file("unclassified", "added", "production"),
  ]));
  expect(changes.tests_modified.sort()).toEqual(["sub dir/checks/delete", "sub dir/checks/edit", "sub dir/checks/staged-delete"]);
  expect(changes.out_of_scope.sort()).toEqual(["outside.txt", "unclassified"]);
  expect(changes.new_unclassified).toEqual(["unclassified"]);
  expect(sourceState(repo)).toEqual(before);
});

test("git globs match deleted tests relative to cwd, including parent paths; no naming heuristics or implicit scope", async () => {
  const { repo, cwd } = repository();
  rmSync(join(cwd, "deleted.txt"));
  git(repo, "add", ".");
  writeFileSync(join(cwd, "new.test.ts"), "new\n");
  writeFileSync(join(cwd, "binary.dat"), Buffer.from([0, 9]));
  const declared = await collectEvidence({ cwd, test_paths: ["../sub dir/deleted.*"], scope: [], verify_commands: ["true"] });
  expect(declared?.changes).toMatchObject({
    tests_modified: ["sub dir/deleted.txt"],
    new_unclassified: ["sub dir/new.test.ts"],
  });
  expect(declared?.changes?.files).toContainEqual({ path: "sub dir/deleted.txt", status: "deleted", class: "test" });
  expect(declared?.changes?.out_of_scope.sort()).toEqual(["sub dir/binary.dat", "sub dir/new.test.ts"]);
  const undeclared = await collectEvidence({ cwd, verify_commands: ["true"] });
  expect(undeclared?.changes?.files.every((f) => f.class === "production")).toBe(true);
  expect(undeclared?.changes?.tests_modified).toEqual([]);
  expect(undeclared?.changes?.out_of_scope).toEqual([]);
  expect(undeclared?.changes?.new_unclassified).toEqual(["sub dir/new.test.ts"]);
});

test("falsification explains evidence failure, absent test_paths, non-git cwd and test-only changes", async () => {
  const { repo, cwd } = repository();
  writeFileSync(join(cwd, "tracked.txt"), "after\n");
  const before = sourceState(repo);
  const failed = await collectEvidence({ cwd, test_paths: ["checks/**"], verify_commands: ["false"] });
  expect(failed?.falsification).toEqual({ ran: false, skipped_reason: "evidence failed", setup: [], commands: [], unfalsified: [] });
  for (const test_paths of [undefined, []]) {
    const absent = await collectEvidence({ cwd, test_paths, verify_commands: ["true"] });
    expect(absent?.falsification).toMatchObject({ ran: false, skipped_reason: "no test_paths", commands: [], unfalsified: [] });
  }
  const inPlace = await collectEvidence({ cwd: scratch(), test_paths: ["checks/**"], verify_commands: ["true"] });
  expect(inPlace?.falsification).toMatchObject({ ran: false, skipped_reason: "non-git cwd (not a worktree)" });
  const testsOnly = await collectEvidence({ cwd, test_paths: ["tracked.txt"], verify_commands: ["true"] });
  expect(testsOnly?.falsification).toMatchObject({ ran: false, skipped_reason: "no production changes (only test files changed or no changes)" });
  expect(sourceState(repo)).toEqual(before);
});

test("setup failing only in the reverted snapshot stops falsification without failing evidence, and cleans both worktrees", async () => {
  const { repo, cwd } = repository();
  writeFileSync(join(cwd, "tracked.txt"), "fixed\n");
  writeFileSync(join(cwd, "new.check"), "test\n");
  const before = sourceState(repo);
  const evidence = await collectEvidence({
    cwd, test_paths: ["*.check"],
    setup_commands: ["grep -q fixed tracked.txt", "touch dependency"],
    verify_commands: ["test -f dependency"],
  });
  expect(evidence?.passed).toBe(true);
  expect(evidence?.setup).toHaveLength(2);
  expect(evidence?.falsification).toMatchObject({ ran: false, skipped_reason: "setup failed in reverted snapshot", commands: [], unfalsified: [] });
  expect(evidence?.falsification.setup).toHaveLength(1);
  expect(evidence?.falsification.setup[0].exit_code).toBe(1);
  expect(sourceState(repo)).toEqual(before);
});

test("falsification shares the per-command timeout and still runs later commands after a failure", async () => {
  const { repo, cwd } = repository();
  writeFileSync(join(cwd, "tracked.txt"), "fixed\n");
  const before = sourceState(repo);
  const evidence = await collectEvidence({
    cwd, test_paths: ["*.check"], timeoutMs: 100,
    verify_commands: ["if grep -q fixed tracked.txt; then exit 0; else echo reverted; sleep 5; fi", "true"],
  });
  expect(evidence?.passed).toBe(true);
  expect(evidence?.falsification.commands[0]).toMatchObject({ still_passes: false, timed_out: true, output_tail: "reverted\n" });
  expect(evidence?.falsification.commands[1]).toMatchObject({ still_passes: true, exit_code: 0 });
  expect(evidence?.falsification.unfalsified).toEqual(["true"]);
  expect(sourceState(repo)).toEqual(before);
});

test("a reverted-snapshot creation failure is advisory and even partially created worktrees are cleaned", async () => {
  const { dir, repo, cwd } = repository();
  const marker = join(dir, "checkout-marker");
  writeFileSync(join(repo, ".git/hooks/post-checkout"), `#!/bin/sh\nif test -e ${quote(marker)}; then exit 5; fi\ntouch ${quote(marker)}\n`, { mode: 0o755 });
  writeFileSync(join(cwd, "tracked.txt"), "after\n");
  const before = sourceState(repo);
  const evidence = await collectEvidence({ cwd, test_paths: ["*.check"], verify_commands: ["true"] });
  expect(evidence?.passed).toBe(true);
  expect(evidence?.error).toBeUndefined();
  expect(evidence?.falsification.ran).toBe(false);
  expect(evidence?.falsification.skipped_reason).toContain("falsification snapshot failed");
  expect(evidence?.falsification.commands).toEqual([]);
  expect(evidence?.falsification.unfalsified).toEqual([]);
  expect(sourceState(repo)).toEqual(before);
});

test("server persists advisory flags and declarations across restart, rework inherits them, and [] clears or overrides", async () => {
  const { dir, repo, cwd } = repository();
  const promptFile = join(dir, "prompt.txt");
  writeFileSync(join(cwd, "tracked.txt"), "after\n");
  writeFileSync(join(cwd, "new.check"), "declared test\n");
  writeFileSync(join(cwd, "unclassified"), "undeclared\n");
  const before = sourceState(repo);
  let client = await connect(dir, { MOCK_PROMPT_FILE: promptFile });
  const input = { ...contract, cwd, verify_commands: ["true"], setup_commands: ["echo setup"], test_paths: ["*.check"], scope: ["tracked.txt"] };
  const estimate = await call(client, "codex_estimate", input);
  const started = await call(client, "codex_implement", input);
  const finished = await done(client, started.job_id);
  expect(finished.state).toBe("done");
  expect(finished.evidence.passed).toBe(true);
  expect(finished.evidence.falsification).toMatchObject({ ran: true, unfalsified: ["true"] });
  expect(finished.evidence.falsification.setup[0].output_tail).toBe("setup\n");
  expect(finished.evidence.changes.new_unclassified).toEqual(["sub dir/unclassified"]);
  expect(finished.evidence.changes.out_of_scope).toEqual(["sub dir/unclassified"]);
  expect(estimate.prompt_chars).toBe(readFileSync(promptFile, "utf8").length);
  const prompt = readFileSync(promptFile, "utf8");
  expect(prompt).toContain('test_paths');
  expect(prompt).toContain('"*.check"');
  expect(prompt).toContain('"tracked.txt"');
  expect(prompt).toContain("new tests belong under test_paths");
  expect(renderObjectiveDetails(input, 2000)).toEqual(renderObjectiveDetails(contract, 2000));
  const persisted = JSON.parse(readFileSync(join(dir, "state", `${started.job_id}.json`), "utf8"));
  expect(persisted.test_paths).toEqual(input.test_paths);
  expect(persisted.scope).toEqual(input.scope);
  expect(persisted.evidence).toEqual(finished.evidence);
  await client.close();
  clients.splice(clients.indexOf(client), 1);
  client = await connect(dir, { MOCK_PROMPT_FILE: promptFile });
  expect((await status(client, started.job_id)).evidence).toEqual(finished.evidence);
  expect((await call(client, "codex_result", { job_id: started.job_id })).evidence).toEqual(finished.evidence);
  const delta = { job_id: started.job_id, cwd, findings: ["Review flags"], failed_conditions: [] };
  const rework = await call(client, "codex_rework", delta);
  const reworked = await done(client, rework.job_id);
  expect(reworked.state).toBe("done");
  expect(reworked.evidence.falsification.unfalsified).toEqual(["true"]);
  expect(reworked.evidence.changes).toEqual(finished.evidence.changes);
  const inherited = JSON.parse(readFileSync(join(dir, "state", `${rework.job_id}.json`), "utf8"));
  expect(inherited.test_paths).toEqual(input.test_paths);
  expect(inherited.scope).toEqual(input.scope);
  expect(readFileSync(promptFile, "utf8")).toContain('"*.check"');
  const cleared = await call(client, "codex_rework", { ...delta, test_paths: [], scope: [], setup_commands: [] });
  const clearedResult = await done(client, cleared.job_id);
  expect(clearedResult.evidence.falsification).toMatchObject({ ran: false, skipped_reason: "no test_paths" });
  expect(clearedResult.evidence.changes.files.every((f: any) => f.class === "production")).toBe(true);
  expect(clearedResult.evidence.changes.out_of_scope).toHaveLength(3);
  expect(clearedResult.evidence.changes.new_unclassified.sort()).toEqual(["sub dir/new.check", "sub dir/unclassified"]);
  const clearedJob = JSON.parse(readFileSync(join(dir, "state", `${cleared.job_id}.json`), "utf8"));
  expect(clearedJob.test_paths).toEqual([]);
  expect(clearedJob.scope).toEqual([]);
  const overridden = await call(client, "codex_rework", { ...delta, test_paths: ["tracked.txt"], scope: ["*"] });
  const overrideResult = await done(client, overridden.job_id);
  expect(overrideResult.evidence.changes.tests_modified).toEqual(["sub dir/tracked.txt"]);
  expect(overrideResult.evidence.changes.out_of_scope).toEqual([]);
  expect(overrideResult.evidence.changes.new_unclassified).toEqual([]);
  expect(sourceState(repo)).toEqual(before);
});


test("declaring paths without verify_commands still gives null evidence and does not run setup", async () => {
  const dir = scratch();
  const client = await connect(dir);
  const input = { ...contract, cwd: dir, test_paths: ["checks/**"], scope: ["src/**"], setup_commands: ["touch must-not-run"] };
  const started = await call(client, "codex_implement", input);
  expect((await done(client, started.job_id)).evidence).toBeNull();
  expect(existsSync(join(dir, "must-not-run"))).toBe(false);
  const prompt = renderGoalContract(input);
  expect(prompt).toContain("server evidence is null");
  expect(prompt).toContain('"checks/**"');
  expect(prompt).toContain('"src/**"');
});

test("a test_paths pattern outside the repository does not cost the verification run; blank patterns are ignored", async () => {
  const { cwd } = repository();
  writeFileSync(join(cwd, "tracked.txt"), "after\n");
  const outside = await collectEvidence({ cwd, verify_commands: ["test \"$(cat tracked.txt)\" = after"], test_paths: ["/etc/**"] });
  expect(outside?.passed).toBe(true);
  expect(outside?.error).toBeUndefined();
  expect(outside?.commands).toHaveLength(1);
  expect(outside?.changes).toBeUndefined();
  expect(outside?.falsification.ran).toBe(false);
  expect(outside?.falsification.skipped_reason).toContain("change classification failed");

  const blank = await collectEvidence({ cwd, verify_commands: ["true"], test_paths: [""], scope: [" "] });
  expect(blank?.changes?.files).toEqual([{ path: "sub dir/tracked.txt", status: "modified", class: "production" }]);
  expect(blank?.changes?.out_of_scope).toEqual(["sub dir/tracked.txt"]);
  expect(blank?.falsification).toMatchObject({ ran: false, skipped_reason: "no test_paths" });
});
