import postgres from "npm:postgres@3.4.9";
import { presentsAdminCredential } from "../_shared/admin-credential-boundary.ts";
import { withDatabaseTls } from "../_shared/database-options.ts";
import {
  authenticateHostedSeatCapability,
  type HostedCapability,
  type HostedSeatCapability,
  type ProviderGrantStatus,
} from "../_shared/hosted-seat-auth.ts";
import type { CommandResult, HostedCommandInput } from "../command/contract.d.ts";
import type { HostedReadInput, ReadResult } from "../read/index.ts";
import {
  MCP_ISSUER,
  MCP_JWKS_URL,
  MCP_RESOURCE,
  McpJwtVerifier,
  type VerifiedMcpToken,
} from "./auth.ts";
import { executeClaimSeat } from "./claim-seat.ts";
import {
  createMcpProtocolHandler,
  WWW_AUTHENTICATE,
  type McpProtocolLimits,
} from "./protocol.ts";
import type {
  HostedToolArguments,
  HostedToolCall,
  HostedToolName,
} from "./tools.ts";

type Sql = postgres.TransactionSql<Record<string, unknown>>;

const databaseUrl = Deno.env.get("SWARM_DATABASE_URL") ??
  Deno.env.get("SUPABASE_DB_URL");
if (!databaseUrl) throw new Error("MCP requires SWARM_DATABASE_URL or SUPABASE_DB_URL");

