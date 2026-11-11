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

export interface Evidence {
  environment: "worktree" | "in_place";
  base_commit: string | null;
  passed: boolean;
  setup: CommandEvidence[];
  commands: CommandEvidence[];
  error?: string;
}

interface EvidenceOptions {
  cwd: string;
  verify_commands?: string[];
  setup_commands?: string[];
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

/** Run caller-supplied checks, without consulting the worker's output or handoff. */
export async function collectEvidence(opts: EvidenceOptions): Promise<Evidence | null> {
  if (!opts.verify_commands?.length) return null;
  const evidence: Evidence = {
    environment: "worktree", base_commit: null, passed: false, setup: [], commands: [],
  };
  let repo: string | undefined;
  let temp: string | undefined;
  let worktree: string | undefined;
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
      evidence.base_commit = (await git(repo, ["rev-parse", "HEAD"])).trim();
      temp = await mkdtemp(join(tmpdir(), "c2c-evidence-"));
      worktree = join(temp, "snapshot");
      await git(repo, ["worktree", "add", "--detach", worktree, "HEAD"]);
      const patch = await gitRaw(repo, ["diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD", "--"]);
      if (patch.length) await git(worktree, ["apply", "--binary", "-"], patch);
      const untracked = (await git(repo, ["ls-files", "--others", "--exclude-standard", "-z"]))
        .split("\0").filter(Boolean);
      for (const file of untracked) {
        const target = join(worktree, file);
        await mkdir(dirname(target), { recursive: true });
        await cp(join(repo, file), target, { dereference: false, verbatimSymlinks: true });
      }
      cwd = join(worktree, relative(repo, sourceCwd));
    }
    const timeout = opts.timeoutMs ?? 600_000;
    let setupPassed = true;
    for (const command of opts.setup_commands ?? []) {
      opts.onProgress?.(`setup: ${command}`);
      const result = await runCommand(command, cwd, timeout);
      evidence.setup.push(result);
      if (result.exit_code !== 0 || result.timed_out) { setupPassed = false; break; }
    }
    if (setupPassed) {
      for (const command of opts.verify_commands) {
        opts.onProgress?.(`verify: ${command}`);
        evidence.commands.push(await runCommand(command, cwd, timeout));
      }
    }
    evidence.passed = setupPassed && evidence.commands.every((result) => result.exit_code === 0 && !result.timed_out);
  } catch (error) {
    fail(error);
  } finally {
    if (repo && worktree) {
      try { await git(repo, ["worktree", "remove", "--force", "--force", worktree]); } catch (error) { fail(error); }
    }
    if (temp) {
      try { await rm(temp, { recursive: true, force: true }); } catch (error) { fail(error); }
    }
    if (repo && worktree) {
      try { await git(repo, ["worktree", "prune"]); } catch (error) { fail(error); }
    }
  }
  return evidence;
}
