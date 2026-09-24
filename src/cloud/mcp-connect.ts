import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { AGENT_CREDENTIAL_MESSAGE_D088 } from "./agent-credential-input.js";
import { AgentSetupError, assertPrivateLocation, saveAgentProfile } from "./agent-profile.js";
import { ONBOARDING_UUID, type AgentConnectionEnvelope } from "./agent-onboarding-contract.js";
import { type CloudTarget } from "./config.js";
import { quoteAgentArgument } from "./agent-onboarding-contract.js";
import { ThinCommandClient } from "./command-client.js";
import { H0_REGISTRATION_NAME_MAX } from "../h0/verbs.js";

const JOIN_CODE = /^swm_join_[A-Za-z0-9_-]{43}$/;
const SEAT_TOKEN = /^swm_agt_[A-Za-z0-9_-]{43}$/;
const RETRY_SENTENCE = "Ask the operator for a new code.";
const CODE_REFUSALS = new Set([
  "join_credential_not_found", "join_credential_expired", "join_credential_revoked",
  "join_credential_seat_cap_reached", "join_credential_invalid",
  "forbidden",
]);

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

function terminalEcho(on: boolean): void {
  const result = spawnSync("stty", [on ? "echo" : "-echo"], { stdio: ["inherit", "ignore", "ignore"], timeout: 2_000 });
  if (result.status !== 0) throw new McpConnectError("terminal_unavailable", "A terminal with hidden input is required.");
}

/** The only production source of the code is the controlling TTY, with echo disabled. */
export async function readHiddenJoinCode(): Promise<string> {
  if (!process.stdin.isTTY) throw new McpConnectError("terminal_required", "Run mcp connect in a terminal to enter the code privately.");
  process.stderr.write("Connect code: ");
  terminalEcho(false);
  try {
    const input = createInterface({ input: process.stdin, terminal: false });
    try { return await input.question(""); }
    finally { input.close(); }
  } finally {
    terminalEcho(true);
    process.stderr.write("\n");
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
}

export interface McpConnectResult { profile: string; principal_id: string; install: string }

/** Strategist ruling (2026-09-24): the printed lines name the profile path only; no id, code or token. */
export function renderMcpConnect(result: McpConnectResult): string {
  return `Profile: ${result.profile}\n${result.install}\n`;
}

export async function connectMcp(options: McpConnectOptions): Promise<McpConnectResult> {
  const path = await assertPrivateLocation(options.profilePath ?? join(homedir(), ".cswarm", "agents", `mcp-${randomUUID()}`, "profile.json"));
  if (/swm_(?:join|agt)_/.test(path)) throw new McpConnectError("profile_path_invalid", "Use a profile path that contains no credential text.");
  // Refuse before prompting or registering. An existing credential without a profile is also occupied.
  if (await pathExists(path) || await pathExists(join(dirname(path), "credential.json"))) {
    throw new McpConnectError("profile_exists", "This profile path already holds a connection. Choose a new profile path.");
  }
  const name = options.name ?? "MCP agent";
  if (name.trim().length < 1 || name.length > H0_REGISTRATION_NAME_MAX) {
    throw new McpConnectError("connect_name_invalid", `Use a display name of 1 to ${H0_REGISTRATION_NAME_MAX} characters.`);
  }
  const code = await (options.readCode ?? readHiddenJoinCode)();
  if (!JOIN_CODE.test(code)) throw new McpConnectError("join_credential_invalid", `The connect code is invalid. ${RETRY_SENTENCE}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)(`${options.target.url}/functions/v1/h0/register`, {
      method: "POST", headers: { "content-type": "application/json", apikey: options.target.anonKey },
      body: JSON.stringify({ joinCredential: code, attemptId: randomUUID(), name }), signal: controller.signal,
    });
  } catch {
    throw new McpConnectError("register_outcome_unknown", "Registration may have committed. Ask the operator to revoke the seat and issue a new code.");
  } finally { clearTimeout(timer); }
  let body: Record<string, unknown> | null;
  try { body = record(await response.json()); }
  catch { body = null; }
  if (!response.ok || body?.status !== "accepted") {
    const code = typeof body?.error === "string" && /^[a-z0-9_]{1,80}$/.test(body.error) &&
      !/swm_(?:join|agt)_/.test(body.error) ? body.error : "register_refused";
    throw new McpConnectError(code, CODE_REFUSALS.has(code) ? RETRY_SENTENCE : `Registration failed. ${RETRY_SENTENCE}`);
  }
  if (typeof body.workspace_id !== "string" || !ONBOARDING_UUID.test(body.workspace_id) ||
      typeof body.principal_id !== "string" || !ONBOARDING_UUID.test(body.principal_id) ||
      typeof body.run_id !== "string" || !ONBOARDING_UUID.test(body.run_id) ||
      typeof body.token_id !== "string" || !ONBOARDING_UUID.test(body.token_id) ||
      typeof body.agent_token !== "string" || !SEAT_TOKEN.test(body.agent_token) ||
      typeof body.expires_at !== "string" || Number.isNaN(Date.parse(body.expires_at))) {
    throw new McpConnectError("register_response_invalid", "Registration returned an incomplete seat. Ask the operator to revoke it and issue a new code.");
  }
  const connection: AgentConnectionEnvelope = {
    version: 1, url: options.target.url, anon_key: options.target.anonKey,
    workspace_id: body.workspace_id, principal_id: body.principal_id,
    credential: { message: AGENT_CREDENTIAL_MESSAGE_D088, status: "accepted", principal_id: body.principal_id,
      run_id: body.run_id, token_id: body.token_id, agent_token: body.agent_token, expires_at: body.expires_at },
  };
  // saveAgentProfile owns the 0700 directory and 0600 file writes. The profile is intentionally unbound.
  await saveAgentProfile(path, connection, undefined, undefined, true);
  const claude = `claude mcp add --scope user --transport stdio cswarm -- cswarm mcp --profile ${quoteAgentArgument(path)}`;
  const codex = `[mcp_servers.cswarm]\ncommand = "cswarm"\nargs = ["mcp", "--profile", ${JSON.stringify(path)}]`;
  return { profile: path, principal_id: body.principal_id, install: `${claude}\n${codex}` };
}
