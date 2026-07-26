import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { renderObjective, renderObjectiveDetails, type GoalContract } from "../src/contracts.ts";

const mcpDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function payload(result: any) {
  return JSON.parse(result.content[0].text);
}

async function connect(root: string, objectiveMax: number) {
  const stateDir = join(root, "state");
  const objectiveFile = join(root, "objective.txt");
  const spawnMarker = join(root, "spawned.txt");
  mkdirSync(stateDir);
  const transport = new StdioClientTransport({
    command: "bun",
    args: [join(mcpDir, "src", "server.ts")],
    cwd: mcpDir,
    env: {
      ...(process.env as Record<string, string>),
      CODEX_BIN: "bun",
      CODEX_ARGS: join(mcpDir, "test", "mock-codex.ts"),
      CODEX_QUIET_MS: "20",
      CODEX_JOB_TIMEOUT_MS: "5000",
      C2C_STATE_DIR: stateDir,
      C2C_LOG_LEVEL: "silent",
      GOAL_OBJECTIVE_MAX: String(objectiveMax),
      OBJECTIVE_FILE: objectiveFile,
      SPAWN_MARKER_FILE: spawnMarker,
    },
  });
  const client = new Client({ name: "objective-budget", version: "1" });
  await client.connect(transport);
  return { client, stateDir, objectiveFile, spawnMarker };
}

const contract: GoalContract = {
  goal: "Implement the objective-budget behavior " + "x".repeat(180),
  constraints: [],
  success_conditions: ["All objective bytes are preserved", "The validation passes"],
};

test("over-limit implement is rejected before job creation or process spawn", async () => {
  const root = mkdtempSync(join(tmpdir(), "c2c-objective-reject-"));
  dirs.push(root);
  const max = 200;
  const rendered = renderObjectiveDetails(contract, max);
  const { client, stateDir, spawnMarker } = await connect(root, max);
  try {
    const before = readdirSync(stateDir);
    const result: any = await client.callTool({ name: "codex_implement", arguments: { ...contract } });
    expect(result.isError).toBe(true);
    expect(payload(result).job_id).toBeUndefined();
    expect(payload(result).error).toContain(String(rendered.objectiveChars));
    expect(payload(result).error).toContain(String(max));
    expect(payload(result).error).toContain("GOAL_OBJECTIVE_MAX");
    expect(payload(result).error).toContain("Shorten goal or success_conditions");
    expect(payload(result).error).toContain("raise GOAL_OBJECTIVE_MAX");
    expect(readdirSync(stateDir)).toEqual(before);
    expect(existsSync(spawnMarker)).toBe(false);
  } finally {
    await client.close();
  }
});

test("under-limit implement passes the exact rendered objective to Codex", async () => {
  const root = mkdtempSync(join(tmpdir(), "c2c-objective-pass-"));
  dirs.push(root);
  const max = 2000;
  const expected = renderObjective(contract, max);
  const { client, stateDir, objectiveFile, spawnMarker } = await connect(root, max);
  try {
    const result: any = await client.callTool({ name: "codex_implement", arguments: { ...contract } });
    expect(result.isError ?? false).toBe(false);
    expect(payload(result).job_id).toBeTruthy();
    const deadline = Date.now() + 2000;
    while (!existsSync(objectiveFile) && Date.now() < deadline) await Bun.sleep(10);
    expect(readFileSync(objectiveFile, "utf8")).toBe(expected);
    expect(existsSync(join(stateDir, `${payload(result).job_id}.json`))).toBe(true);
    expect(existsSync(spawnMarker)).toBe(true);
  } finally {
    await client.close();
  }
});

test("raising GOAL_OBJECTIVE_MAX accepts the same previously rejected contract", async () => {
  const root = mkdtempSync(join(tmpdir(), "c2c-objective-raised-"));
  dirs.push(root);
  const max = renderObjectiveDetails(contract, Number.MAX_SAFE_INTEGER).objectiveChars;
  const { client, stateDir, objectiveFile } = await connect(root, max);
  try {
    const result: any = await client.callTool({ name: "codex_implement", arguments: { ...contract } });
    expect(result.isError ?? false).toBe(false);
    expect(payload(result).job_id).toBeTruthy();
    const deadline = Date.now() + 2000;
    while (!existsSync(objectiveFile) && Date.now() < deadline) await Bun.sleep(10);
    expect(readFileSync(objectiveFile, "utf8")).toBe(renderObjective(contract, max));
    expect(existsSync(join(stateDir, `${payload(result).job_id}.json`))).toBe(true);
  } finally {
    await client.close();
  }
});

test("estimate reports objective budget and both tool schemas document rejection", async () => {
  const root = mkdtempSync(join(tmpdir(), "c2c-objective-estimate-"));
  dirs.push(root);
  const max = 200;
  const rendered = renderObjectiveDetails(contract, max);
  const { client, stateDir, spawnMarker } = await connect(root, max);
  try {
    const before = readdirSync(stateDir);
    const result: any = await client.callTool({ name: "codex_estimate", arguments: { ...contract } });
    expect(result.isError ?? false).toBe(false);
    expect(payload(result)).toMatchObject({
      objective_chars: rendered.objectiveChars,
      objective_max_chars: max,
      objective_over_limit: true,
    });
    expect(readdirSync(stateDir)).toEqual(before);
    expect(existsSync(spawnMarker)).toBe(false);

    const tools = await client.listTools();
    for (const name of ["codex_implement", "codex_estimate"]) {
      const schema: any = tools.tools.find((tool) => tool.name === name)?.inputSchema;
      for (const field of ["goal", "success_conditions"]) {
        expect(schema.properties[field].description).toContain("GOAL_OBJECTIVE_MAX");
        expect(schema.properties[field].description).toContain(String(max));
        expect(schema.properties[field].description).toContain("over-limit calls are rejected");
      }
    }
  } finally {
    await client.close();
  }
});
