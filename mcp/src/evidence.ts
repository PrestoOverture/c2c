// Worker-independent verification of a working-tree snapshot.
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { StringDecoder } from "node:string_decoder";

export interface CommandEvidence {
  command: string;
  exit_code: number | null;
  timed_out: boolean;
  duration_ms: number;
  output_tail: string;
}

export interface ChangeEvidence {
  files: { path: string; status: "added" | "modified" | "deleted"; class: "test" | "production" }[];
  tests_modified: string[];
  out_of_scope: string[];
  new_unclassified: string[];
}

export interface FalsificationEvidence {
  ran: boolean;
  skipped_reason?: string;
  setup: CommandEvidence[];
  commands: (CommandEvidence & { still_passes: boolean })[];
  unfalsified: string[];
}

export interface Evidence {
  environment: "worktree" | "in_place";
  base_commit: string | null;
  passed: boolean;
  setup: CommandEvidence[];
  commands: CommandEvidence[];
  changes?: ChangeEvidence;
  falsification: FalsificationEvidence;
  error?: string;
}

interface EvidenceOptions {
  cwd: string;
  /** Isolated jobs retain their original base even if the worker commits. */
  base_commit?: string;
  verify_commands?: string[];
  setup_commands?: string[];
  test_paths?: string[];
  scope?: string[];
  timeoutMs?: number;
  onProgress?: (message: string) => void;
}

// Git arguments are always passed directly, never through a shell. Disabling
// optional locks also prevents read-only snapshot commands refreshing the source index.
async function git(cwd: string, args: string[], input?: Buffer): Promise<string> {
  return (await gitRaw(cwd, args, input)).toString("utf8");
}

// Raw bytes: a patch for a file that is not valid UTF-8 must not be decoded and re-encoded.
function gitRaw(cwd: string, args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, stdio: "pipe",
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (data: Buffer) => stdout.push(data));
    child.stderr.on("data", (data: Buffer) => stderr.push(data));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout));
      else reject(new Error(`git ${args[0]} failed (${code}): ${Buffer.concat(stderr).toString("utf8").trim()}`));
    });
    child.stdin.on("error", () => undefined); // An early git failure can close stdin before the patch is written.
    child.stdin.end(input);
  });
}

function runCommand(command: string, cwd: string, timeoutMs: number): Promise<CommandEvidence> {
  return new Promise((resolve) => {
    const started = Date.now();
    let output = "";
    let timedOut = false;
    const append = (text: string) => { output = (output + text).slice(-4000); };
    const child = spawn("sh", ["-c", command], {
      cwd, env: process.env, detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    for (const stream of [child.stdout, child.stderr]) {
      const decoder = new StringDecoder("utf8");
      stream.on("data", (data: Buffer) => append(decoder.write(data)));
      stream.on("end", () => append(decoder.end()));
    }
    child.on("error", (error) => append(error.message));
    const timer = setTimeout(() => {
      timedOut = true;
      // The shell and all its descendants share this group, including background
      // children that keep stdout/stderr open after the shell itself has exited.
      try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch (error: any) {
        if (error.code !== "ESRCH") append(String(error));
      }
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ command, exit_code: code, timed_out: timedOut, duration_ms: Date.now() - started, output_tail: output });
    });
  });
}

const succeeded = (result: CommandEvidence) => result.exit_code === 0 && !result.timed_out;
const names = (output: string) => output.split("\0").filter(Boolean);
const pathspecs = (paths: string[]) => paths.map((path) => `:(glob)${path}`);

// Ask git from the job cwd so globs are cwd-relative. --full-name keeps all
// reported paths repo-root relative, including deleted and untracked files.
async function matchingFiles(cwd: string, base: string, paths?: string[]): Promise<Set<string>> {
  if (!paths?.length) return new Set();
  const specs = pathspecs(paths);
  return new Set([
    ...names(await git(cwd, ["ls-files", "--full-name", "--cached", "--others", "--exclude-standard", "-z", "--", ...specs])),
    ...names(await git(cwd, ["diff", "--no-relative", "--name-only", "--no-renames", "-z", base, "--", ...specs])),
  ]);
}

