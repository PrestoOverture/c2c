// A small app-server fixture that writes (and optionally commits) real files in
// its process cwd. Record the RPC cwd too: both must select the isolated tree.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

const send = (message: unknown) => process.stdout.write(JSON.stringify(message) + "\n");
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
let threadId = "";
let threadCwd = "";
let goal = { status: "active" };

createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  switch (method) {
    case "initialize": send({ id, result: {} }); break;
    case "thread/start":
    case "thread/resume":
      threadId = params.threadId ?? randomUUID();
      threadCwd = params.cwd;
      send({ id, result: { thread: { id: threadId } } });
      break;
    case "thread/goal/set":
      goal = { status: "active" };
      send({ id, result: { goal } });
      break;
    case "thread/goal/get": send({ id, result: { goal } }); break;
    case "turn/start": {
      send({ id, result: { turn: { id: "turn" } } });
      send({ method: "turn/started", params: {} });
      const prompt = params.input[0].text as string;
      const name = /write:([a-z]+)/.exec(prompt)?.[1] ?? "worker";
      // Delay the write so concurrent tests exercise overlapping worker runs.
      setTimeout(() => {
        const file = `${name}.txt`;
        const previous = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { rounds: 0 };
        let branch: string | null = null;
        try { branch = git("branch", "--show-current"); } catch { /* non-git fixture */ }
        writeFileSync(file, JSON.stringify({ cwd: process.cwd(), threadCwd, branch, threadId, rounds: previous.rounds + 1 }));
        if (prompt.includes("falsify:true")) {
          writeFileSync("production.txt", "after\n");
          writeFileSync("added.check", "echo checking-committed-test; test ! -e deleted.check && grep -q after production.txt\n");
          unlinkSync("deleted.check");
        }
        if (prompt.includes("commit:true")) {
          git("add", ".");
          git("commit", "-qm", "worker change");
        }
        goal = { status: "complete" };
        send({ method: "thread/goal/updated", params: { goal } });
        send({ method: "item/completed", params: { item: { type: "agentMessage", text:
          "### Changed Files\n- fixture\n### Validation\n- fixture passed\n### Success Conditions\n- [x] fixture\n### Risks & Deviations\n- none" } } });
        send({ method: "turn/completed", params: { turn: { status: "completed" } } });
      }, 150);
      break;
    }
    default: send({ id, error: { code: -32601, message: method } });
  }
});
