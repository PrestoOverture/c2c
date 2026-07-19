import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJobStore } from "../src/store.ts";
import type { Job } from "../src/jobs.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function job(id: string, state: Job["state"]): Job {
  return {
    id, kind: "implement", state, threadId: `thread-${id}`, goalSet: true,
    turns: 2, transcript: [{ at: new Date().toISOString(), kind: "test", detail: id }],
    startedAt: new Date().toISOString(),
  };
}

test("job persistence round-trips and interrupts running jobs on load", () => {
  const dir = mkdtempSync(join(tmpdir(), "c2c-store-"));
  dirs.push(dir);
  const first = createJobStore(dir);
  first.save(job("done", "done"));
  first.save(job("running", "running"));

  const fresh = createJobStore(dir);
  expect(fresh.getJob("done")).toEqual(first.getJob("done"));
  expect(fresh.getJob("running")?.state).toBe("error");
  expect(fresh.getJob("running")?.error).toContain("interrupted by server restart");
  expect(createJobStore(dir).getJob("running")?.state).toBe("error");
});

test("job persistence retains only the 50 most recent records", () => {
  const dir = mkdtempSync(join(tmpdir(), "c2c-retention-"));
  dirs.push(dir);
  const store = createJobStore(dir);
  for (let index = 0; index < 55; index++) {
    const record = job(String(index), "done");
    record.startedAt = new Date(1_700_000_000_000 + index).toISOString();
    store.save(record);
  }
  expect(createJobStore(dir).listJobs()).toHaveLength(50);
  expect(createJobStore(dir).getJob("0")).toBeUndefined();
  expect(createJobStore(dir).getJob("54")).toBeDefined();
});
