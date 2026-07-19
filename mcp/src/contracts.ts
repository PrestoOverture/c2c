// Goal/Delta Contract rendering and handoff parsing.
// The contract formats mirror CLAUDE.md (author side) and AGENTS.md (Codex side).

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

export function renderGoalContract(c: GoalContract): string {
  const lines = [
    "You are receiving a Goal Contract. Follow AGENTS.md: implement exactly what the contract specifies, self-verify, and end with the structured handoff.",
    "",
    "### Goal",
    c.goal.trim(),
    "",
    "### Constraints",
    ...c.constraints.map((x) => `- ${x}`),
    "",
    "### Success Conditions",
    ...c.success_conditions.map((x) => `- [ ] ${x}`),
    "",
    "End your work with the structured handoff (### Changed Files / ### Validation / ### Success Conditions / ### Risks & Deviations).",
  ];
  return lines.join("\n");
}

export function renderDeltaContract(d: DeltaContract): string {
  const lines = [
    "You are receiving a Delta Contract for rework. Fix only what it lists; do not touch work that passed review. AGENTS.md self-verification and handoff rules apply.",
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