async function collectChanges(repo: string, cwd: string, base: string, opts: EvidenceOptions): Promise<ChangeEvidence> {
  const tests = await matchingFiles(cwd, base, opts.test_paths);
  const scope = await matchingFiles(cwd, base, opts.scope);
  const changed = names(await git(repo, ["diff", "--no-relative", "--name-status", "--no-renames", "-z", base, "--"]));
  const files = new Map<string, ChangeEvidence["files"][number]>();
  for (let i = 0; i < changed.length; i += 2) {
    const path = changed[i + 1];
    files.set(path, { path, status: changed[i] === "A" ? "added" : changed[i] === "D" ? "deleted" : "modified", class: tests.has(path) ? "test" : "production" });
  }
  for (const path of names(await git(repo, ["ls-files", "--others", "--exclude-standard", "-z"]))) {
    files.set(path, { path, status: "added", class: tests.has(path) ? "test" : "production" });
  }
  const all = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
  return {
    files: all,
    tests_modified: all.filter((f) => f.class === "test" && f.status !== "added").map((f) => f.path),
    out_of_scope: opts.scope === undefined ? [] : all.filter((f) => !tests.has(f.path) && !scope.has(f.path)).map((f) => f.path),
    new_unclassified: all.filter((f) => f.status === "added" && !tests.has(f.path) && !scope.has(f.path)).map((f) => f.path),
  };
}

// Both snapshots use the same byte-preserving patch/copy path. Filtering the
// patch at the source retains only declared test changes in the second snapshot.
async function populateSnapshot(repo: string, sourceCwd: string, worktree: string, base: string, paths?: string[]) {
  await git(repo, ["worktree", "add", "--detach", worktree, base]);
  const specs = paths ? pathspecs(paths) : [];
  const patch = await gitRaw(paths ? sourceCwd : repo, ["diff", "--no-relative", "--binary", "--no-renames", "--no-ext-diff", "--no-textconv", base, "--", ...specs]);
  if (patch.length) await git(worktree, ["apply", "--binary", "-"], patch);
  const untracked = names(await git(paths ? sourceCwd : repo, ["ls-files", "--full-name", "--others", "--exclude-standard", "-z", "--", ...specs]));
  for (const file of untracked) {
    const target = join(worktree, file);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(repo, file), target, { dereference: false, verbatimSymlinks: true });
  }
}

export async function runChecks(opts: EvidenceOptions, cwd: string, label = "") {
  const setup: CommandEvidence[] = [];
  const commands: CommandEvidence[] = [];
  const timeout = opts.timeoutMs ?? 600_000;
  for (const command of opts.setup_commands ?? []) {
    opts.onProgress?.(`${label}setup: ${command}`);
    const result = await runCommand(command, cwd, timeout);
    setup.push(result);
    if (!succeeded(result)) return { setup, commands, passed: false };
  }
  for (const command of opts.verify_commands ?? []) {
    opts.onProgress?.(`${label}verify: ${command}`);
    commands.push(await runCommand(command, cwd, timeout));
  }
  return { setup, commands, passed: commands.every(succeeded) };
}

