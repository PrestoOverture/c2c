// Goal/Delta Contract rendering and handoff parsing.
import { statSync } from "node:fs";

/**
 * Contract specifying the primary goal, technical constraints, and success criteria for an implementation task.
 */
export interface GoalContract {
  /** Detailed description of what the code implementation must achieve */
  goal: string;
  /** Technical boundaries, files to touch, and patterns to strictly follow or avoid */
  constraints: string[];
  /** Checkable criteria proving the task objective is fully met */
  success_conditions: string[];
  /** Optional list of reference files or directories for Codex to read before starting */
  context_files?: ContextFile[];
}

/**
 * Contract specifying code review findings and failed conditions for a rework task.
 */
export interface DeltaContract {
  /** Specific review findings, flaws, or issues identified during code review */
  findings: string[];
  /** List of success conditions from the original contract that failed verification */
  failed_conditions: string[];
  /** Additional constraints or guidelines for fixing the reported issues */
  constraints?: string[];
  /** Optional list of reference files or directories relevant to the rework task */
  context_files?: ContextFile[];
}

/**
 * Represents a reference file or directory provided to Codex as context.
 */
export interface ContextFile {
  /** Relative or absolute filesystem path to the reference file or directory */
  path: string;
  /** Optional note or explanation describing why this file is provided as context */
  note?: string;
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

/**
 * Formats a list of reference context files into a Markdown section for Codex to read before coding.
 *
 * @param contextFiles - List of files or directories for Codex to reference (optional)
 * @returns Array of formatted Markdown lines
 */
function renderContextFiles(contextFiles?: ContextFile[]): string[] {
  if (!contextFiles?.length) return [];
  return [
    "### Context Files",
    "Read these files before implementing. They are reference material, not necessarily files to modify.",
    ...contextFiles.map((contextFile) => {
      const directory = statSync(contextFile.path).isDirectory() ? " (directory)" : "";
      const note = contextFile.note ? ` — ${contextFile.note}` : "";
      return `- ${contextFile.path}${directory}${note}`;
    }),
    "",
  ];
}

/**
 * Combines protocol instructions and a Goal Contract into a complete prompt string for Codex execution.
 *
 * @param c - Goal contract containing the primary goal, constraints, and success conditions
 * @returns Fully rendered prompt string ready to send to Codex
 */
export function renderGoalContract(c: GoalContract): string {
  const lines = [
    PROTOCOL_INSTRUCTIONS,
    "",
    "## Goal Contract",
    "",
    "### Goal",
    c.goal.trim(),
    "",
    ...renderContextFiles(c.context_files),
    "### Constraints",
    ...c.constraints.map((x) => `- ${x}`),
    "",
    "### Success Conditions",
    ...c.success_conditions.map((x) => `- [ ] ${x}`),
  ];
  return lines.join("\n");
}

/**
 * Formats a Delta Contract (review findings and failed conditions) into a prompt for targeted rework.
 *
 * @param d - Delta contract containing review findings, failed conditions, and optional extra constraints
 * @returns Fully rendered rework prompt string
 */
export function renderDeltaContract(d: DeltaContract): string {
  const lines = [
    PROTOCOL_INSTRUCTIONS,
    "",
    "## Delta Contract",
    "",
    "### Findings",
    ...d.findings.map((x) => `- ${x}`),
    "",
    ...renderContextFiles(d.context_files),
    "### Failed Success Conditions",
    ...d.failed_conditions.map((x) => `- [ ] ${x}`),
    "",
    "### Constraints",
    "- Original constraints still apply. Fix only the findings above; do not touch work that passed.",
    ...(d.constraints ?? []).map((x) => `- ${x}`),
  ];
  return lines.join("\n");
}

/**
 * Extracts key points from a Goal Contract into a concise objective string for Codex's goal loop auditing.
 *
 * @param c - Goal contract containing the goal and success conditions
 * @param maxLen - Maximum allowed character length for the objective string
 * @returns Truncated objective string within the character budget
 */
export function renderObjective(c: GoalContract, maxLen: number): string {
  return renderObjectiveDetails(c, maxLen).objective;
}

/**
 * Renders a compact objective string for goal auditing and calculates its raw length for budget validation.
 *
 * @param c - Goal contract containing the goal and success conditions
 * @param maxLen - Maximum allowed character length for the objective string
 * @returns Object containing the formatted objective string and its raw character length before truncation
 */
export function renderObjectiveDetails(c: GoalContract, maxLen: number): {
  objective: string;
  objectiveChars: number;
} {
  const conditions = c.success_conditions.map((x) => `(${x})`).join(" ");
  const text =
    `Fulfill this Goal Contract: ${c.goal.trim()} ` +
    `The goal is achieved only when every Success Condition is verified: ${conditions} ` +
    `and a structured handoff (Changed Files / Validation / Success Conditions / Risks & Deviations) has been delivered.`;
  return {
    objective: text.length <= maxLen ? text : text.slice(0, maxLen - 1) + "…",
    objectiveChars: text.length,
  };
}

export const HANDOFF_SECTIONS = [
  "Changed Files",
  "Validation",
  "Success Conditions",
  "Risks & Deviations",
] as const;

/**
 * Structured summary extracted from Codex's final completion message.
 */
export interface Handoff {
  /** True if all mandatory handoff sections were present in Codex's final message */
  valid: boolean;
  /** List of required section titles that were missing from Codex's output */
  missing: string[];
  /** Map of section titles to their parsed text content string */
  sections: Record<string, string>;
}

/**
 * Parses the final message from Codex to extract mandatory handoff sections and validate completeness.
 *
 * @param text - Complete final message string output by Codex
 * @returns Object indicating validation status, list of missing sections, and extracted section contents
 */
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
