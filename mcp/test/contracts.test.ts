import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderGoalContract } from "../src/contracts.ts";

const contract = {
  goal: "Ship the feature",
  constraints: ["Keep it small"],
  success_conditions: ["Tests pass"],
};

test("goal prompt embeds the complete project-independent protocol", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "c2c-no-agents-"));
  const prompt = await renderGoalContract(contract, cwd);

  expect(prompt).toContain("## Protocol Instructions");
  expect(prompt).toContain("Self-Verification");
  expect(prompt).toContain("Run the project's own typecheck/build and test commands");
  expect(prompt).toContain("### Changed Files");
  expect(prompt).toContain("### Validation");
  expect(prompt).toContain("### Success Conditions");
  expect(prompt).toContain("### Risks & Deviations");
  expect(prompt).toContain("Rework");
  expect(prompt).not.toContain("Follow AGENTS.md");
  expect(prompt).toContain("### Goal\nShip the feature");
});

test("goal prompt inserts optional AGENTS.md between protocol and contract", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "c2c-with-agents-"));
  await writeFile(join(cwd, "AGENTS.md"), "PROJECT-ONLY-INSTRUCTION");

  const prompt = await renderGoalContract(contract, cwd);
  const protocol = prompt.indexOf("## Protocol Instructions");
  const agents = prompt.indexOf("PROJECT-ONLY-INSTRUCTION");
  const body = prompt.indexOf("## Goal Contract");

  expect(protocol).toBeGreaterThanOrEqual(0);
  expect(agents).toBeGreaterThan(protocol);
  expect(body).toBeGreaterThan(agents);
});
