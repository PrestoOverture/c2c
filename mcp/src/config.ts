import { CodexAppServer } from "./codex-client.ts";
import type { JobConfig } from "./jobs.ts";

export interface CodexConfigInfo {
  model: string | null;
  default_effort: string | null;
  version: string;
  config: Record<string, unknown>;
}

export async function readCodexConfig(cfg: JobConfig): Promise<CodexConfigInfo> {
  const client = new CodexAppServer({ bin: cfg.bin, args: cfg.args, cwd: cfg.cwd });
  try {
    const initialized: any = await client.initialize();
    const result: any = await client.request("config/read", {}, 15_000);
    const current = result?.config ?? result ?? {};
    return {
      model: current.model ?? cfg.model ?? null,
      default_effort: current.model_reasoning_effort ?? current.reasoning_effort ?? null,
      version: initialized?.userAgent ?? initialized?.user_agent ?? "unknown",
      config: current,
    };
  } finally {
    client.kill();
  }
}