function boundedInteger(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = Deno.env.get(name);
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/u.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} is outside its allowed bounds`);
  }
  return value;
}

function exactContract(name: string, expected: string): string {
  const value = Deno.env.get(name) ?? expected;
  if (value !== expected) throw new Error(`${name} must match the hosted MCP contract`);
  return value;
}

function allowedOrigins(value: string | undefined): ReadonlySet<string> {
  if (value === undefined || value.trim() === "") return new Set();
  const result = new Set<string>();
  for (const item of value.split(",")) {
    const candidate = item.trim();
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new Error("SWARM_MCP_ALLOWED_ORIGINS contains an invalid URL");
    }
    if (parsed.origin !== candidate || parsed.username !== "" || parsed.password !== "" ||
        (parsed.protocol !== "https:" &&
          !(Deno.env.get("SWARM_ENV") === "test" && parsed.protocol === "http:" &&
            ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)))) {
      throw new Error("SWARM_MCP_ALLOWED_ORIGINS must contain exact approved origins");
    }
    result.add(candidate);
  }
  return result;
}

const limits: McpProtocolLimits = {
  maxBodyBytes: boundedInteger("SWARM_MCP_MAX_BODY_BYTES", 128 * 1024, 1024, 128 * 1024),
  maxResponseBytes: boundedInteger("SWARM_MCP_MAX_RESPONSE_BYTES", 64 * 1024, 1024, 128 * 1024),
  requestTimeoutMs: boundedInteger("SWARM_MCP_REQUEST_TIMEOUT_MS", 25_000, 1_000, 120_000),
  maxConcurrentRequests: boundedInteger("SWARM_MCP_MAX_CONCURRENT_REQUESTS", 4, 1, 16),
};
const issuer = exactContract("SWARM_MCP_ISSUER", MCP_ISSUER);
const resource = exactContract("SWARM_MCP_RESOURCE", MCP_RESOURCE);
exactContract("SWARM_MCP_JWKS_URL", MCP_JWKS_URL);
const publicEnabled = Deno.env.get("SWARM_MCP_PUBLIC_ENABLED") === "1";

const authDb = postgres(databaseUrl, withDatabaseTls({
  max: 1,
  prepare: false,
  idle_timeout: 3,
  connect_timeout: 5,
}, Deno.env.get("SWARM_DATABASE_TLS_CA_B64")));
// Capability authentication holds authDb while its shared resolver invokes the
// provider-status callback. A separate single-slot pool prevents that nested
// check from deadlocking the bounded authentication pool under concurrency.
const statusDb = postgres(databaseUrl, withDatabaseTls({
  max: 1,
  prepare: false,
  idle_timeout: 3,
  connect_timeout: 5,
}, Deno.env.get("SWARM_DATABASE_TLS_CA_B64")));

async function setRole(tx: Sql, role: "swarm_command" | "swarm_read"): Promise<void> {
  await tx`
    SELECT
      set_config('role', ${role}, true),
      set_config('search_path', 'swarm, commonswarm_oauth, pg_catalog', true),
      set_config('lock_timeout', '5s', true),
      set_config('statement_timeout', '10s', true)
  `;
}

const providerStatus: ProviderGrantStatus = async (providerGrantId) => {
  return await statusDb.begin("isolation level read committed", async (tx) => {
    await setRole(tx, "swarm_read");
    const rows = await tx<{ active: boolean }[]>`
      SELECT commonswarm_oauth.provider_family_active(${providerGrantId}) AS active
    `;
    return { active: rows[0]?.active === true };
  }) as unknown as { active: boolean };
};

interface GrantBinding {
  grantId: string;
  ownerUserId: string;
}

interface SeatBinding extends GrantBinding {
  workspaceId: string;
  handle: string;
}

async function handleHostedCommand(
  input: HostedCommandInput,
  capability: HostedCapability,
): Promise<CommandResult> {
  const command = await import("../command/index.ts");
  return await command.handleHostedCommand(input, capability);
}

async function handleHostedRead(
  input: HostedReadInput,
  capability: HostedSeatCapability,
): Promise<ReadResult> {
  const read = await import("../read/index.ts");
  return await read.handleHostedRead(input, capability);
}

async function resolveSeatBinding(
  token: VerifiedMcpToken,
  handle: string,
): Promise<SeatBinding | null> {
  return await authDb.begin("isolation level read committed", async (tx) => {
    await setRole(tx, "swarm_command");
    const rows = await tx<{
      grant_id: string;
      owner_user_id: string;
      workspace_id: string;
      handle: string;
    }[]>`
      SELECT g.grant_id, g.owner_user_id, h.workspace_id, h.handle
      FROM swarm.hosted_mcp_grants AS g
      JOIN swarm.hosted_mcp_seat_handles AS h ON h.grant_id = g.grant_id
      WHERE g.provider_grant_id = ${token.providerGrantId}
        AND g.owner_user_id = ${token.subject}::uuid
        AND h.handle = ${handle}
      LIMIT 2
    `;
    const row = rows.length === 1 ? rows[0] : undefined;
    return row === undefined ? null : {
      grantId: row.grant_id,
      ownerUserId: row.owner_user_id,
      workspaceId: row.workspace_id,
      handle: row.handle,
    };
  }) as unknown as SeatBinding | null;
}

async function seatCapability(
  token: VerifiedMcpToken,
  binding: SeatBinding,
  tool: Exclude<HostedToolName, "claim_seat">,
): Promise<HostedSeatCapability | null> {
  const use = tool === "whoami" || tool === "members" ? "read" : "command";
  return await authDb.begin("isolation level read committed", async (tx) => {
    await setRole(tx, use === "read" ? "swarm_read" : "swarm_command");
    return await authenticateHostedSeatCapability(tx, {
      grantId: binding.grantId,
      providerGrantId: token.providerGrantId,
      handle: binding.handle,
      tool,
      providerStatus,
    }, use);
  }) as unknown as HostedSeatCapability | null;
}

function recipients(args: HostedToolArguments) {
  return Array.isArray(args.recipients)
    ? args.recipients as Array<{ kind: "user" | "agent"; id: string }>
    : null;
}

function hostedCommand(
  name: "ask" | "note" | "reply" | "working_on",
  args: HostedToolArguments,
  workspaceId: string,
) {
  const addressed = recipients(args);
  return {
    command_id: args.request_id,
    client_version: "0.1.80",
    workspace_id: workspaceId,
    stream: { kind: "workspace" },
    command: {
      kind: "post_signal",
      signal_kind: name === "working_on" ? "working-on" : name === "reply" ? "note" : name,
      body: args.body,
      to_user_id: null,
      to_agent_principal_id: null,
      in_reply_to: name === "reply" ? args.signal_id : null,
      about: null,
      ...(addressed === null ? {} : { to: addressed }),
    },
  };
}

function commandOutput(result: CommandResult): Record<string, unknown> {
  if (result.status < 200 || result.status >= 300) {
    const error = typeof result.body.error === "string" ? result.body.error : "hosted_command_failed";
    throw new Error(/^hosted_[a-z0-9_]+$/u.test(error) ? error : "hosted_command_failed");
  }
  const signal = result.body.signal;
  if (signal !== null && typeof signal === "object" && !Array.isArray(signal)) {
    const row = signal as Record<string, unknown>;
    return {
      signal_id: row.id,
      kind: row.kind,
      created_at: row.created_at,
      in_reply_to: row.in_reply_to ?? null,
    };
  }
  if (typeof result.body.handle === "string") {
    return {
      grant_id: result.body.grant_id,
      workspace_id: result.body.workspace_id,
      seat_id: result.body.seat_id,
      principal_id: result.body.principal_id,
      handle: result.body.handle,
      name: result.body.name,
    };
  }
  return result.body;
}

function readOutput(result: ReadResult): Record<string, unknown> {
  if (result.status < 200 || result.status >= 300) {
    throw new Error("hosted_read_failed");
  }
  return result.body;
}

async function executeTool(call: HostedToolCall): Promise<Record<string, unknown>> {
  if (call.signal.aborted) throw call.signal.reason;
  const args = call.arguments;
  if (call.name === "claim_seat") {
    return commandOutput(await executeClaimSeat(call, {
      withAuthTransaction: async <T>(run: (tx: Sql) => Promise<T>): Promise<T> =>
        await authDb.begin("isolation level read committed", async (tx) => {
          await setRole(tx, "swarm_command");
          return await run(tx);
        }) as unknown as T,
      providerStatus,
      handleCommand: handleHostedCommand,
    }));
  }
  const handle = String(args.seat);
  const binding = await resolveSeatBinding(call.token, handle);
  if (binding === null) throw new Error("hosted_seat_forbidden");
  const capability = await seatCapability(call.token, binding, call.name);
  if (capability === null) throw new Error("hosted_seat_forbidden");
  if (call.name === "whoami" || call.name === "members") {
    const output = readOutput(await handleHostedRead({
      resource: call.name,
      workspace_id: binding.workspaceId,
    }, capability));
    if (call.name === "whoami") {
      return {
        grant_id: output.grant_id,
        seat_id: output.seat_id,
        handle: output.handle,
        workspace_id: output.workspace_id,
        principal_id: output.principal_id,
        name: output.name,
        transport: output.transport,
        turn_only: output.turn_only,
      };
    }
    return {
      members: Array.isArray(output.members)
        ? output.members.map((value) => {
          const row = value as Record<string, unknown>;
          return { user_id: row.user_id, display_name: row.display_name };
        })
        : [],
      agents: Array.isArray(output.agents)
        ? output.agents.map((value) => {
          const row = value as Record<string, unknown>;
          return { principal_id: row.principal_id, name: row.name };
        })
        : [],
    };
  }
  if (call.name === "check") {
    const result = await handleHostedCommand({
      command_id: `mcpcheck_${crypto.randomUUID()}`,
      client_version: "0.1.80",
      workspace_id: binding.workspaceId,
      stream: { kind: "workspace" },
      command: args.ack === undefined
        ? { kind: "open_hosted_mcp_check_batch", seat: handle }
        : { kind: "ack_hosted_mcp_check_batch", seat: handle, ack: args.ack },
    }, capability);
    return commandOutput(result);
  }
  return commandOutput(await handleHostedCommand(
    hostedCommand(call.name, args, binding.workspaceId),
    capability,
  ));
}

const verifier = new McpJwtVerifier({
  cacheTtlSeconds: boundedInteger("SWARM_MCP_JWKS_CACHE_TTL_SECONDS", 60, 1, 300),
  clockSkewSeconds: boundedInteger("SWARM_MCP_CLOCK_SKEW_SECONDS", 30, 0, 60),
});

const handleProtocolRequest = createMcpProtocolHandler({
  issuer,
  resource,
  publicEnabled,
  allowedOrigins: allowedOrigins(Deno.env.get("SWARM_MCP_ALLOWED_ORIGINS")),
  limits,
  verifyToken: (token, signal) => verifier.verify(token, signal),
  executeTool,
});

export async function handleRequest(request: Request): Promise<Response> {
  // Refuse foreign credentials before routing, parsing, authentication or tools.
  // Keep the protocol module independent of the account authority bundle.
  if (presentsAdminCredential(request)) {
    if (new URL(request.url).pathname === "/mcp") {
      console.error(JSON.stringify({ event: "request_failed", error_code: "unauthorized", method: null }));
    }
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "www-authenticate": WWW_AUTHENTICATE,
      },
    });
  }
  return await handleProtocolRequest(request);
}

if (import.meta.main) Deno.serve(handleRequest);
