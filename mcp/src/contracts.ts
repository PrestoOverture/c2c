// Goal/Delta Contract rendering and handoff parsing.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface GoalContract {
  goal: string;
  constraints: string[];
  success_conditions: string[];
}

export interface DeltaContract {
  findings: string[];
  failed_conditions: string[];
  constraints?: string[];
}

export const PROTOCOL_INSTRUCTIONS = `## Protocol Instructions

### Execution Rules
- Implement exactly what the contract specifies. Do not decide or expand what to build.
- Think before coding: surface confusion and tradeoffs instead of assuming.
- Prefer the minimum code that solves the problem. Make surgical changes and do no extra work.
- Follow the target project's declared toolchain. Add tests whenever a Success Condition requires them.

### Self-Verification
Before declaring completion:
1. Run the project's own typecheck/build and test commands, plus every command named in the Success Conditions. All must pass.
2. Walk through every Success Condition and confirm it is met. If one cannot be met, say so explicitly and do not declare completion.
3. Re-read the Constraints and confirm none were violated, including all "Do not modify" lists.

### Required Handoff
End every task with exactly these sections:

### Changed Files
- path — one-line reason

### Validation
- Commands run and their results.

### Success Conditions
- [x]/[ ] Each condition from the contract, with evidence.

### Risks & Deviations
- Known risks, assumptions, and deviations, or "none".

### Rework
For a Delta Contract, fix only its review findings and failed Success Conditions. Do not revisit work that passed review. Repeat the full Self-Verification and Required Handoff.`;

async function optionalAgentsInstructions(cwd: string): Promise<string | undefined> {
  try {
    return await readFile(join(cwd, "AGENTS.md"), "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function renderGoalContract(c: GoalContract, cwd = process.cwd()): Promise<string> {
  const agents = await optionalAgentsInstructions(cwd);
  const lines = [
    PROTOCOL_INSTRUCTIONS,
    ...(agents ? ["", "## Project Instructions", "", agents.trim()] : []),
    "",
    "## Goal Contract",
    "",
    "### Goal",
    c.goal.trim(),
    "",
    "### Constraints",
    ...c.constraints.map((x) => `- ${x}`),
    "",
    "### Success Conditions",
    ...c.success_conditions.map((x) => `- [ ] ${x}`),
  ];
  return lines.join("\n");
}

export function renderDeltaContract(d: DeltaContract): string {
  const lines = [
    PROTOCOL_INSTRUCTIONS,
    "",
    "## Delta Contract",
    "",
    "### Findings",
    ...d.findings.map((x) => `- ${x}`),
    "",
    "### Failed Success Conditions",
    ...d.failed_conditions.map((x) => `- [ ] ${x}`),
    "",
    "### Constraints",
    "- Original constraints still apply. Fix only the findings above; do not touch work that passed.",
    ...(d.constraints ?? []).map((x) => `- ${x}`),
  ];
  return lines.join("\n");
}

// Objective string for Codex's thread goal (`thread/goal/set`). Kept compact:
// the full contract goes in the turn prompt; the objective is what the /goal
// loop audits against before declaring "Goal achieved".
export function renderObjective(c: GoalContract, maxLen: number): string {
  const conditions = c.success_conditions.map((x) => `(${x})`).join(" ");
  const text =
    `Fulfill this Goal Contract: ${c.goal.trim()} ` +
    `The goal is achieved only when every Success Condition is verified: ${conditions} ` +
    `and a structured handoff (Changed Files / Validation / Success Conditions / Risks & Deviations) has been delivered.`;
  return text.length <= maxLen ? text : text.slice(0, maxLen - 1) + "…";
}

export const HANDOFF_SECTIONS = [
  "Changed Files",
  "Validation",
  "Success Conditions",
  "Risks & Deviations",
] as const;

export interface Handoff {
  valid: boolean;
  missing: string[];
  sections: Record<string, string>;
}

// Parses Codex's final message for the mandatory handoff sections.
// Accepts ##/### headings, optional trailing colon, case-insensitive.
export function parseHandoff(text: string): Handoff {
  const sections: Record<string, string> = {};
  const headingRe = /^#{2,4}\s+(.+?):?\s*$/gm;
  const found: { name: string; start: number; contentStart: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(text)) !== null) {
    found.push({ name: m[1].trim(), start: m.index, contentStart: m.index + m[0].length });
  }
  for (let i = 0; i < found.length; i++) {
    const end = i + 1 < found.length ? found[i + 1].start : text.length;
    const canonical = HANDOFF_SECTIONS.find(
      (s) => s.toLowerCase() === found[i].name.toLowerCase(),
    );
    if (canonical) sections[canonical] = text.slice(found[i].contentStart, end).trim();
  }
  const missing = HANDOFF_SECTIONS.filter((s) => !(s in sections));
  return { valid: missing.length === 0, missing: [...missing], sections };
}
