// Live smoke test against the REAL codex app-server (not run by `bun test`).
// Usage: bun test/live-smoke.ts <scratch-dir>
// Requires: codex installed + logged in. Makes one real (trivial) model run.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const mcpDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = process.argv[2];
if (!scratch) {
  console.error("usage: bun test/live-smoke.ts <scratch-dir>");
  process.exit(2);
}

const transport = new StdioClientTransport({
  command: "bun",
  args: [join(mcpDir, "src", "server.ts")],
  cwd: mcpDir,
  env: {
    ...(process.env as Record<string, string>),
    CODEX_CWD: scratch,
    CODEX_JOB_TIMEOUT_MS: "300000",
    CODEX_QUIET_MS: "20000",
  },
});
const client = new Client({ name: "live-smoke", version: "0.0.1" });
await client.connect(transport);

const payload = (r: any) => JSON.parse(r.content[0].text);

const started = payload(
  await client.callTool({
    name: "codex_implement",
    arguments: {
      goal: "Create a file named hello.txt in the working directory containing exactly the line: hello from codex",
      constraints: ["Touch only hello.txt", "Do not create any other files or directories"],
      success_conditions: ['`cat hello.txt` prints exactly "hello from codex"'],
    },
  }),
);
console.log("started:", JSON.stringify(started));

let status: any;
const deadline = Date.now() + 300_000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 3000));
  status = payload(await client.callTool({ name: "codex_status", arguments: { job_id: started.job_id } }));
  console.log(
    `[${new Date().toISOString().slice(11, 19)}] state=${status.state} turns=${status.turns} goal=${status.goal?.status ?? "-"} last=${
      status.transcript_tail.at(-1)?.kind ?? ""
    }:${(status.transcript_tail.at(-1)?.detail ?? "").slice(0, 80)}`,
  );
  if (status.state !== "starting" && status.state !== "running") break;
}

console.log("\n=== FINAL STATUS ===");
console.log(JSON.stringify(status, null, 2));

if (status.state === "done") {
  const result = payload(await client.callTool({ name: "codex_result", arguments: { job_id: started.job_id } }));
  console.log("\n=== RESULT ===");
  console.log(JSON.stringify({ handoff: result.handoff, final_message: result.final_message }, null, 2));
}

await client.close();
