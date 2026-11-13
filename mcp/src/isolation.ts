// Worker-agnostic persistent execution worktrees. Evidence owns its separate,
// temporary snapshots; job worktrees and branches are deliberately retained.
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

export interface Isolation {
  mode: "worktree" | "in_place";
  worktree_path: string | null;
  branch: string | null;
  base_commit: string | null;
  target_branch: string | null;
  source_dirty: boolean;
  note: string | null;
}

const exec = promisify(execFile);
export async function git(cwd: string, args: string[]) {
  const { stdout } = await exec("git", args, {
    cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

export async function prepareIsolation(cwd: string, jobId: string, stateDir: string, dependency?: Isolation, dependencyMerged = false): Promise<{ cwd: string; isolation: Isolation }> {
  const source = await realpath(cwd);
  let repo: string;
  try {
    repo = await realpath(await git(source, ["rev-parse", "--show-toplevel"]));
  } catch (error) {
    if (!String(error).includes("not a git repository")) throw error;
    return { cwd: source, isolation: {
      mode: "in_place", worktree_path: null, branch: null, base_commit: null, target_branch: null,
      source_dirty: false, note: "cwd is not inside a git repository; running in place",
    } };
  }
  const target = dependency?.mode === "worktree" ? dependency.target_branch : (await git(repo, ["branch", "--show-current"])) || null;
  let baseRef = "HEAD";
  if (dependency?.mode === "worktree") {
    baseRef = `refs/heads/${dependency.branch}`;
    try { await git(repo, ["show-ref", "--verify", baseRef]); } catch {
      if (!dependencyMerged || !target) throw new Error(`dependency ${dependency.branch}: work was discarded; branch no longer exists`);
      baseRef = `refs/heads/${target}`;
    }
  }
  const base = await git(repo, ["rev-parse", "--verify", baseRef]);
  const sourceDirty = (await git(repo, ["status", "--porcelain", "--untracked-files=all"])).length > 0;
  const branch = `c2c/${jobId}`;
  const worktree = resolve(stateDir, "worktrees", jobId);
  await mkdir(dirname(worktree), { recursive: true });
  // A git failure is fatal, including branch collisions and checkout-hook errors.
  await git(repo, ["worktree", "add", "-b", branch, worktree, base]);
  return { cwd: join(worktree, relative(repo, source)), isolation: {
    mode: "worktree", worktree_path: worktree, branch, base_commit: base, target_branch: target,
    source_dirty: sourceDirty, note: null,
  } };
}

export function validateIsolation(isolation: Isolation, cwd: string | undefined): void {
  if (isolation.mode !== "worktree") return;
  try {
    if (!isolation.worktree_path || !cwd || !statSync(isolation.worktree_path).isDirectory() || !statSync(cwd).isDirectory()) {
      throw new Error("missing directory");
    }
  } catch {
    throw new Error(`isolated worktree no longer exists: ${isolation.worktree_path}; cannot submit rework`);
  }
}

/** Per-command identity overrides leave the repository configuration untouched. */
export async function commitIdentity(cwd: string): Promise<string[]> {
  const args: string[] = [];
  for (const [key, fallback] of [["user.name", "c2c"], ["user.email", "c2c@localhost"]]) {
    let value = "";
    try { value = await git(cwd, ["config", "--get", key]); } catch { /* unset */ }
    if (!value) args.push("-c", `${key}=${fallback}`);
  }
  return args;
}

export interface TargetSync {
  target_branch: string;
  target_commit: string;
  status: "clean" | "conflict" | "up_to_date";
  files: string[];
  unresolved: string[];
}

const serverCommitOptions = ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false"];

export async function isolatedMergeHead(isolation: Isolation): Promise<string | null> {
  if (isolation.mode !== "worktree") return null;
  try { return await git(isolation.worktree_path!, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]); } catch (error) {
    if ((error as { code?: number }).code !== 1) throw error;
    return null;
  }
}

/** Merge only in the job worktree; the target ref and caller tree stay untouched. */
export async function syncIsolationTarget(isolation: Isolation, jobId: string): Promise<TargetSync> {
  const cwd = isolation.worktree_path!;
  if (await git(cwd, ["symbolic-ref", "HEAD"]) !== `refs/heads/${isolation.branch}`) {
    throw new Error("isolated worker changed its checked-out branch");
  }
  const merging = await isolatedMergeHead(isolation);
  if (merging) {
    return { target_branch: isolation.target_branch!, target_commit: merging, status: "conflict",
      files: (await git(cwd, ["diff", "--name-only", "--diff-filter=U", "-z"])).split("\0").filter(Boolean), unresolved: [] };
  }
  const target = await git(cwd, ["rev-parse", "--verify", `refs/heads/${isolation.target_branch}`]);
  const sync: TargetSync = { target_branch: isolation.target_branch!, target_commit: target, status: "up_to_date", files: [], unresolved: [] };
  try {
    await git(cwd, ["merge-base", "--is-ancestor", target, "HEAD"]);
    return sync;
  } catch (error) {
    if ((error as { code?: number }).code !== 1) throw error;
  }
  try {
    try {
      await git(cwd, [...await commitIdentity(cwd), ...serverCommitOptions, "-c", "merge.autoStash=false",
        "merge", "--no-ff", "--no-commit", "--no-verify", target]);
    } catch (error) {
      sync.files = (await git(cwd, ["diff", "--name-only", "--diff-filter=U", "-z"])).split("\0").filter(Boolean);
      if (!sync.files.length) throw error;
      sync.status = "conflict";
      return sync;
    }
    await commitIsolatedWork(isolation, jobId);
    sync.status = "clean";
    return sync;
  } catch (error) {
    // Git leaves failed merges recoverable; abort only a merge we started.
    try { await git(cwd, [...serverCommitOptions, "merge", "--abort"]); } catch { /* no merge in progress */ }
    throw error;
  }
}

/** Check the original conflicted paths even if the worker already staged them. */
export async function unresolvedSyncFiles(isolation: Isolation, sync: TargetSync): Promise<string[]> {
  const unresolved: string[] = [];
  for (const file of sync.files) {
    let contents: string;
    try { contents = await readFile(join(isolation.worktree_path!, file), "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // resolving by deletion is valid
      throw error;
    }
    if (/^(?:<{7}|>{7})(?: |$)/m.test(contents)) unresolved.push(file);
  }
  return unresolved;
}

/** Capture unstaged/untracked work, including resolutions that leave an empty diff. */
export async function commitIsolatedWork(isolation: Isolation, jobId: string): Promise<void> {
  if (isolation.mode !== "worktree") return;
  const cwd = isolation.worktree_path!;
  if (await git(cwd, ["symbolic-ref", "HEAD"]) !== `refs/heads/${isolation.branch}`) {
    throw new Error("isolated worker changed its checked-out branch");
  }
  await git(cwd, ["add", "--all", "--", "."]);
  const merging = await isolatedMergeHead(isolation);
  if (merging || await git(cwd, ["diff", "--cached", "--name-only"])) {
    await git(cwd, [...await commitIdentity(cwd), ...serverCommitOptions, "commit", "--no-verify", "-m", `c2c: capture job ${jobId}`]);
  }
}
