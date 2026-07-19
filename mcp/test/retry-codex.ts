import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

function send(value: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const attemptFile = process.env.ATTEMPT_FILE;
if (!attemptFile) throw new Error("ATTEMPT_FILE is required");
const attempt = existsSync(attemptFile) ? Number(readFileSync(attemptFile, "utf8")) + 1 : 1;
writeFileSync(attemptFile, String(attempt));
const crashPhase = process.env.CRASH_PHASE ?? "starting";

function crash(message: string) {
  process.stderr.write(`${message}\n`);
  setTimeout(() => process.kill(process.pid, "SIGKILL"), 10);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  if (method === "initialize") {
    if (attempt === 1 && crashPhase === "starting") crash("starting-phase crash");
    else send({ id, result: {} });
  } else if (method === "thread/start") {
    send({ id, result: { thread: { id: `thr_retry_${attempt}` } } });
  } else if (method === "thread/resume") {
    send({ id, result: { thread: { id: params.threadId } } });
  } else if (method === "thread/goal/set") {
    send({ id, error: { code: -32601, message: "single turn" } });
  } else if (method === "turn/start") {
    send({ id, result: { turn: { id: "turn" } } });
    send({ method: "turn/started", params: { turn: { id: "turn", status: "inProgress" } } });
    if (attempt === 1 && crashPhase === "midturn") {
      crash("mid-turn crash");
    } else {
      send({ method: "item/completed", params: { item: { type: "agentMessage", text: "healthy result" } } });
      send({
        method: "turn/completed",
        params: { turn: { id: "turn", status: "completed", usage: { inputTokens: 7, output_tokens: 11, totalTokens: 18 } } },
      });
    }
  } else {
    send({ id, error: { code: -32601, message: method } });
  }
});