/** Run caller-supplied checks, without consulting the worker's output or handoff. */
export async function collectEvidence(input: EvidenceOptions): Promise<Evidence | null> {
  if (!input.verify_commands?.length) return null;
  // A blank pathspec matches every file; it would silently classify the whole tree as tests.
  const patterns = (paths?: string[]) => paths?.filter((path) => path.trim() !== "");
  const opts = { ...input, test_paths: patterns(input.test_paths), scope: patterns(input.scope) };
  let classificationError: string | undefined;
  const evidence: Evidence = {
    environment: "worktree", base_commit: null, passed: false, setup: [], commands: [],
    falsification: { ran: false, setup: [], commands: [], unfalsified: [] },
  };
  let repo: string | undefined;
  let temp: string | undefined;
  const worktrees: string[] = [];
  const fail = (error: unknown) => {
    evidence.passed = false;
    const message = error instanceof Error ? error.message : String(error);
    evidence.error = evidence.error ? `${evidence.error}; ${message}` : message;
  };
  try {
    const sourceCwd = await realpath(opts.cwd);
    try {
      repo = (await git(sourceCwd, ["rev-parse", "--show-toplevel"])).trim();
    } catch (error) {
      if (!String(error).includes("not a git repository")) throw error;
      evidence.environment = "in_place";
    }
    let cwd = sourceCwd;
    if (repo) {
      repo = await realpath(repo);
      evidence.base_commit = opts.base_commit ?? (await git(repo, ["rev-parse", "HEAD"])).trim();
      // A bad declaration (e.g. a pattern outside the repository) must not cost the
      // verification run itself: flags never decide evidence.passed.
      try { evidence.changes = await collectChanges(repo, sourceCwd, evidence.base_commit, opts); } catch (error) {
        classificationError = error instanceof Error ? error.message : String(error);
      }
      temp = await mkdtemp(join(tmpdir(), "c2c-evidence-"));
      const worktree = join(temp, "snapshot");
      worktrees.push(worktree);
      await populateSnapshot(repo, sourceCwd, worktree, evidence.base_commit);
      cwd = join(worktree, relative(repo, sourceCwd));
    }
    Object.assign(evidence, await runChecks(opts, cwd));
    const falsification = evidence.falsification;
    if (!evidence.passed) falsification.skipped_reason = "evidence failed";
    else if (!repo) falsification.skipped_reason = "non-git cwd (not a worktree)";
    else if (classificationError) falsification.skipped_reason = `change classification failed: ${classificationError}`;
    else if (!opts.test_paths?.length) falsification.skipped_reason = "no test_paths";
    else if (!evidence.changes?.files.some((f) => f.class === "production")) {
      falsification.skipped_reason = "no production changes (only test files changed or no changes)";
    } else {
      const reverted = join(temp!, "reverted");
      worktrees.push(reverted);
      try {
        await populateSnapshot(repo, sourceCwd, reverted, evidence.base_commit!, opts.test_paths);
        const checks = await runChecks(opts, join(reverted, relative(repo, sourceCwd)), "falsification: ");
        falsification.setup = checks.setup;
        if (checks.setup.some((result) => !succeeded(result))) {
          falsification.skipped_reason = "setup failed in reverted snapshot";
        } else {
          falsification.ran = true; // ran = the verify commands actually ran against reverted production code
          falsification.commands = checks.commands.map((result) => ({ ...result, still_passes: succeeded(result) }));
          falsification.unfalsified = falsification.commands.filter((result) => result.still_passes).map((result) => result.command);
        }
      } catch (error) {
        falsification.skipped_reason = `falsification snapshot failed: ${String(error)}`;
      }
    }
  } catch (error) {
    fail(error);
  } finally {
    for (const worktree of worktrees.reverse()) {
      try { await git(repo!, ["worktree", "remove", "--force", "--force", worktree]); } catch (error) {
        if (worktree === join(temp!, "reverted")) evidence.falsification.skipped_reason = `falsification cleanup failed: ${String(error)}`;
        else fail(error);
      }
    }
    if (temp) {
      try { await rm(temp, { recursive: true, force: true }); } catch (error) { fail(error); }
    }
    if (repo && worktrees.length) {
      try { await git(repo, ["worktree", "prune"]); } catch (error) { fail(error); }
    }
  }
  if (!evidence.falsification.ran && !evidence.passed) evidence.falsification.skipped_reason = "evidence failed";
  return evidence;
}
