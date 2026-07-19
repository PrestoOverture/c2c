import { createInterface } from "node:readline";

function send(message: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let goal: { objective: string; status: string; tokensUsed: number } | undefined;

function completeTurn(threadId: string) {
  goal!.status = "complete";
  goal!.tokensUsed = 10;
  send({ method: "thread/goal/updated", params: { threadId, goal } });
  send({
    method: "item/completed",
    params: { item: { id: "final-message", type: "agentMessage", text: "stall mock completed" } },
  });
  send({ method: "turn/completed", params: { turn: { id: "turn_stall", status: "completed" } } });
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;

  switch (method) {
    case "initialize":
      send({ id, result: { userAgent: "stall-codex/0.0.1", codexHome: "/tmp/stall-codex" } });
      break;
    case "thread/start":
      send({ id, result: { thread: { id: "thr_stall" } } });
      break;
    case "thread/goal/set": {
      goal = { objective: params.objective, status: "active", tokensUsed: 0 };
      send({ id, result: { goal } });
      send({ method: "thread/goal/updated", params: { threadId: params.threadId, goal } });
      break;
    }
    case "turn/start":
      send({ id, result: { turn: { id: "turn_stall", status: "inProgress", items: [] } } });
      setTimeout(() => {
        send({ method: "turn/started", params: { turn: { id: "turn_stall", status: "inProgress" } } });
        send({
          method: "item/completed",
          params: { item: { id: "initial-item", type: "commandExecution", command: "mock-work" } },
        });
        if (process.env.STALL_MODE === "active") {
          let item = 0;
          const activity = setInterval(() => {
            item += 1;
            send({
              method: "item/completed",
              params: { item: { id: `active-item-${item}`, type: "commandExecution", command: "mock-active-work" } },
            });
            if (item === 6) {
              clearInterval(activity);
              completeTurn(params.threadId);
            }
          }, 75);
          return;
        }

        const noise = setInterval(() => process.stderr.write("mock stderr noise during stalled stream\n"), 50);
        if (process.env.STALL_MODE === "resume") {
          setTimeout(() => {
            clearInterval(noise);
            send({
              method: "item/completed",
              params: { item: { id: "resumed-item", type: "commandExecution", command: "mock-resumed-work" } },
            });
            completeTurn(params.threadId);
          }, 450);
        }
      }, 20);
      break;
    default:
      send({ id, error: { code: -32601, message: `mock does not implement ${method}` } });
  }
});
