import { AcpClient, AcpError } from "./acp.js";
import {
  prepareLaunch,
  type LaunchDescription,
  type PrepareLaunchOptions,
  type PreparedLaunch,
} from "./launch.js";
import type { HarnessPort } from "./ports.js";

export interface AcpHarnessOptions {
  readonly launch: LaunchDescription;
  readonly launchOptions?: PrepareLaunchOptions;
  readonly handshakeTimeoutMs: number;
  readonly turnBudgetMs: number;
  readonly killGraceMs: number;
  readonly clientName?: string;
  readonly clientVersion?: string;
}

function assertPositiveMs(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive finite number`);
  }
}

export class AcpHarness implements HarnessPort {
  private readonly options: AcpHarnessOptions;
  private prepared: PreparedLaunch | null = null;
  private session: AcpClient | null = null;
  private opening: Promise<AcpClient> | null = null;
  private turnInFlight = false;
  private closed = false;
  private lastStderrTail = "";

  constructor(options: AcpHarnessOptions) {
    assertPositiveMs(options.handshakeTimeoutMs, "handshakeTimeoutMs");
    assertPositiveMs(options.turnBudgetMs, "turnBudgetMs");
    assertPositiveMs(options.killGraceMs, "killGraceMs");
    this.options = options;
  }

  get resolvedExecutable(): string | null {
    return this.prepared?.executable ?? null;
  }

  getStderrTail(): string {
    return this.session !== null ? this.session.getStderrTail() : this.lastStderrTail;
  }

  async runTurn(text: string): Promise<string> {
    if (this.closed) {
      throw new AcpError("closed", "ACP harness is closed");
    }
    if (this.turnInFlight) {
      throw new AcpError("busy", "ACP turn already in progress");
    }

    this.turnInFlight = true;
    try {
      const client = await this.ensureSession();
      return await client.prompt(text);
    } catch (err) {
      const keepSession =
        !this.closed &&
        err instanceof AcpError &&
        (err.code === "interrupted" || err.code === "turn_budget_exceeded") &&
        this.session !== null &&
        !this.session.isClosed &&
        !this.session.isExited;
      if (!keepSession) {
        await this.resetSession();
      }
      throw err;
    } finally {
      this.turnInFlight = false;
    }
  }

  interrupt(): void {
    this.session?.interrupt();
  }

  async close(): Promise<void> {
    this.closed = true;
    const inflightOpen = this.opening;
    if (inflightOpen !== null) {
      const opened = await inflightOpen.catch(() => null);
      if (opened !== null && opened !== this.session) {
        this.lastStderrTail = opened.getStderrTail();
        await opened.close().catch(() => {});
      }
    }
    await this.resetSession();
  }

  private async ensureSession(): Promise<AcpClient> {
    if (this.session !== null && !this.session.isClosed && !this.session.isExited) {
      return this.session;
    }
    if (this.session !== null) {
      await this.resetSession();
    }
    if (this.prepared === null) {
      this.prepared = await prepareLaunch(this.options.launch, this.options.launchOptions);
    }
    if (this.closed) {
      throw new AcpError("closed", "ACP harness is closed");
    }

    const openPromise = AcpClient.open({
      executable: this.prepared.executable,
      args: this.prepared.args,
      cwd: this.prepared.cwd,
      env: this.prepared.env,
      handshakeTimeoutMs: this.options.handshakeTimeoutMs,
      turnBudgetMs: this.options.turnBudgetMs,
      killGraceMs: this.options.killGraceMs,
      clientName: this.options.clientName,
      clientVersion: this.options.clientVersion,
    });
    this.opening = openPromise;
    try {
      const client = await openPromise;
      if (this.closed) {
        this.lastStderrTail = client.getStderrTail();
        await client.close().catch(() => {});
        throw new AcpError("closed", "ACP harness is closed");
      }
      this.session = client;
      return client;
    } finally {
      if (this.opening === openPromise) {
        this.opening = null;
      }
    }
  }

  private async resetSession(): Promise<void> {
    const current = this.session;
    this.session = null;
    if (current !== null) {
      this.lastStderrTail = current.getStderrTail();
      await current.close().catch(() => {});
    }
  }
}
