/**
 * A long-lived Deno child that answers line-delimited JSON requests, so a test file pays the
 * edge-module load once instead of once per call.
 *
 * Wire: the parent writes `{"id":N,"input":{...}}\n` to stdin. The child writes
 * `<resultPrefix><id>:{"ok":true,"result":...}` (or `{"ok":false,"error":"..."}`) to stdout, then
 * `<donePrefix><id>` to stderr. The parent settles a request only once both lines arrived, so
 * every stderr line the child wrote while handling it is in that request's `stderr`. Stderr and
 * other stdout lines are attributed to every request pending on that child when they arrive;
 * with one request at a time that is exactly that request's output.
 *
 * The child starts on the first request. When it exits or a request times out, every request
 * pending on it rejects with its output, and the next request starts a new child.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface DenoLineHarnessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  resultPrefix: string;
  donePrefix: string;
}

export interface DenoLineReply<T> {
  result: T;
  stderr: string;
  stdout: string;
}

interface Pending {
  id: number;
  stdout: string[];
  stderr: string[];
  reply: { ok: true; result: unknown } | { ok: false; error: string } | null;
  done: boolean;
  timer: NodeJS.Timeout;
  resolve: (reply: DenoLineReply<unknown>) => void;
  reject: (error: Error) => void;
}

interface Worker {
  process: ChildProcessWithoutNullStreams;
  pending: Map<number, Pending>;
  exited: Promise<void>;
}

function lineSplitter(onLine: (line: string) => void): (chunk: string) => void {
  let buffered = "";
  return (chunk) => {
    buffered += chunk;
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      onLine(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf("\n");
    }
  };
}

function settle(worker: Worker, pending: Pending): void {
  if (pending.reply === null || !pending.done) return;
  worker.pending.delete(pending.id);
  clearTimeout(pending.timer);
  const stderr = pending.stderr.map((line) => `${line}\n`).join("");
  const stdout = pending.stdout.map((line) => `${line}\n`).join("");
  if (pending.reply.ok) pending.resolve({ result: pending.reply.result, stderr, stdout });
  else pending.reject(new Error(`deno harness request failed: ${pending.reply.error}\n${stderr}\n${stdout}`));
}

function fail(worker: Worker, pending: Pending, reason: string): void {
  if (!worker.pending.delete(pending.id)) return;
  clearTimeout(pending.timer);
  pending.reject(new Error(`deno harness request ${pending.id} ${reason}\n${
    pending.stderr.join("\n")}\n${pending.stdout.join("\n")}`));
}

export class DenoLineHarness {
  #worker: Worker | null = null;
  #nextId = 1;
  readonly args: readonly string[];
  readonly options: DenoLineHarnessOptions;

  constructor(args: readonly string[], options: DenoLineHarnessOptions) {
    this.args = args;
    this.options = options;
  }

  async request<T>(input: Record<string, unknown>): Promise<DenoLineReply<T>> {
    const worker = this.#worker ?? this.#start();
    const id = this.#nextId++;
    return await new Promise<DenoLineReply<T>>((resolve, reject) => {
      const pending: Pending = {
        id, stdout: [], stderr: [], reply: null, done: false,
        timer: setTimeout(() => {
          fail(worker, pending, `timed out after ${this.options.timeoutMs} ms`);
          // Its state is unknown now; the next request gets a new child.
          this.#kill(worker);
        }, this.options.timeoutMs),
        resolve: resolve as (reply: DenoLineReply<unknown>) => void,
        reject,
      };
      worker.pending.set(id, pending);
      worker.process.stdin.write(`${JSON.stringify({ id, input })}\n`);
    });
  }

  /** Ends the child's stdin so it drains and closes its pools; kills it if it lingers. */
  async close(graceMs = 5_000): Promise<void> {
    const worker = this.#worker;
    if (worker === null) return;
    this.#worker = null;
    worker.process.stdin.end();
    let timer: NodeJS.Timeout | undefined;
    const lingered = await Promise.race([
      worker.exited.then(() => false),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), graceMs); }),
    ]);
    clearTimeout(timer);
    if (lingered) {
      this.#kill(worker);
      await worker.exited;
    }
  }

  #start(): Worker {
    const child = spawn("deno", this.args, {
      cwd: this.options.cwd, env: this.options.env, stdio: ["pipe", "pipe", "pipe"],
    });
    const pending = new Map<number, Pending>();
    const failAll = (reason: string) => {
      for (const entry of [...pending.values()]) fail(worker, entry, reason);
    };
    const worker: Worker = {
      process: child,
      pending,
      exited: new Promise((resolve) => {
        child.on("close", (code, signal) => {
          if (this.#worker === worker) this.#worker = null;
          failAll(`deno exited (code ${code}, signal ${signal}) before answering`);
          resolve();
        });
        child.on("error", (error) => {
          if (this.#worker === worker) this.#worker = null;
          failAll(`deno failed: ${error.message}`);
          resolve();
        });
      }),
    };
    this.#worker = worker;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    // A child that died mid-write must not crash the test process with EPIPE; exit reports it.
    child.stdin.on("error", () => {});
    child.stdout.on("data", lineSplitter((line) => this.#onStdout(worker, line)));
    child.stderr.on("data", lineSplitter((line) => this.#onStderr(worker, line)));
    return worker;
  }

  #kill(worker: Worker): void {
    if (this.#worker === worker) this.#worker = null;
    const child = worker.process;
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }

  #onStdout(worker: Worker, line: string): void {
    if (line.startsWith(this.options.resultPrefix)) {
      const rest = line.slice(this.options.resultPrefix.length);
      const colon = rest.indexOf(":");
      const pending = worker.pending.get(Number(rest.slice(0, colon)));
      if (colon > 0 && pending !== undefined) {
        pending.reply = JSON.parse(rest.slice(colon + 1)) as Pending["reply"];
        settle(worker, pending);
        return;
      }
    }
    for (const pending of worker.pending.values()) pending.stdout.push(line);
  }

  #onStderr(worker: Worker, line: string): void {
    if (line.startsWith(this.options.donePrefix)) {
      const pending = worker.pending.get(Number(line.slice(this.options.donePrefix.length)));
      if (pending !== undefined) {
        pending.done = true;
        settle(worker, pending);
        return;
      }
    }
    for (const pending of worker.pending.values()) pending.stderr.push(line);
  }
}
