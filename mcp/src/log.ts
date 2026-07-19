export type LogLevel = "error" | "info" | "debug";

const priorities = { error: 1, info: 2, debug: 3 } as const;

function configuredLevel(): "silent" | LogLevel {
  const value = process.env.C2C_LOG_LEVEL;
  return value === "silent" || value === "error" || value === "info" || value === "debug"
    ? value
    : "info";
}

export function writeLog(level: LogLevel, event: string, fields: Record<string, unknown> = {}) {
  const configured = configuredLevel();
  if (configured === "silent" || priorities[level] > priorities[configured]) return;
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields })}\n`);
}
