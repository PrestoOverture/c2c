import { createInterface } from "node:readline";

function send(value: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

let marker = "rework";
let goal: { objective: string; status: string; tokensUsed: number } | null = null;

function markerFor(objective: string) {
  for (const candidate of ["alpha", "beta", "first", "second", "third", "seed", "blocker"]) {
    if (objective.includes(candidate)) return candidate;
  }
  return "job";
}

function tokenTotal(name: string) {
  return 100 + ["alpha", "beta", "first", "second", "third", "seed", "blocker", "rework"].indexOf(name);
}

function handoff(name: string) {
  return [
    `Completed ${name}.`,
    "",
    "### Changed Files",
    `- ${name}.ts — completed ${name}`,
    "",
    "### Validation",
    `- ${name} validation passed`,
    "",
    "### Success Conditions",
    `- [x] ${name} completed`,
    "",
    "### Risks & Deviations",
    "- none",
  ].join("\n");
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  switch (method) {
    case "initialize":
      send({ id, result: { userAgent: "multi-job-codex/1", codexHome: "/tmp/multi-job-codex" } });
      break;
    case "thread/start":
      send({ id, result: { thread: { id: `thread-${process.pid}` } } });
      break;
    case "thread/resume":
      marker = "rework";
      send({ id, result: { thread: { id: params.threadId } } });
      break;
    case "thread/goal/set":
      marker = markerFor(params.objective);
      goal = { objective: params.objective, status: "active", tokensUsed: 0 };
      send({ id, result: { goal } });
      send({ method: "thread/goal/updated", params: { threadId: params.threadId, goal } });
      break;
    case "thread/goal/get":
      send({ id, result: { goal } });
      break;
    case "turn/start": {
      send({ id, result: { turn: { id: `turn-${process.pid}`, status: "inProgress" } } });
      send({ method: "turn/started", params: { turn: { id: `turn-${process.pid}`, status: "inProgress" } } });
      setTimeout(() => {
        send({
          method: "item/completed",
          params: { item: { type: "agentMessage", text: handoff(marker) } },
        });
        if (goal) {
          goal.status = "complete";
          goal.tokensUsed = tokenTotal(marker);
          send({ method: "thread/goal/updated", params: { threadId: params.threadId, goal } });
        }
        send({
          method: "turn/completed",
          params: { turn: { status: "completed", usage: { inputTokens: tokenTotal(marker) - 90 } } },
        });
      }, Number(process.env.MULTI_JOB_DELAY_MS ?? 350));
      break;
    }
    default:
      send({ id, error: { code: -32601, message: `unsupported ${method}` } });
  }
});
