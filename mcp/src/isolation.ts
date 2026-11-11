// Worker-agnostic persistent execution worktrees. Evidence owns its separate,
// temporary snapshots; job worktrees and branches are deliberately retained.
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

export interface Isolation {
  mode: "worktree" | "in_place";
  worktree_path: string | null;
  branch: string | null;
  base_commit: string | null;
  source_dirty: boolean;
  note: string | null;
}

const exec = promisify(execFile);
async function git(cwd: string, args: string[]) {
  const { stdout } = await exec("git", args, {
    cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

export async function prepareIsolation(cwd: string, jobId: string, stateDir: string): Promise<{ cwd: string; isolation: Isolation }> {
  const source = await realpath(cwd);
  let repo: string;
  try {
    repo = await realpath(await git(source, ["rev-parse", "--show-toplevel"]));
  } catch (error) {
    if (!String(error).includes("not a git repository")) throw error;
    return { cwd: source, isolation: {
      mode: "in_place", worktree_path: null, branch: null, base_commit: null,
      source_dirty: false, note: "cwd is not inside a git repository; running in place",
    } };
  }
  const base = await git(repo, ["rev-parse", "HEAD"]);
  const sourceDirty = (await git(repo, ["status", "--porcelain", "--untracked-files=all"])).length > 0;
  const branch = `c2c/${jobId}`;
  const worktree = resolve(stateDir, "worktrees", jobId);
  await mkdir(dirname(worktree), { recursive: true });
  // A git failure is fatal, including branch collisions and checkout-hook errors.
  await git(repo, ["worktree", "add", "-b", branch, worktree, base]);
  return { cwd: join(worktree, relative(repo, source)), isolation: {
    mode: "worktree", worktree_path: worktree, branch, base_commit: base,
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
