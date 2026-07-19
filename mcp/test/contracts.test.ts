import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderDeltaContract, renderGoalContract } from "../src/contracts.ts";

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
  expect(prompt).not.toContain("### Context Files");
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

test("goal prompt renders context files between the goal and constraints", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "c2c-goal-context-"));
  const reference = join(cwd, "reference.md");
  const examples = join(cwd, "examples");
  await writeFile(reference, "SECRET-INLINE-CONTENT");
  await mkdir(examples);

  const prompt = await renderGoalContract({
    ...contract,
    context_files: [
      { path: reference, note: "Defines the expected behavior" },
      { path: examples, note: "Contains representative inputs" },
    ],
  }, cwd);

  expect(prompt).toContain("### Context Files");
  expect(prompt).toContain("Read these files before implementing. They are reference material, not necessarily files to modify.");
  expect(prompt).toContain(`${reference} — Defines the expected behavior`);
  expect(prompt).toContain(`${examples} (directory) — Contains representative inputs`);
  expect(prompt).not.toContain("SECRET-INLINE-CONTENT");
  expect(prompt.indexOf("### Context Files")).toBeGreaterThan(prompt.indexOf("### Goal"));
  expect(prompt.indexOf("### Context Files")).toBeLessThan(prompt.indexOf("### Constraints"));
});

test("delta prompt renders context files after findings and omits the section without them", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "c2c-delta-context-"));
  const reference = join(cwd, "review.md");
  await writeFile(reference, "review notes");

  const prompt = await renderDeltaContract({
    findings: ["The edge case is still broken"],
    failed_conditions: ["All edge cases pass"],
    context_files: [{ path: reference, note: "Shows the failed review case" }],
  });

  expect(prompt).toContain("### Context Files");
  expect(prompt).toContain(`${reference} — Shows the failed review case`);
  expect(prompt.indexOf("### Context Files")).toBeGreaterThan(prompt.indexOf("### Findings"));
  expect(prompt.indexOf("### Context Files")).toBeLessThan(prompt.indexOf("### Failed Success Conditions"));

  const withoutContext = await renderDeltaContract({
    findings: ["The edge case is still broken"],
    failed_conditions: ["All edge cases pass"],
  });
  expect(withoutContext).not.toContain("### Context Files");
});
