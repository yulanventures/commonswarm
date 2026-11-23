import { spawn, type ChildProcessByStdio } from "node:child_process";
import { isAbsolute } from "node:path";
import type { Readable, Writable } from "node:stream";

const ACP_PROTOCOL_VERSION = 1;
const JSONRPC_METHOD_NOT_FOUND = -32601;

export const MAX_LINE_BYTES = 1024 * 1024;
export const MAX_REPLY_BYTES = 256 * 1024;
export const MAX_STDERR_BYTES = 2 * 1024;

export type AcpStopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";
export type AcpErrorCode =
  | "spawn_failed" | "handshake_timeout" | "turn_budget_exceeded" | "interrupted"
  | "child_exited" | "stop_reason" | "permission_denied_abort"
  | "line_too_large" | "reply_too_large" | "protocol_error" | "rpc_error" | "closed" | "busy";

export class AcpError extends Error {
  readonly code: AcpErrorCode;
  readonly stopReason?: AcpStopReason;
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;

  constructor(
    code: AcpErrorCode,
    message: string,
    detail?: { readonly stopReason?: AcpStopReason; readonly exitCode?: number | null; readonly signal?: NodeJS.Signals | null },
  ) {
    super(message);
    this.name = "AcpError";
    this.code = code;
    this.stopReason = detail?.stopReason;
    this.exitCode = detail?.exitCode;
    this.signal = detail?.signal;
  }
}

export interface AcpClientOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly handshakeTimeoutMs: number;
  readonly turnBudgetMs: number;
  readonly killGraceMs: number;
  readonly clientName?: string;
  readonly clientVersion?: string;
  readonly onSpawned?: (pid: number) => void | Promise<void>;
}

