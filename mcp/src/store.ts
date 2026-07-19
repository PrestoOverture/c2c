import { accessSync, constants, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Job } from "./jobs.ts";
import { writeLog } from "./log.ts";

const MAX_JOBS = 50;
let warned = false;

export interface JobStore {
  getJob(id: string): Job | undefined;
  listJobs(): Job[];
  save(job: Job): void;
}

function warnOnce(error: unknown) {
  if (warned) return;
  warned = true;
  writeLog("error", "persistence_degraded", {
    error: error instanceof Error ? error.message : String(error),
  });
}

export function defaultStateDir(): string {
  return process.env.C2C_STATE_DIR ?? join(homedir(), ".claude2codex", "jobs");
}

export function createJobStore(dir = defaultStateDir()): JobStore {
  const records = new Map<string, Job>();
  let enabled = true;

  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.R_OK | constants.W_OK);
    const interrupted: Job[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const job = JSON.parse(readFileSync(join(dir, name), "utf8")) as Job;
        if (!job?.id || !job?.startedAt || !Array.isArray(job.transcript)) continue;
        if (job.state === "blocked" || job.state === "queued" || job.state === "starting" || job.state === "running") {
          job.state = "error";
          job.error = "interrupted by server restart";
          job.endedAt = new Date().toISOString();
          interrupted.push(job);
        }
        records.set(job.id, job);
      } catch {
        // Ignore malformed or concurrently replaced state files.
      }
    }
    for (const job of interrupted) atomicWrite(dir, job);
    prune(dir, records);
  } catch (error) {
    enabled = false;
    warnOnce(error);
  }

  return {
    getJob: (id) => records.get(id),
    listJobs: () => [...records.values()],
    save(job) {
      const record = { ...job, transcript: job.transcript.slice(-200) };
      records.set(job.id, record);
      if (!enabled) return;
      try {
        atomicWrite(dir, record);
        prune(dir, records);
      } catch (error) {
        enabled = false;
        warnOnce(error);
      }
    },
  };
}

function atomicWrite(dir: string, job: Job) {
  const target = join(dir, `${job.id}.json`);
  const temp = join(dir, `.${job.id}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(temp, JSON.stringify(job), { encoding: "utf8", mode: 0o600 });
  renameSync(temp, target);
}

function prune(dir: string, records: Map<string, Job>) {
  const entries = [...records.values()].sort((a, b) =>
    Date.parse(b.endedAt ?? b.startedAt) - Date.parse(a.endedAt ?? a.startedAt),
  );
  for (const job of entries.slice(MAX_JOBS)) {
    records.delete(job.id);
    try {
      unlinkSync(join(dir, `${job.id}.json`));
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}
