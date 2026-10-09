import type { VerifiedMcpToken } from "./auth.ts";
// @ts-ignore TS5097: Deno requires the source extension; Node tests use tsx.
import { CLAIM_SEAT_DESCRIPTION, WHOAMI_DESCRIPTION } from "./session-instructions.ts";
// @ts-ignore TS5097: Deno requires the source extension; Node tests import this module through tsx.
import { SIGNAL_UNSAFE_GLOBAL_RE } from "../_shared/signal-text.ts";

import { HOUSEHOLD_TOOLS, HOUSEHOLD_TOOL_REGISTRY, validateHouseholdToolArguments, HouseholdToolInputError } from "../_shared/protocol.js";
// @ts-ignore TS5097: Node tests import this Deno module through tsx.
import { HOUSEHOLD_FEATURE_GATES } from "../_shared/household-feature-gates.ts";
// @ts-ignore TS5097: Node tests import this Deno module through tsx.
import { HOSTED_HOUSEHOLD_TOOLS_ENABLED } from "./household-release.ts";

// The registry includes prepared file definitions. Hosted admission excludes
// file-only tools until protected byte transport has been completed and reviewed.
const hostedHouseholdTools = HOUSEHOLD_TOOLS.filter(tool => {
  const definition = HOUSEHOLD_TOOL_REGISTRY.find(row => row.name === tool.name)!;
  return HOSTED_HOUSEHOLD_TOOLS_ENABLED && (HOUSEHOLD_FEATURE_GATES.hostedFileTransport ||
    !definition.objectTypes.every((kind: string) => kind === "file"));
});

const UUID_PATTERN = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";
const HANDLE_PATTERN = "^seat_[A-Za-z0-9_-]{22,64}$";
const REQUEST_ID_PATTERN = "^[A-Za-z0-9_-]{8,72}$";
const NAME_PATTERN = "^(?! )(?![\\s\\S]* $)[^\\u0000-\\u001f\\u007f-\\u009f]+$";
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/u;
const SIGNAL_UNSAFE_RE = new RegExp(SIGNAL_UNSAFE_GLOBAL_RE.source, "u");

type JsonSchema = Record<string, unknown>;
const text = (minimum: number, maximum: number, pattern?: string): JsonSchema => ({
  type: "string", minLength: minimum, maxLength: maximum,
  ...(pattern === undefined ? {} : { pattern }),
});
const objectSchema = (
  properties: Record<string, JsonSchema>,
  required: readonly string[],
): JsonSchema => ({
  type: "object", properties, required: [...required], additionalProperties: false,
});
const uuid = text(36, 36, UUID_PATTERN);
const claimWorkspace = { ...uuid, not: { enum: ["00000000-0000-0000-0000-000000000000", "00000000-0000-4000-8000-000000000000"] } };
const handle = text(27, 69, HANDLE_PATTERN);
const requestId = text(8, 72, REQUEST_ID_PATTERN);
const seatName = text(1, 80, NAME_PATTERN);
const INTENTS = ["new", "continue"] as const;
const LIFETIMES = ["ephemeral", "durable"] as const;
const KINDS = ["chat", "task", "scheduled", "subagent"] as const;
const claimSchema: JsonSchema = {
  ...objectSchema({
    request_id: requestId, intent: { type: "string", enum: INTENTS, default: "new" },
    name: seatName, workspace_id: claimWorkspace, seat: handle,
    lifetime: { type: "string", enum: LIFETIMES, default: "ephemeral" },
    kind: { type: "string", enum: KINDS, default: "chat" }, parent_context: uuid,
  }, ["request_id"]),
  allOf: [
    {
      if: { required: ["intent"], properties: { intent: { const: "continue" } } },
      then: {
        anyOf: [{ required: ["seat"] }, { required: ["name"] }],
        not: { required: ["lifetime"] },
        allOf: [{ if: { required: ["seat"] }, then: {
          not: { anyOf: [{ required: ["kind"] }, { required: ["parent_context"] }] },
        } }],
      },
      else: {
        not: { required: ["seat"] },
        allOf: [{ if: { required: ["lifetime"], properties: { lifetime: { const: "durable" } } },
          then: { required: ["name"] } }],
      },
    },
  ],
};
const recipient = objectSchema({ kind: { type: "string", enum: ["user", "agent"] }, id: uuid }, ["kind", "id"]);
const recipients = { type: "array", items: recipient, minItems: 1, maxItems: 20 };

