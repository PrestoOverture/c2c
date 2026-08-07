export type LogLevel = "error" | "info" | "debug";

const priorities = { error: 1, info: 2, debug: 3 } as const;

/**
 * Reads the current active log level for the system from environment variables.
 *
 * @returns The active log level string, defaulting to "info" if unspecified
 */
function configuredLevel(): "silent" | LogLevel {
  const value = process.env.C2C_LOG_LEVEL;
  return value === "silent" || value === "error" || value === "info" || value === "debug"
    ? value
    : "info";
}

/**
 * Writes a structured, formatted JSON log message to the standard error stream.
 *
 * @param level - Severity level of the log entry
 * @param event - Name of the event being logged
 * @param fields - Additional key-value pairs providing context details, defaulting to an empty object
 */
export function writeLog(level: LogLevel, event: string, fields: Record<string, unknown> = {}) {
  const configured = configuredLevel();
  if (configured === "silent" || priorities[level] > priorities[configured]) return;
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields })}\n`);
}
