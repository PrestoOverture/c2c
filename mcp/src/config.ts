import { CodexAppServer } from "./codex-client.ts";
import type { JobConfig } from "./jobs.ts";

/**
 * Summary of resolved Codex CLI configuration and runtime version information.
 */
export interface CodexConfigInfo {
  /** Model override name currently configured for Codex, or null if using default */
  model: string | null;
  /** Default reasoning effort setting for the configured model, or null if unset */
  default_effort: string | null;
  /** Version string or user agent reported by the Codex application server */
  version: string;
  /** Raw key-value dictionary containing the full resolved configuration object */
  config: Record<string, unknown>;
}

/**
 * Starts a temporary Codex process to fetch its active configuration settings and version number, then cleans up the process when finished.
 *
 * @param cfg - Configuration options containing the Codex executable path, CLI arguments, and working directory
 * @returns An object containing model information, default reasoning effort, version string, and raw configuration parameters
 */
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
