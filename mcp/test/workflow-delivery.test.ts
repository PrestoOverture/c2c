import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const mcpDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const clients: Client[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function connect() {
  const stateDir = mkdtempSync(join(tmpdir(), "c2c-delivery-"));
  dirs.push(stateDir);
  const transport = new StdioClientTransport({
    command: "bun",
    args: [join(mcpDir, "src", "server.ts")],
    cwd: mcpDir,
    stderr: "pipe",
    env: {
      ...(process.env as Record<string, string>),
      C2C_STATE_DIR: stateDir,
      C2C_LOG_LEVEL: "silent",
      CODEX_BIN: "codex-must-not-spawn-during-delivery",
    },
  });
  const client = new Client({ name: "delivery", version: "1" });
  await client.connect(transport);
  clients.push(client);
  return client;
}

test("server instructions are sent on connect, stay short, and point at the workflow prompt", async () => {
  const client = await connect();
  const instructions = client.getInstructions();

  expect(instructions).toBeString();
  expect(instructions!.length).toBeGreaterThan(0);
  // Always-in-context text: a hard cap keeps the full workflow from being pasted in here.
  expect(instructions!.length).toBeLessThanOrEqual(1000);
  expect(instructions).toContain("c2c-workflow");
  expect(instructions).toContain("Codex");
  // The unconditional role line belongs to the opt-in Prompt only; in instructions it
  // would make Claude refuse to implement anything in every project using c2c.
  expect(instructions).not.toContain("You do not implement the task yourself");
});

test("the full workflow is still served as the c2c-workflow prompt", async () => {
  const client = await connect();
  const { prompts } = await client.listPrompts();
  expect(prompts.map((p) => p.name)).toContain("c2c-workflow");

  const prompt = await client.getPrompt({ name: "c2c-workflow" });
  const text = (prompt.messages[0].content as { text: string }).text;
  expect(text).toContain("You are the **architect and reviewer**");
  expect(text).toContain("### Success Conditions");
});
