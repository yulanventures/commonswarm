import { H0_REQUEST_ID_RE, H0_REQUEST_ID_MIN, H0_REQUEST_ID_MAX } from "../h0/verbs.js";
import { SIGNAL_BODY_MAX, SIGNAL_ABOUT_MAX, SIGNAL_RECIPIENT_MAX } from "../cloud/signal-limits.js";
import { SIGNAL_DURATION_RE, signalDuration } from "../cloud/signal-duration.js";
import { CHANNEL_SLUG_MAX, CHANNEL_SLUG_RE, channelSlugProblem } from "../cloud/channels.js";
import { ONBOARDING_UUID } from "../cloud/agent-onboarding-contract.js";
import type { AgentCheckResult } from "../cloud/agent-check.js";
import type { SignalRecord } from "../cloud/command-client.js";
import type { SignalDirectory } from "../cloud/signals.js";
import type { PostSignalResult } from "../cloud/command-client.js";

/** An unknown argument name is echoed to the caller only up to this length. */
export const MCP_ARGUMENT_NAME_ECHO_MAX = 64;
/** MCP's model-visible contract. Do not derive it from CLI flags. */
export const MCP_RESULT_MAX_BYTES = 32 * 1024;
const string = (maxLength?: number, minLength?: number, pattern?: string) => ({
  type: "string" as const, ...(maxLength === undefined ? {} : { maxLength }),
  ...(minLength === undefined ? {} : { minLength }), ...(pattern === undefined ? {} : { pattern }),
});
const body = string(SIGNAL_BODY_MAX, 1);
const requestId = string(H0_REQUEST_ID_MAX, H0_REQUEST_ID_MIN, H0_REQUEST_ID_RE.source);
const UUID_LENGTH = "00000000-0000-0000-0000-000000000000".length;
const uuid = string(UUID_LENGTH, UUID_LENGTH, ONBOARDING_UUID.source.replaceAll("a-f", "a-fA-F").replaceAll("[89ab]", "[89abAB]"));
const common = { body, about: string(SIGNAL_ABOUT_MAX), channel: string(CHANNEL_SLUG_MAX, 1, CHANNEL_SLUG_RE.source), until: string(undefined, undefined, SIGNAL_DURATION_RE.source), request_id: requestId };
const schema = (properties: Record<string, ReturnType<typeof string>>, required: string[] = []) => ({
  type: "object" as const, properties, required, additionalProperties: false as const,
});
/** The only tool table: schemas and output projections live beside each other. */
export const MCP_TOOL_TABLE = [
  { name: "whoami", description: "Show this authenticated agent and workspace.", inputSchema: schema({}), mapResult: mapWhoami },
  { name: "check", description: "Read new directed messages. If a result is lost, call check with its message_id to read the cached full text.", inputSchema: schema({ message_id: uuid }), mapResult: { fresh: mapCheck, cached: mapCachedCheck } },
  { name: "ask", description: "Ask a teammate. Channel slugs are lowercase. Retry with the same request_id and arguments if the outcome is unknown.", inputSchema: schema({ ...common, to: string(SIGNAL_RECIPIENT_MAX, 1) }, ["body", "request_id"]), mapResult: mapSignal },
  { name: "note", description: "Share a note. Channel slugs are lowercase. Retry with the same request_id and arguments if the outcome is unknown.", inputSchema: schema({ ...common, to: string(SIGNAL_RECIPIENT_MAX, 1) }, ["body", "request_id"]), mapResult: mapSignal },
  { name: "reply", description: "Reply privately to a signal. Retry with the same request_id and arguments if the outcome is unknown.", inputSchema: schema({ signal_id: uuid, body, request_id: requestId }, ["signal_id", "body", "request_id"]), mapResult: mapSignal },
  { name: "working_on", description: "Share current work. Channel slugs are lowercase. Retry with the same request_id and arguments if the outcome is unknown.", inputSchema: schema(common, ["body", "request_id"]), mapResult: mapSignal },
  { name: "members", description: "List members and agents in this workspace.", inputSchema: schema({}), mapResult: mapMembers },
] as const;
export const MCP_TOOLS = MCP_TOOL_TABLE.map(({ mapResult: _mapResult, ...tool }) => tool);

export type McpToolName = typeof MCP_TOOL_TABLE[number]["name"];

