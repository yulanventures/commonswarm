import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { channel } from "node:diagnostics_channel";
import { constants, lstatSync, rmdirSync } from "node:fs";
import { access, lstat, mkdir, rmdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { AGENT_CREDENTIAL_MESSAGE_D088 } from "./agent-credential-input.js";
import { AgentSetupError, agentProfileRoot, assertPrivateLocation, saveAgentProfile } from "./agent-profile.js";
import { ensureSecureStateDirectory } from "./storage.js";
import { ONBOARDING_UUID, type AgentConnectionEnvelope } from "./agent-onboarding-contract.js";
import { type CloudTarget } from "./config.js";
import { quoteAgentArgument } from "./agent-onboarding-contract.js";
import { ThinCommandClient } from "./command-client.js";
import { H0_REGISTRATION_NAME_MAX } from "../h0/verbs.js";
import { REGISTER_NO_SEAT_THIS_ATTEMPT, REGISTER_EXISTING_SEAT_REFUSALS } from "./mcp-register-refusals.js";

const JOIN_CODE = /^swm_join_[A-Za-z0-9_-]{43}$/;
const SEAT_TOKEN = /^swm_agt_[A-Za-z0-9_-]{43}$/;
export const MCP_REGISTER_TIMEOUT_MS = 10_000;
const OUTCOME_UNKNOWN = "The seat may have been created. Ask the operator to revoke it with cswarm principal revoke and issue a new code.";

export class McpConnectError extends AgentSetupError {
  constructor(code: string, message: string) { super(code, message); }
}

export async function mintMcpCode(target: CloudTarget, accessToken: string, workspaceId: string, fetcher: typeof fetch = fetch): Promise<{ code: string; expires_at: string }> {
  const result = await new ThinCommandClient(target, fetcher).sendConnect({
    credential: accessToken, workspaceId,
    command: { kind: "mint_agent_join_credential", seat_cap: 1, ttl_hours: 1 },
  });
  const body = result.response;
  if (body.status !== "accepted" || typeof body.join_credential !== "string" ||
      !JOIN_CODE.test(body.join_credential) || typeof body.expires_at !== "string" ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(body.expires_at) ||
      Number.isNaN(Date.parse(body.expires_at))) {
    throw new McpConnectError("mcp_code_mint_failed", "The code was not issued. Try again from your signed-in terminal.");
  }
  return { code: body.join_credential, expires_at: body.expires_at };
}

export function renderMcpCode(result: { code: string; expires_at: string }, target: CloudTarget): string {
  return `Connect code (shown once): ${result.code}\nExpires: ${result.expires_at}\nOn the agent host run: cswarm mcp connect --url ${target.url} --anon-key ${target.anonKey}\nGive the code to the person at the agent host.\n`;
}

function terminalEcho(on: boolean): void {
  const result = spawnSync("stty", [on ? "echo" : "-echo"], { stdio: ["inherit", "ignore", "ignore"], timeout: 2_000 });
  if (result.status !== 0) throw new McpConnectError("terminal_unavailable", "A terminal with hidden input is required.");
}

export interface HiddenTerminal {
  isTTY: boolean;
  input: NodeJS.ReadableStream;
  echo(on: boolean): void;
  write(value: string): void;
  signals: { on(signal: "SIGINT" | "SIGTERM", handler: () => void): unknown; off(signal: "SIGINT" | "SIGTERM", handler: () => void): unknown };
  exit(code: number): void;
}

/** A plain pipe or redirect is refused. A same-user pseudo-terminal wrapper is not detected. */
export async function readHiddenJoinCode(terminal: HiddenTerminal = {
  isTTY: Boolean(process.stdin.isTTY), input: process.stdin, echo: terminalEcho,
  write: value => process.stderr.write(value), signals: process, exit: code => process.exit(code),
}, cleanupOnSignal?: () => void): Promise<string> {
  if (!terminal.isTTY) throw new McpConnectError("terminal_required", "Run mcp connect in a terminal to enter the code privately. A plain pipe or redirect is refused; a pseudo-terminal wrapper is not detected.");
  terminal.echo(false);
  let restored = false;
  const restore = () => { if (!restored) { terminal.echo(true); restored = true; } };
  const removeSignals = () => {
    terminal.signals.off("SIGINT", onInterrupt);
    terminal.signals.off("SIGTERM", onTerminate);
  };
  const interrupted = (status: number) => {
    try { restore(); }
    finally {
      removeSignals();
      try { cleanupOnSignal?.(); } catch { /* Cleanup cannot replace the exit. */ }
      terminal.exit(status);
    }
  };
  function onInterrupt() { interrupted(130); }
  function onTerminate() { interrupted(143); }
  terminal.signals.on("SIGINT", onInterrupt);
  terminal.signals.on("SIGTERM", onTerminate);
  try {
    terminal.write("Connect code: ");
    const input = createInterface({ input: terminal.input, terminal: false });
    try {
      return await new Promise<string>((resolve, reject) => {
        let settled = false;
        input.once("line", line => { settled = true; line.trim() ? resolve(line) : reject(new McpConnectError("code_missing", "No code was entered. Run mcp connect again.")); });
        input.once("close", () => { if (!settled) reject(new McpConnectError("code_missing", "No code was entered. Run mcp connect again.")); });
      });
    } finally { input.close(); }
  } finally {
    removeSignals();
    restore();
    terminal.write("\n");
  }
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export interface McpConnectOptions {
  target: CloudTarget;
  profilePath?: string;
  name?: string;
  readCode?: () => Promise<string>;
  fetcher?: typeof fetch;
  saveProfile?: typeof saveAgentProfile;
  terminal?: HiddenTerminal;
  removeEmptyDirectory?: typeof rmdir;
}

export interface McpConnectResult { profile: string; principal_id: string; install: string }

/** Strategist ruling (2026-09-24): the printed lines name the profile path only; no id, code or token. */
export function renderMcpConnect(result: McpConnectResult): string {
  return `Profile: ${result.profile}\n${result.install}\n`;
}

export async function connectMcp(options: McpConnectOptions): Promise<McpConnectResult> {
  if (!options.readCode && !(options.terminal?.isTTY ?? process.stdin.isTTY)) throw new McpConnectError("terminal_required", "Run mcp connect in a terminal to enter the code privately. A plain pipe or redirect is refused; a pseudo-terminal wrapper is not detected.");
  const endpoint = new URL(options.target.url);
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname))) {
    throw new McpConnectError("connect_url_invalid", "Use an HTTPS deployment URL or a loopback test URL.");
  }
  const path = await assertPrivateLocation(options.profilePath ?? join(agentProfileRoot(), "agents", `mcp-${randomUUID()}`, "profile.json"));
  if (/swm_(?:join|agt)_/.test(path)) throw new McpConnectError("profile_path_invalid", "Use a profile path that contains no credential text.");
  if (basename(path).toLowerCase() === "credential.json" || path === join(dirname(path), "credential.json")) {
    throw new McpConnectError("profile_path_invalid", "The profile path cannot be credential.json.");
  }
  const profileDir = dirname(path);
  // mkdir's return value is undefined when the directory already existed.
  const createdDirectory = (await mkdir(profileDir, { recursive: true, mode: 0o700 })) !== undefined;
  const createdInfo = createdDirectory ? await lstat(profileDir) : null;
  const cleanupOnSignal = () => {
    if (!createdInfo) return;
    try {
      const current = lstatSync(profileDir);
      if (current.dev === createdInfo.dev && current.ino === createdInfo.ino) rmdirSync(profileDir);
    } catch { /* The registration error or signal exit must survive cleanup failure. */ }
  };
  try {
    await ensureSecureStateDirectory(profileDir);
    await access(dirname(path), constants.W_OK);
    // Refuse before prompting or registering. An existing credential without a profile is also occupied.
    if (await pathExists(path) || await pathExists(join(dirname(path), "credential.json"))) {
      throw new McpConnectError("profile_exists", "This profile path already holds a connection. Choose a new profile path.");
    }
    const name = options.name ?? "MCP agent";
    if (name.trim().length < 1 || name.length > H0_REGISTRATION_NAME_MAX) {
      throw new McpConnectError("connect_name_invalid", `Use a display name of 1 to ${H0_REGISTRATION_NAME_MAX} characters.`);
    }
    const code = (await (options.readCode ?? (() => readHiddenJoinCode(options.terminal, cleanupOnSignal)))()).trim();
    if (!code) throw new McpConnectError("code_missing", "No code was entered. Run mcp connect again.");
    if (!JOIN_CODE.test(code)) throw new McpConnectError("join_credential_invalid", "The connect code is invalid. Nothing was sent.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MCP_REGISTER_TIMEOUT_MS);
    let redirected = false;
    const headersChannel = channel("undici:request:headers");
    const onHeaders = (value: unknown) => {
      const event = value as { request?: { origin?: string; path?: string; method?: string }; response?: { statusCode?: number } };
      if (event.request?.origin === options.target.url && event.request.path === "/functions/v1/h0/register" &&
          event.request.method === "POST" && (event.response?.statusCode ?? 0) >= 300 && (event.response?.statusCode ?? 0) < 400) redirected = true;
    };
    headersChannel.subscribe(onHeaders);
    let response: Response;
    try {
      response = await (options.fetcher ?? fetch)(`${options.target.url}/functions/v1/h0/register`, {
        method: "POST", headers: { "content-type": "application/json", apikey: options.target.anonKey },
        body: JSON.stringify({ joinCredential: code, attemptId: randomUUID(), name }), signal: controller.signal, redirect: "error",
      });
    } catch {
      clearTimeout(timer);
      if (redirected) throw new McpConnectError("register_redirected", OUTCOME_UNKNOWN);
      throw new McpConnectError("register_outcome_unknown", OUTCOME_UNKNOWN);
    } finally { headersChannel.unsubscribe(onHeaders); }
    try {
      let body: Record<string, unknown> | null;
      try { body = record(await response.json()); }
      catch { body = null; }
      clearTimeout(timer);
      if (response.status >= 300 && response.status < 400) throw new McpConnectError("register_redirected", OUTCOME_UNKNOWN);
      if (!response.ok) {
        const errorCode = body?.error;
        if (typeof errorCode === "string" && (REGISTER_NO_SEAT_THIS_ATTEMPT[errorCode] === response.status || REGISTER_EXISTING_SEAT_REFUSALS[errorCode] === response.status)) {
          const message = errorCode === "upgrade_required" ? "Update cswarm and run mcp connect again; this attempt created no seat."
            : errorCode === "principal_limit_reached" ? "The workspace has no free agent seat; this attempt created no seat. Ask the operator."
            : errorCode === "not_found" || errorCode === "method_not_allowed" ? "Check --url; this attempt created no seat."
            : REGISTER_EXISTING_SEAT_REFUSALS[errorCode] === response.status ? "This code was already used. If you did not use it, someone else may have: tell the operator to revoke that agent and issue a new code."
            : errorCode === "forbidden" ? "This code is unknown, expired or revoked; this attempt created no seat. Ask the operator for a new code."
            : "The request was refused; this attempt created no seat. Ask the operator for a new code.";
          throw new McpConnectError(errorCode, message);
        }
        throw new McpConnectError("register_outcome_unknown", OUTCOME_UNKNOWN);
      }
      if (body?.status !== "accepted") throw new McpConnectError("register_outcome_unknown", OUTCOME_UNKNOWN);
      if (typeof body.workspace_id !== "string" || !ONBOARDING_UUID.test(body.workspace_id) ||
          typeof body.principal_id !== "string" || !ONBOARDING_UUID.test(body.principal_id) ||
          typeof body.run_id !== "string" || !ONBOARDING_UUID.test(body.run_id) ||
          typeof body.token_id !== "string" || !ONBOARDING_UUID.test(body.token_id) ||
          typeof body.agent_token !== "string" || !SEAT_TOKEN.test(body.agent_token) ||
          typeof body.expires_at !== "string" || Number.isNaN(Date.parse(body.expires_at))) {
        throw new McpConnectError("register_outcome_unknown", OUTCOME_UNKNOWN);
      }
      const connection: AgentConnectionEnvelope = {
        version: 1, url: options.target.url, anon_key: options.target.anonKey,
        workspace_id: body.workspace_id, principal_id: body.principal_id,
        credential: { message: AGENT_CREDENTIAL_MESSAGE_D088, status: "accepted", principal_id: body.principal_id,
          run_id: body.run_id, token_id: body.token_id, agent_token: body.agent_token, expires_at: body.expires_at },
      };
      // saveAgentProfile owns the 0700 directory and 0600 file writes. The profile is intentionally unbound.
      await (options.saveProfile ?? saveAgentProfile)(path, connection, undefined, undefined, true);
      const claude = `claude mcp add --scope user --transport stdio cswarm -- cswarm mcp --profile ${quoteAgentArgument(path)}`;
      const codex = `[mcp_servers.cswarm]\ncommand = "cswarm"\nargs = ["mcp", "--profile", ${JSON.stringify(path)}]`;
      return { profile: path, principal_id: body.principal_id, install: `${claude}\n${codex}` };
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof McpConnectError && error.code !== "register_outcome_unknown") throw error;
      throw new McpConnectError("register_outcome_unknown", OUTCOME_UNKNOWN);
    }
  } finally {
    if (createdInfo) {
      try {
        const current = await lstat(profileDir);
        if (current.dev === createdInfo.dev && current.ino === createdInfo.ino) await (options.removeEmptyDirectory ?? rmdir)(profileDir);
      } catch { /* Cleanup must never replace a refusal or revoke instruction. */ }
    }
  }
}
