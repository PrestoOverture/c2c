// Worker-agnostic integration. The job manager owns serialization and lineage locks.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { runChecks, type Evidence } from "./evidence.ts";
import { commitIdentity, git, validateIsolation, type Isolation } from "./isolation.ts";

export interface MergeResult {
  job_id: string;
  status: "merged" | "conflict" | "verification_failed" | "target_blocked" | "discarded" | "refused";
  at: string;
  commit?: string;
  files?: string[];
  evidence?: Evidence;
  error?: string;
  cleaned_up?: boolean;
}

interface MergeOptions {
  job_id: string;
  isolation: Isolation;
  cwd: string;
  cleanup?: boolean;
  discard?: boolean;
  setup_commands?: string[];
  verify_commands?: string[];
  timeoutMs?: number;
}

async function cleanup(repo: string, isolation: Isolation) {
  await git(repo, ["worktree", "remove", "--force", "--force", isolation.worktree_path!]);
  await git(repo, ["worktree", "prune"]);
  await git(repo, ["branch", "-D", isolation.branch!]);
}

export async function mergeIsolatedWork(opts: MergeOptions): Promise<MergeResult> {
  const { isolation } = opts;
  validateIsolation(isolation, opts.cwd);
  const repo = await git(isolation.worktree_path!, ["rev-parse", "--git-common-dir"]);
  const result: MergeResult = { job_id: opts.job_id, status: "target_blocked", at: new Date().toISOString() };
  // Use the common git directory as the stable command cwd, even after cleanup.
  if (opts.discard) {
    await cleanup(repo, isolation);
    return { ...result, status: "discarded", cleaned_up: true };
  }
  if (!isolation.target_branch) return { ...result, error: "isolation has no target branch (detached source)" };
  const ref = `refs/heads/${isolation.target_branch}`;
  let target: string;
  try { target = await git(repo, ["rev-parse", "--verify", ref]); } catch (error) {
    return { ...result, error: `target branch is unavailable: ${String(error)}` };
  }
  const branchTip = await git(repo, ["rev-parse", "--verify", `refs/heads/${isolation.branch}`]);
  const temp = await mkdtemp(join(tmpdir(), "c2c-merge-"));
  const tree = join(temp, "merged");
  let commit: string | undefined;
  try {
    await git(repo, ["-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", tree, target]);
    try {
      await git(tree, [...await commitIdentity(tree), "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false",
        "merge", "--no-ff", "--no-verify", "-m", `Merge ${isolation.branch} into ${isolation.target_branch}`, branchTip]);
    } catch (error) {
      const files = (await git(tree, ["diff", "--name-only", "--diff-filter=U", "-z"])).split("\0").filter(Boolean);
      if (!files.length) throw error;
      return { ...result, status: "conflict", files };
    }
    commit = await git(tree, ["rev-parse", "HEAD"]);
    const evidence: Evidence = {
      environment: "worktree", base_commit: target, passed: false, setup: [], commands: [],
      falsification: { ran: false, skipped_reason: "merge verification", setup: [], commands: [], unfalsified: [] },
    };
    Object.assign(evidence, await runChecks(opts, join(tree, relative(isolation.worktree_path!, opts.cwd))));
    if (!evidence.passed) return { ...result, status: "verification_failed", evidence };
    result.evidence = evidence;
  } finally {
    // Remove even conflicted or setup-dirtied trees, including failed checkout hooks.
    try {
      await git(repo, ["worktree", "remove", "--force", "--force", tree]);
    } finally {
      await rm(temp, { recursive: true, force: true });
      await git(repo, ["worktree", "prune"]);
    }
  }
  // Verification may take minutes: never integrate if the target moved meanwhile.
  try {
    if (await git(repo, ["rev-parse", ref]) !== target) return { ...result, error: "target branch moved during verification" };
  } catch (error) {
    return { ...result, error: `target branch moved or disappeared during verification: ${String(error)}` };
  }
  const worktrees = (await git(repo, ["worktree", "list", "--porcelain", "-z"])).split("\0\0");
  const checkedOut = worktrees.filter((entry) => entry.split("\0").includes(`branch ${ref}`));
  try {
    if (checkedOut.length) {
      if (checkedOut.length !== 1) return { ...result, error: "target branch is checked out in multiple worktrees" };
      const path = checkedOut[0].split("\0").find((line) => line.startsWith("worktree "))!.slice(9);
      // This is the sole mutation allowed in the target working tree. Git refuses
      // overlapping dirty files; autostash and hooks must not change that behavior.
      await git(path, ["-c", "core.hooksPath=/dev/null", "-c", "merge.autoStash=false", "merge", "--ff-only", "--no-overwrite-ignore", "--no-edit", commit!]);
    } else {
      await git(repo, ["update-ref", ref, commit!, target]);
    }
  } catch (error) {
    return { ...result, error: String(error) };
  }
  result.status = "merged";
  result.commit = commit;
  if (opts.cleanup !== false) {
    try {
      await cleanup(repo, isolation);
      result.cleaned_up = true;
    } catch (error) {
      // Integration succeeded: never misreport it as a failed, untouched attempt.
      result.cleaned_up = false;
      result.error = `merged, but cleanup failed: ${String(error)}`;
    }
  } else result.cleaned_up = false;
  return result;
}