export function validateMcpArguments(name: McpToolName, value: unknown): Record<string, string> {
  const tool = MCP_TOOL_TABLE.find(row => row.name === name)!;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object of tool arguments.");
  const args = value as Record<string, unknown>;
  for (const key of Object.keys(args)) {
    const rule = (tool.inputSchema.properties as Record<string, ReturnType<typeof string>>)[key];
    if (!rule) throw new Error(`Unknown argument: ${JSON.stringify(key.slice(0, MCP_ARGUMENT_NAME_ECHO_MAX))}.`);
    const item = args[key];
    if (typeof item !== "string" || (rule.minLength !== undefined && item.length < rule.minLength) ||
        (rule.maxLength !== undefined && item.length > rule.maxLength) ||
        (rule.pattern !== undefined && !new RegExp(rule.pattern).test(item)) ||
        (key === "channel" && channelSlugProblem(item) !== null)) throw new Error(`Invalid argument: ${key}.`);
    if (key === "until") {
      try { signalDuration(item); } catch { throw new Error("Invalid argument: until."); }
    }
  }
  for (const key of tool.inputSchema.required) if (!Object.hasOwn(args, key)) throw new Error(`Missing argument: ${key}.`);
  if (typeof args.body === "string" && !args.body.trim()) throw new Error("Invalid argument: body.");
  return args as Record<string, string>;
}

export function mapCheck(result: AgentCheckResult): object {
  return { checked: true, cached: false, workspace_id: result.workspace_id, workspace_name: result.workspace_name,
    messages: result.messages.map(row => ({ id: row.id, from: row.from, from_kind: row.from_kind,
      sender_owner_relation: row.sender_owner_relation, kind: row.kind, body: row.body,
      truncated: row.truncated, attachment_count: row.attachment_count, created_at: row.created_at,
      ...(row.truncated ? { full_text_tool: { name: "check", arguments: { message_id: row.id } } } : {}),
    })), has_more: result.has_more,
    next_action: result.has_more ? "Call check again for more messages." : null };
}

export function mapCachedCheck(row: SignalRecord): object {
  return { checked: true, cached: true, messages: [{ id: row.id, from: row.from, from_kind: row.from_kind,
    sender_owner_relation: row.sender_owner_relation ?? "unknown", kind: row.kind, body: row.body, created_at: row.created_at }] };
}

export function mapWhoami(directory: SignalDirectory, principalId: string, workspaceId: string): object {
  const own = directory.agents.find(row => row.principal_id === principalId)!;
  return { principal_id: principalId, name: own.name, workspace_id: workspaceId,
    workspace_name: directory.identity?.workspace_name ?? null };
}

export function mapMembers(directory: SignalDirectory, workspaceId: string): object {
  return { workspace_id: workspaceId, workspace_name: directory.identity?.workspace_name ?? null,
    members: directory.members.map(row => ({ user_id: row.user_id, name: row.display_name })),
    agents: directory.agents.map(row => ({ principal_id: row.principal_id, name: row.name })) };
}

export function mapSignal(result: PostSignalResult): object {
  const row = result.response.signal!;
  return { signal_id: row.id, kind: row.kind, created_at: row.created_at,
    in_reply_to: row.in_reply_to ?? null, channel_id: row.channel_id ?? null };
}

/** Only message prefixes the model received may advance the cursor. */
export function capFreshCheck(result: AgentCheckResult): { output: object; lastVisibleId: string | null } {
  let visible = result.messages.length;
  while (visible >= 0) {
    const output = mapCheck({ ...result, messages: result.messages.slice(0, visible), has_more: visible < result.messages.length || result.has_more });
    if (Buffer.byteLength(JSON.stringify(output)) <= MCP_RESULT_MAX_BYTES) return { output, lastVisibleId: visible ? result.messages[visible - 1]!.id : null };
    visible--;
  }
  return { output: capMcpResult(mapCheck(result)), lastVisibleId: null };
}

export function capMcpResult(value: object): object {
  const raw = JSON.stringify(value);
  if (Buffer.byteLength(raw) <= MCP_RESULT_MAX_BYTES) return value;
  // A bounded, explicit answer is safer than cutting JSON or silently hiding rows.
  return { truncated: true, message: "Result exceeds the MCP byte cap. Narrow the request." };
}
