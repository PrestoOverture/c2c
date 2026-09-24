import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CLAUDE_DOC, CODEX_DOC, renderClaudeDoc, renderCodexDoc } from "../scripts/gen-prompt-docs.ts";

// prompts/*.md are published for readers; they must match what c2c actually sends.
// On failure run `bun run gen:prompt-docs` in mcp/ and commit the result.

test("prompts/what-claude-sees.md matches the live server", async () => {
  expect(readFileSync(CLAUDE_DOC, "utf8")).toBe(await renderClaudeDoc());
});

test("prompts/what-codex-sees.md matches the contract renderers", () => {
  expect(readFileSync(CODEX_DOC, "utf8")).toBe(renderCodexDoc());
});
