// Minimal JSON-RPC client for `codex app-server` (stdio transport, JSONL).
// Per the app-server docs, the `"jsonrpc":"2.0"` header is omitted on the wire.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export type Json = Record<string, unknown> | undefined;

/**
 * Represents an in-flight JSON-RPC request waiting for a response from the Codex server.
 */
interface Pending {
  /** Resolver function to resolve the pending Promise with the result value */
  resolve: (v: unknown) => void;
  /** Rejector function to reject the pending Promise with an error */
  reject: (e: Error) => void;
  /** Timeout handle for failing the request if no response arrives within deadline */
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Configuration options for initializing and managing a Codex app-server child process.
 */
export interface CodexAppServerOptions {
  /** Executable binary name or path for launching Codex */
  bin: string;
  /** Command line arguments passed when spawning the Codex child process */
  args: string[];
  /** Working directory path for the spawned Codex child process */
  cwd: string;
  /** Environment variable overrides for the spawned child process */
  env?: Record<string, string | undefined>;
  /** Callback triggered when a JSON-RPC notification is received from Codex */
  onNotification?: (method: string, params: Json) => void;
  /** Callback triggered when a stderr log line is output by Codex */
  onLog?: (line: string) => void;
  /** Callback triggered when the Codex child process is spawned, receiving its process ID */
  onSpawn?: (pid: number | undefined) => void;
  /** Callback triggered when the Codex child process exits or fails to spawn */
  onExit?: (code: number | null, error: Error) => void;
}

export class CodexAppServer {
  private proc: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private opts: CodexAppServerOptions;
  private stderrTail: string[] = [];
  private exitError?: Error;
  exited = false;

  /**
   * Spawns a new Codex child process and sets up event listeners for stdout and stderr streams.
   *
   * @param opts - Configuration options specifying executable path, arguments, environment, and event callbacks
   */
  constructor(opts: CodexAppServerOptions) {
    this.opts = opts;
    this.proc = spawn(opts.bin, opts.args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const rl = createInterface({ input: this.proc.stdout });
    rl.on("line", (line) => this.handleLine(line));
    const rlErr = createInterface({ input: this.proc.stderr });
    rlErr.on("line", (line) => {
      this.stderrTail.push(line);
      if (this.stderrTail.length > 50) this.stderrTail.shift();
      opts.onLog?.(line);
    });
    this.proc.on("spawn", () => opts.onSpawn?.(this.proc.pid));
    this.proc.on("exit", (code) => this.handleExit(code));
    this.proc.on("error", (err) => {
      this.handleExit(null, new Error(`failed to spawn ${opts.bin}: ${err.message}`));
    });
  }

  /**
   * Handles Codex child process termination or spawn failure, rejecting pending requests and notifying listeners.
   *
   * @param code - Exit code of the child process, or null if terminated abnormally
   * @param error - Error instance causing process exit, if any (optional)
   */
  private handleExit(code: number | null, error?: Error) {
    if (this.exited) return;
    this.exited = true;
    const stderr = this.stderrTail.slice(-10).join(" | ");
    this.exitError = error ?? new Error(
      `codex app-server exited (code ${code})${stderr ? `. stderr: ${stderr}` : ""}`,
    );
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(this.exitError);
    }
    this.pending.clear();
    this.opts.onExit?.(code, this.exitError);
  }

  /**
   * Parses a single output line received from Codex stdout and dispatches it as a request response or notification.
   *
   * @param line - Raw text line emitted by the child process stdout
   */
  private handleLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: any;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      this.opts.onLog?.(`unparseable line from codex: ${trimmed.slice(0, 200)}`);
      return;
    }
    if (msg.id !== undefined && msg.method === undefined) {
      // Response to one of our requests.
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        p.reject(new Error(`${msg.error.code ?? ""} ${msg.error.message ?? JSON.stringify(msg.error)}`.trim()));
      } else {
        p.resolve(msg.result);
      }
    } else if (msg.id !== undefined && msg.method !== undefined) {
      // Server-to-client request (e.g. an approval). We run with
      // approvalPolicy "never", so these are unexpected — decline explicitly
      // so the server is not left hanging.
      this.opts.onLog?.(`declining server request: ${msg.method}`);
      this.send({ id: msg.id, error: { code: -32601, message: `client does not handle ${msg.method}` } });
    } else if (msg.method !== undefined) {
      this.opts.onNotification?.(msg.method, msg.params);
    }
  }

  /**
   * Serializes an object to JSON and writes it to the child process's standard input stream.
   *
   * @param obj - Object to send to the child process
   */
  private send(obj: Record<string, unknown>) {
    if (this.exited) return;
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  /**
   * Sends a correlated JSON-RPC request to Codex and returns a Promise that resolves with the response or times out.
   *
   * @param method - RPC method name to invoke
   * @param params - Optional parameter object passed with the request
   * @param timeoutMs - Maximum time to wait for a response in milliseconds, defaulting to 60,000ms
   * @returns Promise resolving with the response result
   */
  request<T = any>(method: string, params?: Json, timeoutMs = 60_000): Promise<T> {
    if (this.exited) {
      return Promise.reject(this.exitError ?? new Error("codex app-server is not running"));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.send({ id, method, ...(params !== undefined ? { params } : {}) });
    });
  }

  /**
   * Sends a one-way notification message to Codex without waiting for a response.
   *
   * @param method - Notification method name
   * @param params - Optional parameter object passed with the notification
   */
  notify(method: string, params?: Json) {
    this.send({ method, ...(params !== undefined ? { params } : {}) });
  }

  /**
   * Sends the initial handshake request to Codex and emits the initialized notification upon response.
   *
   * @returns Promise resolving with the server initialization response payload
   */
  async initialize() {
    const result = await this.request("initialize", {
      clientInfo: { name: "claude2codex", title: "Claude↔Codex Contract Bridge", version: "0.3.3" },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", {});
    return result;
  }

  /**
   * Gracefully terminates the running Codex child process via SIGTERM signal.
   */
  kill() {
    if (!this.exited) this.proc.kill("SIGTERM");
  }
}
