import { existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

function send(value: Record<string, unknown>) {
  process.stdout.write(JSON.stringify(value) + "\n");
}

const marker = process.env.CRASH_MARKER;
const shouldCrash = Boolean(marker && !existsSync(marker));
if (shouldCrash && marker) writeFileSync(marker, "crashed");

createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  if (method === "initialize") send({ id, result: {} });
  else if (method === "thread/start") send({ id, result: { thread: { id: "thr_crash" } } });
  else if (method === "thread/resume") send({ id, result: { thread: { id: params.threadId } } });
  else if (method === "thread/goal/set") send({ id, error: { code: -32601, message: "single turn" } });
  else if (method === "turn/start") {
    send({ id, result: { turn: { id: "turn" } } });
    if (shouldCrash) {
      send({ method: "turn/started", params: { turn: { id: "turn" } } });
      process.stderr.write("fatal mock crash diagnostic\n");
      setTimeout(() => process.kill(process.pid, "SIGKILL"), Number(process.env.CRASH_DELAY_MS ?? 20));
    } else {
      send({ method: "turn/started", params: { turn: { id: "turn" } } });
      send({ method: "item/completed", params: { item: { type: "agentMessage", text: "healthy result" } } });
      send({ method: "turn/completed", params: { turn: { id: "turn", status: "completed" } } });
    }
  } else send({ id, error: { code: -32601, message: method } });
});
