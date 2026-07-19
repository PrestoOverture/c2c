// Mock `codex app-server` speaking the JSONL JSON-RPC protocol, for e2e tests.
// Simulates: initialize → thread/start|resume → thread/goal/set → turn/start,
// then a two-turn goal-continuation loop ending with goal status "complete".

import { createInterface } from "node:readline";

function send(obj: Record<string, unknown>) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

const HANDOFF = [
  "Implementation finished.",
  "",
  "### Changed Files",
  "- src/thing.ts — added the thing",
  "",
  "### Validation",
  "- `mock-typecheck` passed",
  "- `mock-test` passed (3 tests)",
  "",
  "### Success Conditions",
  "- [x] The thing exists — verified by mock-test",
  "",
  "### Risks & Deviations",
  "- none",
].join("\n");

let goal: { objective: string; status: string; tokensUsed: number; tokenBudget?: number } | null = null;

function runTurn(threadId: string, turnId: string, opts: { continuation: boolean }) {
  send({ method: "turn/started", params: { turn: { id: turnId, status: "inProgress" } } });
  send({
    method: "item/completed",
    params: { item: { id: `${turnId}-cmd`, type: "commandExecution", command: "mock-test" } },
  });
  if (!opts.continuation && goal) {
    // First turn under an active goal: end the turn with the goal still
    // active so the client must handle the continuation path.
    send({
      method: "item/completed",
      params: { item: { id: `${turnId}-msg`, type: "agentMessage", text: "Partial progress; continuing toward goal." } },
    });
    send({ method: "turn/completed", params: { turn: { id: turnId, status: "completed", usage: { outputTokens: 100 } } } });
    // Goal-continuation loop starts another turn shortly after.
    setTimeout(() => runTurn(threadId, "turn_2", { continuation: true }), 150);
  } else {
    send({
      method: "item/completed",
      params: { item: { id: `${turnId}-msg`, type: "agentMessage", text: HANDOFF } },
    });
    if (goal) {
      goal.status = "complete";
      goal.tokensUsed = 1234;
      send({ method: "thread/goal/updated", params: { threadId, goal } });
    }
    send({
      method: "turn/completed",
      params: { turn: { id: turnId, status: "completed", usage: { input_tokens: 20, outputTokens: 500 } } },
    });
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  const { id, method, params } = msg;
  if (id === undefined) return; // notification (e.g. "initialized") — ignore
  switch (method) {
    case "initialize":
      send({ id, result: { userAgent: "mock-codex/0.0.1", codexHome: "/tmp/mock-codex" } });
      break;
    case "config/read":
      send({ id, result: { config: { model: "gpt-mock", model_reasoning_effort: "medium" } } });
      break;
    case "thread/start":
      if (process.env.EXPECT_REASONING_ABSENT && params.config?.model_reasoning_effort !== undefined) {
        send({ id, error: { code: -32602, message: "unexpected thread reasoning effort" } });
        break;
      }
      if (process.env.EXPECT_REASONING_EFFORT && params.config?.model_reasoning_effort !== process.env.EXPECT_REASONING_EFFORT) {
        send({ id, error: { code: -32602, message: "missing expected thread reasoning effort config" } });
        break;
      }
      send({ id, result: { thread: { id: "thr_mock_1" } } });
      break;
    case "thread/resume":
      send({ id, result: { thread: { id: params.threadId } } });
      // A resumed thread keeps its goal; reactivate it for the rework loop.
      if (goal) goal.status = "active";
      break;
    case "thread/goal/set":
      goal = { objective: params.objective, status: "active", tokensUsed: 0, tokenBudget: params.tokenBudget };
      send({ id, result: { goal } });
      send({ method: "thread/goal/updated", params: { threadId: params.threadId, goal } });
      break;
    case "thread/goal/get":
      send({ id, result: { goal } });
      break;
    case "turn/start": {
      if (process.env.EXPECT_REASONING_ABSENT && "effort" in params) {
        send({ id, error: { code: -32602, message: "unexpected turn effort" } });
        break;
      }
      if (process.env.EXPECT_REASONING_EFFORT && params.effort !== process.env.EXPECT_REASONING_EFFORT) {
        send({ id, error: { code: -32602, message: "missing expected turn effort" } });
        break;
      }
      const prompt = params.input?.map((item: any) => item.text ?? "").join("\n") ?? "";
      const expectedContextPaths = process.env.EXPECT_CONTEXT_PATHS
        ? JSON.parse(process.env.EXPECT_CONTEXT_PATHS)
        : [];
      const missingContextPaths = expectedContextPaths.filter((path: string) => !prompt.includes(path));
      if (missingContextPaths.length) {
        send({ id, error: { code: -32602, message: `prompt missing context paths: ${missingContextPaths.join(", ")}` } });
        break;
      }
      send({ id, result: { turn: { id: "turn_1", status: "inProgress", items: [] } } });
      const continuation = goal === null; // rework without a fresh goal-set finishes in one turn
      setTimeout(() => runTurn(params.threadId, "turn_1", { continuation: goal ? false : true }), 50);
      void continuation;
      break;
    }
    default:
      send({ id, error: { code: -32601, message: `mock does not implement ${method}` } });
  }
});
