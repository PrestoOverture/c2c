import { accessSync, constants, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Job } from "./jobs.ts";
import { writeLog } from "./log.ts";

const MAX_JOBS = 50;
let warned = false;

/**
 * Interface defining operations for managing persistent job state records.
 */
export interface JobStore {
  /** Looks up a job record by its unique identifier */
  getJob(id: string): Job | undefined;
  /** Returns an array of all currently stored job records */
  listJobs(): Job[];
  /** Saves or updates a job record in the persistent store */
  save(job: Job): void;
}

/**
 * Emits a single degradation warning log when disk persistence fails, logging at most once per process lifetime.
 *
 * @param error - The error instance or error message describing the persistence failure
 */
function warnOnce(error: unknown) {
  if (warned) return;
  warned = true;
  writeLog("error", "persistence_degraded", {
    error: error instanceof Error ? error.message : String(error),
  });
}

/**
 * Resolves the default directory path used for persisting job state JSON files.
 *
 * @returns Absolute directory path for stored job state files
 */
export function defaultStateDir(): string {
  return process.env.C2C_STATE_DIR ?? join(homedir(), ".claude2codex", "jobs");
}

/**
 * Creates and initializes a persistent job store instance that handles loading, saving, and pruning job state files.
 *
 * @param dir - Directory path for storing persistent job files, defaulting to defaultStateDir()
 * @returns JobStore instance providing lookup, listing, and save methods
 */
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
    /**
     * Retrieves a job from memory by its unique identifier.
     *
     * @param id - Unique job identifier to look up
     * @returns The matching Job object, or undefined if not found
     */
    getJob: (id) => records.get(id),

    /**
     * Returns a list of all currently cached jobs.
     *
     * @returns Array of cached Job objects
     */
    listJobs: () => [...records.values()],

    /**
     * Persists job state and transcript history to memory cache and atomic disk storage.
     *
     * @param job - Job object to be saved
     */
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

/**
 * Writes job state to a temporary file before atomically renaming it, preventing corrupt or partial writes on disk.
 *
 * @param dir - Target directory path for file storage
 * @param job - Job object to serialize and save
 */
function atomicWrite(dir: string, job: Job) {
  const target = join(dir, `${job.id}.json`);
  const temp = join(dir, `.${job.id}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(temp, JSON.stringify(job), { encoding: "utf8", mode: 0o600 });
  renameSync(temp, target);
}

/**
 * Sorts jobs by timestamp and deletes old job files exceeding the maximum retention limit.
 *
 * @param dir - Directory path containing persisted job files
 * @param records - Map of active in-memory job records
 */
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
