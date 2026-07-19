// Minimal JSON-RPC client for `codex app-server` (stdio transport, JSONL).
// Per the app-server docs, the `"jsonrpc":"2.0"` header is omitted on the wire.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export type Json = Record<string, unknown> | undefined;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface CodexAppServerOptions {
  bin: string;
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  onNotification?: (method: string, params: Json) => void;
  onLog?: (line: string) => void;
  onSpawn?: (pid: number | undefined) => void;
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

  private send(obj: Record<string, unknown>) {
    if (this.exited) return;
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }

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

  notify(method: string, params?: Json) {
    this.send({ method, ...(params !== undefined ? { params } : {}) });
  }

  async initialize() {
    const result = await this.request("initialize", {
      clientInfo: { name: "claude2codex", title: "Claude↔Codex Contract Bridge", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", {});
    return result;
  }

  kill() {
    if (!this.exited) this.proc.kill("SIGTERM");
  }
}