type JsonRpcId = string | number;
type ChildStdio = ChildProcessByStdio<Writable, Readable, Readable>;
interface PendingRequest { readonly id: number; readonly resolve: (result: unknown) => void; readonly reject: (err: Error) => void; }
interface ActiveTurn {
  readonly requestId: number;
  readonly chunks: string[];
  replyBytes: number;
  readonly timer: ReturnType<typeof setTimeout>;
  cancelError: AcpError | null;
  cancelTimer: ReturnType<typeof setTimeout> | null;
  readonly resolve: (text: string) => void;
  readonly reject: (err: Error) => void;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const hasOwn = (obj: object, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key);
const asStopReason = (v: unknown): AcpStopReason | null =>
  v === "end_turn" || v === "max_tokens" || v === "max_turn_requests" || v === "refusal" || v === "cancelled" ? v : null;

function assertPositiveMs(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be a positive finite number`);
}

function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code !== "ESRCH") {
      try { process.kill(pid, signal); } catch { /* already gone */ }
    }
  }
}

function isProcessGroupAlive(pid: number): boolean {
  try { process.kill(-pid, 0); return true; } catch (err) {
    return (err as NodeJS.ErrnoException | null)?.code === "EPERM";
  }
}

function selectRejectOptionId(params: unknown, expectedSessionId: string | null): string | null {
  if (!isRecord(params) || expectedSessionId === null) return null;
  if (typeof params.sessionId !== "string" || params.sessionId !== expectedSessionId) return null;
  if (!Array.isArray(params.options)) return null;

  const idCounts = new Map<string, number>();
  for (const item of params.options) {
    if (!isRecord(item) || typeof item.optionId !== "string" || !item.optionId || typeof item.kind !== "string") return null;
    idCounts.set(item.optionId, (idCounts.get(item.optionId) ?? 0) + 1);
  }

  let rejectAlwaysId: string | null = null;
  for (const item of params.options as readonly Record<string, unknown>[]) {
    const optionId = item.optionId as string;
    if (idCounts.get(optionId) !== 1) continue;
    if (item.kind === "reject_once") return optionId;
    if (item.kind === "reject_always" && rejectAlwaysId === null) rejectAlwaysId = optionId;
  }
  return rejectAlwaysId;
}

export class AcpClient {
  private readonly child: ChildStdio;
  private readonly turnBudgetMs: number;
  private readonly killGraceMs: number;
  private readonly exitPromise: Promise<void>;

  private sessionId: string | null = null;
  private nextId = 1;
  private pending: PendingRequest | null = null;
  private activeTurn: ActiveTurn | null = null;
  private lineChunks: Buffer[] = [];
  private lineBytes = 0;
  private stderrTail: Buffer = Buffer.alloc(0);
  private exited = false;
  private closed = false;
  private closePromise: Promise<void> | null = null;

  private constructor(child: ChildStdio, options: AcpClientOptions) {
    this.child = child;
    this.turnBudgetMs = options.turnBudgetMs;
    this.killGraceMs = options.killGraceMs;

    this.child.stdin.on("error", () => {});
    this.child.stdout.on("error", () => {});
    this.child.stderr.on("error", () => {});
    this.child.stderr.on("data", (chunk: Buffer) => this.appendStderr(chunk));
    this.child.stdout.on("data", (chunk: Buffer) => this.onStdoutData(chunk));

    this.exitPromise = new Promise<void>((resolve) => {
      let settled = false;
      const done = (err: AcpError) => {
        if (settled) return;
        settled = true;
        this.exited = true;
        const cancelError = this.activeTurn?.cancelError ?? null;
        this.takeInFlight()?.(cancelError ?? err);
        resolve();
      };
      this.child.once("error", () => done(new AcpError("spawn_failed", "ACP child failed to start")));
      this.child.once("exit", (code, signal) => {
        const msg = code !== null ? `ACP child exited with code ${code}` : "ACP child exited";
        done(new AcpError("child_exited", msg, { exitCode: code, signal }));
      });
    });
  }

  static async open(options: AcpClientOptions): Promise<AcpClient> {
    if (!options.executable || !isAbsolute(options.executable)) throw new RangeError("Executable path must be absolute");
    if (!options.cwd || !isAbsolute(options.cwd)) throw new RangeError("Working directory must be absolute");
    assertPositiveMs(options.handshakeTimeoutMs, "handshakeTimeoutMs");
    assertPositiveMs(options.turnBudgetMs, "turnBudgetMs");
    assertPositiveMs(options.killGraceMs, "killGraceMs");

    const child = spawn(options.executable, [...options.args], {
      cwd: options.cwd,
      env: { ...options.env },
      shell: false,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const client = new AcpClient(child, options);
    try {
      if (options.onSpawned !== undefined) {
        if (child.pid === undefined) {
          throw new AcpError("spawn_failed", "ACP child failed to start");
        }
        await options.onSpawned(child.pid);
      }
      await client.handshake(options);
      return client;
    } catch (err) {
      await client.close();
      throw err;
    }
  }

  get currentSessionId(): string | null { return this.sessionId; }
  get isClosed(): boolean { return this.closed; }
  get isExited(): boolean { return this.exited; }
  getStderrTail(): string { return this.stderrTail.toString("utf8"); }

  async prompt(text: string): Promise<string> {
    if (this.closed || this.exited || this.sessionId === null) throw new AcpError("closed", "ACP session is closed");
    if (this.activeTurn !== null || this.pending !== null) throw new AcpError("busy", "ACP turn already in progress");

    const id = this.nextId++;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const current = this.activeTurn;
        if (current?.requestId !== id || current.cancelError !== null) return;
        this.cancelActiveTurn(current, new AcpError("turn_budget_exceeded", "ACP turn budget exceeded"));
      }, this.turnBudgetMs);

      const turn: ActiveTurn = {
        requestId: id,
        chunks: [],
        replyBytes: 0,
        timer,
        cancelError: null,
        cancelTimer: null,
        resolve,
        reject,
      };
      this.activeTurn = turn;
      this.pending = {
        id,
        resolve: (result) => {
          if (this.activeTurn !== turn) return;
          const cancelError = turn.cancelError;
          this.clearActiveTurn();
          const stopReason = isRecord(result) ? asStopReason(result.stopReason) : null;
          if (cancelError !== null) {
            if (stopReason === null) void this.close().then(() => turn.reject(cancelError));
            else turn.reject(cancelError);
            return;
          }
          if (stopReason === null) turn.reject(new AcpError("protocol_error", "ACP protocol error"));
          else if (stopReason !== "end_turn") turn.reject(new AcpError("stop_reason", `ACP turn stopped: ${stopReason}`, { stopReason }));
          else turn.resolve(turn.chunks.join(""));
        },
        reject: (err) => {
          if (this.activeTurn !== turn) return;
          const cancelError = turn.cancelError;
          this.clearActiveTurn();
          turn.reject(cancelError ?? err);
        },
      };

      if (!this.writeJson({ jsonrpc: "2.0", id, method: "session/prompt", params: { sessionId: this.sessionId, prompt: [{ type: "text", text }] } })) {
        this.takeInFlight();
        reject(new AcpError("closed", "ACP session is closed"));
      }
    });
  }

  interrupt(): void {
    if (this.closed || this.exited) return;
    const turn = this.activeTurn;
    if (turn === null || turn.cancelError !== null) return;
    this.cancelActiveTurn(turn, new AcpError("interrupted", "ACP turn interrupted"));
  }

  close(): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    this.closed = true;
    const cancelError = this.activeTurn?.cancelError ?? null;
    this.takeInFlight()?.(cancelError ?? new AcpError("closed", "ACP session is closed"));

    this.closePromise = (async () => {
      try { this.child.stdin.end(); } catch { /* already closed */ }
      const pid = this.child.pid;
      if (pid !== undefined && (!this.exited || isProcessGroupAlive(pid))) {
        killProcessGroup(pid, "SIGTERM");
        const graceTimer = setTimeout(() => {
          killProcessGroup(pid, "SIGKILL");
          this.destroyStdio();
        }, this.killGraceMs);
        try { await this.exitPromise; } finally { clearTimeout(graceTimer); }
        if (isProcessGroupAlive(pid)) killProcessGroup(pid, "SIGKILL");
      } else {
        await this.exitPromise;
      }
      this.destroyStdio();
    })();
    return this.closePromise;
  }

  private async handshake(options: AcpClientOptions): Promise<void> {
    let timedOut = false;
    const handshakeTimer = setTimeout(() => {
      timedOut = true;
      this.takeInFlight()?.(new AcpError("handshake_timeout", "ACP handshake timed out"));
    }, options.handshakeTimeoutMs);

    try {
      const initResult = await this.sendRequest("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: options.clientName ?? "cswarm-engine", version: options.clientVersion ?? "0.0.0" },
      });
      if (!isRecord(initResult) || initResult.protocolVersion !== ACP_PROTOCOL_VERSION) {
        throw new AcpError("protocol_error", "ACP protocol error");
      }
      const sessionResult = await this.sendRequest("session/new", { cwd: options.cwd, mcpServers: [] });
      if (!isRecord(sessionResult) || typeof sessionResult.sessionId !== "string" || !sessionResult.sessionId) {
        throw new AcpError("protocol_error", "ACP protocol error");
      }
      this.sessionId = sessionResult.sessionId;
    } catch (err) {
      if (timedOut) throw new AcpError("handshake_timeout", "ACP handshake timed out");
      throw err;
    } finally {
      clearTimeout(handshakeTimer);
    }
  }

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    if (this.closed || this.exited) return Promise.reject(new AcpError("closed", "ACP session is closed"));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending = { id, resolve, reject };
      if (!this.writeJson({ jsonrpc: "2.0", id, method, params })) {
        this.pending = null;
        reject(new AcpError("closed", "ACP session is closed"));
      }
    });
  }

  private cancelActiveTurn(turn: ActiveTurn, err: AcpError): void {
    clearTimeout(turn.timer);
    turn.cancelError = err;
    if (!this.sendCancel()) {
      void this.failAndClose(err);
      return;
    }
    turn.cancelTimer = setTimeout(() => {
      if (this.activeTurn !== turn) return;
      void this.failAndClose(err);
    }, this.killGraceMs);
  }

  private sendCancel(): boolean {
    if (this.sessionId !== null && !this.exited) {
      return this.writeJson({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.sessionId } });
    }
    return false;
  }

  private writeJson(frame: Record<string, unknown>): boolean {
    try { this.child.stdin.write(`${JSON.stringify(frame)}\n`); return true; } catch { return false; }
  }

  private appendStderr(chunk: Buffer): void {
    if (chunk.length === 0) return;
    if (chunk.length >= MAX_STDERR_BYTES) {
      this.stderrTail = Buffer.from(chunk.subarray(chunk.length - MAX_STDERR_BYTES));
      return;
    }
    const combined = Buffer.concat([this.stderrTail, chunk]);
    this.stderrTail = combined.length > MAX_STDERR_BYTES
      ? Buffer.from(combined.subarray(combined.length - MAX_STDERR_BYTES))
      : combined;
  }

  private onStdoutData(chunk: Buffer): void {
    if (this.closed) return;
    let offset = 0;
    while (offset < chunk.length) {
      const nl = chunk.indexOf(0x0a, offset);
      if (nl === -1) {
        const rest = chunk.subarray(offset);
        if (this.lineBytes + rest.length > MAX_LINE_BYTES) {
          this.lineChunks = [];
          this.lineBytes = 0;
          void this.failAndClose(new AcpError("line_too_large", "ACP line exceeded size limit"));
          return;
        }
        this.lineChunks.push(rest);
        this.lineBytes += rest.length;
        return;
      }
      const part = chunk.subarray(offset, nl);
      offset = nl + 1;
      let total = this.lineBytes + part.length;
      const combined = this.lineChunks.length === 0 ? part : Buffer.concat([...this.lineChunks, part]);
      this.lineChunks = [];
      this.lineBytes = 0;
      if (total > 0 && combined[total - 1] === 0x0d) total -= 1;
      if (total > MAX_LINE_BYTES) {
        void this.failAndClose(new AcpError("line_too_large", "ACP line exceeded size limit"));
        return;
      }
      if (total > 0) this.handleLine(combined.subarray(0, total).toString("utf8"));
      if (this.closed) return;
    }
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { this.protocolError(); return; }
    if (!isRecord(parsed) || parsed.jsonrpc !== "2.0") { this.protocolError(); return; }

    const hasId = hasOwn(parsed, "id") && parsed.id !== undefined;
    const hasMethod = hasOwn(parsed, "method");

    if (hasId && !hasMethod) {
      const hasResult = hasOwn(parsed, "result");
      const hasError = hasOwn(parsed, "error");
      if (hasResult === hasError) { this.protocolError(); return; }
      const pending = this.pending;
      if (pending === null || parsed.id !== pending.id) return;
      this.pending = null;
      if (hasError) pending.reject(new AcpError("rpc_error", "ACP child returned RPC error"));
      else pending.resolve(parsed.result);
      return;
    }

    if (typeof parsed.method === "string" && hasId) {
      if (typeof parsed.id !== "string" && typeof parsed.id !== "number") { this.protocolError(); return; }
      this.handleChildRequest(parsed.id, parsed.method, parsed.params);
      return;
    }

    if (typeof parsed.method === "string") {
      if (parsed.method === "session/update") this.handleSessionUpdate(parsed.params);
      return;
    }
    this.protocolError();
  }

  private handleChildRequest(id: JsonRpcId, method: string, params: unknown): void {
    if (method === "session/request_permission") {
      const rejectId = selectRejectOptionId(params, this.sessionId);
      if (rejectId !== null) {
        this.writeJson({ jsonrpc: "2.0", id, result: { outcome: { outcome: "selected", optionId: rejectId } } });
        return;
      }
      this.writeJson({ jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } });
      if (this.activeTurn?.cancelError == null) {
        this.sendCancel();
        if (this.activeTurn !== null) {
          this.takeInFlight()?.(new AcpError("permission_denied_abort", "ACP permission request aborted turn"));
        }
      }
      return;
    }
    this.writeJson({ jsonrpc: "2.0", id, error: { code: JSONRPC_METHOD_NOT_FOUND, message: "Method not found" } });
  }

  private handleSessionUpdate(params: unknown): void {
    const turn = this.activeTurn;
    if (turn === null || turn.cancelError !== null || this.sessionId === null || !isRecord(params)) return;
    if (typeof params.sessionId !== "string" || params.sessionId !== this.sessionId) return;
    if (!isRecord(params.update) || params.update.sessionUpdate !== "agent_message_chunk") return;
    const content = params.update.content;
    if (!isRecord(content) || content.type !== "text" || typeof content.text !== "string") return;

    const bytes = Buffer.byteLength(content.text, "utf8");
    if (turn.replyBytes + bytes > MAX_REPLY_BYTES) {
      void this.failAndClose(new AcpError("reply_too_large", "ACP reply exceeded size limit"));
      return;
    }
    turn.replyBytes += bytes;
    turn.chunks.push(content.text);
  }

  private protocolError(): void {
    void this.failAndClose(new AcpError("protocol_error", "ACP protocol error"));
  }

  private clearActiveTurn(): void {
    if (this.activeTurn !== null) {
      clearTimeout(this.activeTurn.timer);
      if (this.activeTurn.cancelTimer !== null) clearTimeout(this.activeTurn.cancelTimer);
      this.activeTurn = null;
    }
  }

  private takeInFlight(): ((err: AcpError) => void) | null {
    const turn = this.activeTurn;
    const pending = this.pending;
    this.clearActiveTurn();
    this.pending = null;
    if (turn !== null) return turn.reject;
    if (pending !== null) return pending.reject;
    return null;
  }

  private async failAndClose(err: AcpError): Promise<void> {
    const reject = this.takeInFlight();
    await this.close();
    reject?.(err);
  }

  private destroyStdio(): void {
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
  }
}
