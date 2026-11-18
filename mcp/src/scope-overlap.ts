// Read-only, worker-agnostic advice. Never persisted or used as a job/merge gate.
import { realpath, stat } from "node:fs/promises";
import { changedFiles, matchingFiles } from "./evidence.ts";
import { git, type Isolation } from "./isolation.ts";

interface OverlapJob {
  id: string;
  startedAt: string;
  reworkRound?: number;
  isolation?: Isolation;
  isolationCwd?: string;
  scope?: string[];
  merge?: { at: string; status: string };
}

interface OverlapSummary {
  scope_overlap?: { job_id: string; files: string[] }[];
  scope_overlap_error?: string;
}

async function worktreeExists(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function repository(job: OverlapJob): Promise<string> {
  return realpath(await git(job.isolation!.worktree_path!, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
}

async function files(job: OverlapJob): Promise<Set<string>> {
  const isolation = job.isolation!;
  const [planned, changed] = await Promise.all([
    matchingFiles(job.isolationCwd ?? isolation.worktree_path!, isolation.base_commit!, job.scope?.filter((path) => path.trim() !== "")),
    changedFiles(isolation.worktree_path!, isolation.base_commit!),
  ]);
  return new Set([...planned, ...changed]);
}

export async function scopeOverlap(job: OverlapJob, jobs: OverlapJob[]): Promise<OverlapSummary> {
  if (job.isolation?.mode !== "worktree") return {};
  const result: OverlapSummary = { scope_overlap: [] };
  const errors: string[] = [];
  const fail = (other: OverlapJob, error: unknown) => errors.push(`${other.id}: ${String(error)}`);
  try {
    const path = job.isolation.worktree_path!;
    const lineages = new Map<string, OverlapJob[]>();
    for (const other of jobs) {
      const otherPath = other.isolation?.worktree_path;
      if (other.isolation?.mode !== "worktree" || !otherPath || otherPath === path) continue;
      const lineage = lineages.get(otherPath) ?? [];
      lineage.push(other);
      lineages.set(otherPath, lineage);
    }
    // Single-lineage polling needs no git reads: there can be no overlap.
    if (!lineages.size) return result;
    // A merged/discarded job can still be queried after cleanup.
    if (!await worktreeExists(path)) return result;
    const [repo, ownFiles] = await Promise.all([repository(job), files(job)]);
    for (const [otherPath, lineage] of lineages) {
      const latest = lineage.reduce((a, b) => {
        const time = Date.parse(b.startedAt) - Date.parse(a.startedAt);
        return time > 0 || (time === 0 && (b.reworkRound ?? 0) > (a.reworkRound ?? 0)) ? b : a;
      });
      const merge = lineage.flatMap((item) => item.merge ? [item.merge] : [])
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
      if (merge?.status === "merged" || merge?.status === "discarded") continue;
      try {
        if (!await worktreeExists(otherPath) || await repository(latest) !== repo) continue;
        const shared = [...await files(latest)].filter((file) => ownFiles.has(file)).sort();
        if (shared.length) result.scope_overlap!.push({ job_id: latest.id, files: shared });
      } catch (error) { fail(latest, error); }
    }
  } catch (error) { fail(job, error); }
  result.scope_overlap!.sort((a, b) => a.job_id.localeCompare(b.job_id));
  if (errors.length) result.scope_overlap_error = errors.join("; ");
  return result;
}