export const CORE_TOOL_TABLE = [
  {
    name: "claim_seat", effect: "write", title: "Claim a named seat",
    securitySchemes: [{ type: "oauth2", scopes: ["mcp"] }],
    description: CLAIM_SEAT_DESCRIPTION,
    annotations: { title: "Claim a named seat", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: claimSchema,
  },
  {
    name: "whoami", effect: "read", title: "Show seat identity",
    securitySchemes: [{ type: "oauth2", scopes: ["mcp"] }],
    description: WHOAMI_DESCRIPTION,
    annotations: { title: "Show seat identity", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: objectSchema({ seat: handle }, []),
  },
  {
    name: "close_session", effect: "write", title: "Close this chat identity",
    securitySchemes: [{ type: "oauth2", scopes: ["mcp"] }],
    description: "Close the context supplied by seat and release its active capacity. Shared work remains; a durable agent is retained. Retry the same request with the same request_id. This does not close other chats.",
    annotations: { title: "Close this chat identity", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: objectSchema({ seat: handle, request_id: requestId }, ["seat", "request_id"]),
  },
  {
    name: "check", effect: "write", title: "Check and acknowledge inbox",
    securitySchemes: [{ type: "oauth2", scopes: ["mcp"] }],
    description: "Open a durable inbox batch, optionally acknowledging the prior batch and permanently advancing delivery.",
    // ACK replaces durable cursor state; later calls can create new batches.
    // See command/index.ts handleHostedCheck and mcp/index.ts executeTool.
    annotations: { title: "Check and acknowledge inbox", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: objectSchema({ seat: handle, ack: uuid }, ["seat"]),
  },
  {
    name: "ask", effect: "write", title: "Ask workspace participants",
    securitySchemes: [{ type: "oauth2", scopes: ["mcp"] }],
    description: "Ask one or more workspace participants. Retry with the same request_id.",
    annotations: { title: "Ask workspace participants", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: objectSchema({ seat: handle, recipients, body: text(1, 8000), request_id: requestId }, ["seat", "recipients", "body", "request_id"]),
  },
  {
    name: "note", effect: "write", title: "Share a workspace note",
    securitySchemes: [{ type: "oauth2", scopes: ["mcp"] }],
    description: "Share a note, optionally with recipients. Retry with the same request_id.",
    annotations: { title: "Share a workspace note", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: objectSchema({ seat: handle, recipients, body: text(1, 8000), request_id: requestId }, ["seat", "body", "request_id"]),
  },
  {
    name: "reply", effect: "write", title: "Reply to a signal",
    securitySchemes: [{ type: "oauth2", scopes: ["mcp"] }],
    description: "Reply privately to a signal. Retry with the same request_id.",
    annotations: { title: "Reply to a signal", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: objectSchema({ seat: handle, signal_id: uuid, body: text(1, 8000), request_id: requestId }, ["seat", "signal_id", "body", "request_id"]),
  },
  {
    name: "working_on", effect: "write", title: "Share current work",
    securitySchemes: [{ type: "oauth2", scopes: ["mcp"] }],
    description: "Share current work. Retry with the same request_id.",
    annotations: { title: "Share current work", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: objectSchema({ seat: handle, body: text(1, 8000), request_id: requestId }, ["seat", "body", "request_id"]),
  },
  {
    name: "members", effect: "read", title: "List workspace participants",
    securitySchemes: [{ type: "oauth2", scopes: ["mcp"] }],
    description: "List members and agents in the selected seat's workspace.",
    annotations: { title: "List workspace participants", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: objectSchema({ seat: handle }, ["seat"]),
  },
] as const;

// Effects describe behavior for catalog review; they are not MCP wire fields.
export const HOSTED_TOOL_TABLE = [
  ...CORE_TOOL_TABLE.map(({ effect: _effect, ...tool }) => tool),
  ...hostedHouseholdTools.map(row => ({ ...row, securitySchemes: [{ type: "oauth2", scopes: ["mcp"] }] })),
] as const;

export type ContextKind = typeof KINDS[number];
export type IdentityLifetime = typeof LIFETIMES[number];
export interface Workspace { id: string; name: string }
export interface Identity {
  grant_id: string; workspace_id: string; workspace: Workspace;
  seat_id: string; principal_id: string; context_id: string;
  seat: string; handle: string; name: string; display_name: string; disambiguator: string | null;
  assurance: "portable"; lifetime: IdentityLifetime; kind: ContextKind;
  created_at: string; last_business_at: string;
  idle_expires_at: string | null; absolute_expires_at: string | null;
}
export interface ClaimResult extends Identity {
  outcome: "created" | "continued" | "replayed"; original_outcome: "created" | "continued";
  name_adjusted: boolean; adjustment_reason: "collision" | "ephemeral_address" | null;
}
export interface SelectedResult extends Identity {
  context_status: "active"; transport: "hosted"; turn_only: true;
}
export interface CloseResult {
  outcome: "closed" | "replayed"; context_id: string;
  principal_state: "retired" | "retained"; closed_at: string;
}

export type HostedToolName = typeof HOSTED_TOOL_TABLE[number]["name"];
export type HostedToolArguments = Record<string, unknown>;

export interface HostedToolCall {
  name: HostedToolName;
  arguments: HostedToolArguments;
  token: VerifiedMcpToken;
  signal: AbortSignal;
}

export type HostedToolExecutor = (call: HostedToolCall) => Promise<Record<string, unknown>>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" && new RegExp(UUID_PATTERN, "u").test(value);
}

function validHandle(value: unknown): value is string {
  return typeof value === "string" && new RegExp(HANDLE_PATTERN, "u").test(value);
}

function validRequestId(value: unknown): value is string {
  return typeof value === "string" && new RegExp(REQUEST_ID_PATTERN, "u").test(value);
}

function hasForbiddenBodyControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && codePoint <= 0x9f &&
      character !== "\t" && character !== "\n" && character !== "\r" &&
      SIGNAL_UNSAFE_RE.test(character);
  });
}

function validBody(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 8000 &&
    value.trim().length > 0 && !hasForbiddenBodyControl(value);
}

export function validSeatName(value: unknown): value is string {
  return typeof value === "string" && Array.from(value).length >= 1 &&
    Array.from(value).length <= 80 && value === value.replace(/^ +| +$/gu, "") &&
    !CONTROL_RE.test(value);
}

function validRecipients(value: unknown): boolean {
  return Array.isArray(value) && value.length >= 1 && value.length <= 20 &&
    value.every((item) => {
      const row = record(item);
      return row !== null && Object.keys(row).length === 2 &&
        (row.kind === "user" || row.kind === "agent") && validUuid(row.id);
    });
}

// The correction text and closed-record validation read the advertised schema.
const KEYS = Object.fromEntries(CORE_TOOL_TABLE.map(({ name, inputSchema }) => [name, {
  allowed: Object.keys(inputSchema.properties as Record<string, JsonSchema>),
  required: inputSchema.required as string[],
}])) as Partial<Record<HostedToolName, { allowed: string[]; required: string[] }>>;

export class HostedToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostedToolInputError";
  }
}

export function hostedToolName(value: string): value is HostedToolName {
  return HOSTED_TOOL_TABLE.some((tool) => tool.name === value);
}

const EXPECTED: Record<string, string> = {
  seat: "provide the seat_ handle returned by claim_seat (22 to 64 letters, digits, underscores or hyphens after seat_)",
  name: "provide 1 to 80 characters with no surrounding spaces or control characters",
  request_id: "provide 8 to 72 letters, digits, underscores or hyphens; reuse it only for the same request",
  workspace_id: "provide a real workspace UUID or omit it to use the grant's home workspace",
  ack: "provide the batch UUID returned by check, or omit ack to open the inbox",
  body: "provide 1 to 8000 characters with non-whitespace text; only tab, newline and carriage return are allowed control characters",
  recipients: "provide 1 to 20 objects with only kind (user or agent) and id (UUID); use members to find recipients",
  signal_id: "provide the signal UUID from check that you want to reply to",
  intent: `provide ${INTENTS.join(" or ")}; omission means new`,
  lifetime: `provide ${LIFETIMES.join(" or ")}; allowed only for new`,
  kind: `provide ${KINDS.join(", ")}; omit it when continuing with a handle`,
  parent_context: "provide a known same-grant context UUID; parentage is unverified",
};

export function validateHostedToolArguments(
  name: HostedToolName,
  value: unknown,
): HostedToolArguments {
  if (!hostedToolName(name)) throw new HostedToolInputError("Unknown or unavailable tool.");
  if (HOUSEHOLD_TOOL_REGISTRY.some(row => row.name === name)) {
    try { return validateHouseholdToolArguments(name, value); }
    catch (error) { if (error instanceof HouseholdToolInputError) throw new HostedToolInputError(error.code); throw error; }
  }
  const args = record(value);
  if (args === null) throw new HostedToolInputError("Expected an object of tool arguments. Send arguments as a JSON object.");
  const shape = KEYS[name]!;
  if (Object.keys(args).some((key) => !shape.allowed.includes(key))) {
    // Unknown keys and supplied values can contain secrets; list trusted keys.
    throw new HostedToolInputError(`Unknown tool argument. Use only: ${shape.allowed.join(", ")}.`);
  }
  for (const key of shape.required) {
    if (!Object.hasOwn(args, key)) throw new HostedToolInputError(`Missing ${key}: ${EXPECTED[key]}.`);
  }
  const invalid = (key: string): never => {
    throw new HostedToolInputError(`Invalid ${key}: ${EXPECTED[key]}.`);
  };
  if (name === "claim_seat") {
    if (Object.hasOwn(args, "workspace_id") &&
        (!validUuid(args.workspace_id) || claimWorkspace.not.enum.includes(args.workspace_id))) invalid("workspace_id");
    if (Object.hasOwn(args, "name") && !validSeatName(args.name)) invalid("name");
    if (Object.hasOwn(args, "seat") && !validHandle(args.seat)) invalid("seat");
    for (const [key, choices] of [["intent", INTENTS], ["lifetime", LIFETIMES], ["kind", KINDS]] as const) {
      if (Object.hasOwn(args, key) && !choices.some(choice => choice === args[key])) invalid(key);
    }
    if (Object.hasOwn(args, "parent_context") && !validUuid(args.parent_context)) invalid("parent_context");
    if (!validRequestId(args.request_id)) invalid("request_id");
    if (args.intent === "continue") {
      if (Object.hasOwn(args, "lifetime")) invalid("lifetime");
      if (!Object.hasOwn(args, "seat") && !Object.hasOwn(args, "name")) {
        throw new HostedToolInputError("Continue requires a seat handle or a durable name.");
      }
      if (Object.hasOwn(args, "seat")) {
        if (Object.hasOwn(args, "kind")) invalid("kind");
        if (Object.hasOwn(args, "parent_context")) invalid("parent_context");
      }
    } else {
      if (Object.hasOwn(args, "seat")) invalid("seat");
      if (args.lifetime === "durable" && !Object.hasOwn(args, "name")) {
        throw new HostedToolInputError("Durable new requires a name and the user’s persistent-agent request.");
      }
    }
    return args;
  }
  if (name === "whoami" && !Object.hasOwn(args, "seat")) return args;
  if (!validHandle(args.seat)) invalid("seat");
  if (name === "close_session") {
    if (!validRequestId(args.request_id)) invalid("request_id");
    return args;
  }
  if (name === "check") {
    if (args.ack !== undefined && !validUuid(args.ack)) invalid("ack");
    return args;
  }
  if (name === "whoami" || name === "members") return args;
  if (!validBody(args.body)) invalid("body");
  if (!validRequestId(args.request_id)) invalid("request_id");
  if ((name === "ask" && !validRecipients(args.recipients)) ||
      (name === "note" && args.recipients !== undefined && !validRecipients(args.recipients))) invalid("recipients");
  if (name === "reply" && !validUuid(args.signal_id)) invalid("signal_id");
  return args;
}
