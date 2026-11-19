/**
 * Conversations Step 2b read resource parser and executor for `POST /functions/v1/read`.
 *
 * Keeps all four Step 2b resources (`conversations`, `conversation_history`,
 * `conversation_oversight`, `conversation_oversight_history`) cleanly typed and isolated from
 * legacy `signals` reads. Uniform `404 conversation_not_found` prevents existence oracles across
 * unknown, left, and inaccessible conversations or unowned agents.
 */
import type postgres from "npm:postgres@3.4.9";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const CONVERSATION_READ_RESOURCES = [
  "conversations",
  "conversation_history",
  "conversation_oversight",
  "conversation_oversight_history",
] as const;

export const CONVERSATION_NOT_FOUND_BODY = {
  error: "conversation_not_found",
  message: "This conversation isn't available in this workspace.",
} as const;

export interface ConversationsListReadRequest {
  resource: "conversations";
  workspace_id: string;
  include_archived: boolean;
}

export interface ConversationHistoryReadRequest {
  resource: "conversation_history";
  workspace_id: string;
  conversation_id: string;
  before_created_at: string | null;
  before_id: string | null;
  after_created_at: string | null;
  after_id: string | null;
  limit: number;
  include_mentions: boolean;
  include_reactions: boolean;
}

export interface ConversationOversightReadRequest {
  resource: "conversation_oversight";
  workspace_id: string;
  agent_principal_id: string;
}

export interface ConversationOversightHistoryReadRequest {
  resource: "conversation_oversight_history";
  workspace_id: string;
  conversation_id: string;
  agent_principal_id: string;
  before_created_at: string | null;
  before_id: string | null;
  after_created_at: string | null;
  after_id: string | null;
  limit: number;
  include_mentions: boolean;
  include_reactions: boolean;
}

export type ConversationReadRequest =
  | ConversationsListReadRequest
  | ConversationHistoryReadRequest
  | ConversationOversightReadRequest
  | ConversationOversightHistoryReadRequest;

export function isConversationReadResource(resource: unknown): boolean {
  return (
    resource === "conversations" ||
    resource === "conversation_history" ||
    resource === "conversation_oversight" ||
    resource === "conversation_oversight_history"
  );
}

export function isConversationReadRequest(req: { resource: unknown }): req is ConversationReadRequest {
  return isConversationReadResource(req.resource);
}

export function isConversationOversightResource(resource: unknown): boolean {
  return (
    resource === "conversation_oversight" ||
    resource === "conversation_oversight_history"
  );
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(record);
  return keys.length === allowed.length && allowed.every((k) => Object.hasOwn(record, k));
}

function parseCursorPair(
  body: Record<string, unknown>,
  createdKey: string,
  idKey: string,
): { present: boolean; created_at: string | null; id: string | null } | null {
  const hasCreated = Object.hasOwn(body, createdKey);
  const hasId = Object.hasOwn(body, idKey);
  if (hasCreated !== hasId) return null;
  if (!hasCreated) return { present: false, created_at: null, id: null };
  const rawCreated = body[createdKey];
  const rawId = body[idKey];
  if (rawCreated === null && rawId === null) {
    return { present: true, created_at: null, id: null };
  }
  if (
    typeof rawCreated === "string" &&
    Number.isFinite(Date.parse(rawCreated)) &&
    typeof rawId === "string" &&
    UUID_RE.test(rawId)
  ) {
    return { present: true, created_at: rawCreated, id: rawId.toLowerCase() };
  }
  return null;
}

function parseHistoryTail(body: Record<string, unknown>, requiredKeys: readonly string[]): {
  before_created_at: string | null;
  before_id: string | null;
  after_created_at: string | null;
  after_id: string | null;
  limit: number;
  include_mentions: boolean;
  include_reactions: boolean;
} | null {
  const before = parseCursorPair(body, "before_created_at", "before_id");
  const after = parseCursorPair(body, "after_created_at", "after_id");
  if (before === null || after === null) return null;
  if (before.created_at !== null && after.created_at !== null) return null;

  const hasLimit = Object.hasOwn(body, "limit");
  const hasMentions = Object.hasOwn(body, "include_mentions");
  const hasReactions = Object.hasOwn(body, "include_reactions");

  const allowed = [
    ...requiredKeys,
    ...(before.present ? ["before_created_at", "before_id"] : []),
    ...(after.present ? ["after_created_at", "after_id"] : []),
    ...(hasLimit ? ["limit"] : []),
    ...(hasMentions ? ["include_mentions"] : []),
    ...(hasReactions ? ["include_reactions"] : []),
  ];
  if (!exactKeys(body, allowed)) return null;

  let limit = 50;
  if (hasLimit) {
    if (!Number.isSafeInteger(body.limit) || (body.limit as number) < 1 || (body.limit as number) > 100) {
      return null;
    }
    limit = body.limit as number;
  }
  if (hasMentions && typeof body.include_mentions !== "boolean") return null;
  if (hasReactions && typeof body.include_reactions !== "boolean") return null;

  return {
    before_created_at: before.created_at,
    before_id: before.id,
    after_created_at: after.created_at,
    after_id: after.id,
    limit,
    include_mentions: hasMentions ? (body.include_mentions as boolean) : false,
    include_reactions: hasReactions ? (body.include_reactions as boolean) : false,
  };
}

export function parseConversationReadRequest(body: Record<string, unknown>): ConversationReadRequest | null {
  if (body.resource === "conversations") {
    const hasIncludeArchived = Object.hasOwn(body, "include_archived");
    if (
      !exactKeys(body, [
        "resource",
        "workspace_id",
        ...(hasIncludeArchived ? ["include_archived"] : []),
      ]) ||
      typeof body.workspace_id !== "string" ||
      !UUID_RE.test(body.workspace_id) ||
      (hasIncludeArchived && typeof body.include_archived !== "boolean")
    ) {
      return null;
    }
    return {
      resource: "conversations",
      workspace_id: body.workspace_id.toLowerCase(),
      include_archived: hasIncludeArchived ? (body.include_archived as boolean) : false,
    };
  }

  if (body.resource === "conversation_history") {
    if (
      typeof body.workspace_id !== "string" ||
      !UUID_RE.test(body.workspace_id) ||
      typeof body.conversation_id !== "string" ||
      !UUID_RE.test(body.conversation_id)
    ) {
      return null;
    }
    const tail = parseHistoryTail(body, ["resource", "workspace_id", "conversation_id"]);
    if (tail === null) return null;
    return {
      resource: "conversation_history",
      workspace_id: body.workspace_id.toLowerCase(),
      conversation_id: body.conversation_id.toLowerCase(),
      ...tail,
    };
  }

  if (body.resource === "conversation_oversight") {
    if (
      !exactKeys(body, ["resource", "workspace_id", "agent_principal_id"]) ||
      typeof body.workspace_id !== "string" ||
      !UUID_RE.test(body.workspace_id) ||
      typeof body.agent_principal_id !== "string" ||
      !UUID_RE.test(body.agent_principal_id)
    ) {
      return null;
    }
    return {
      resource: "conversation_oversight",
      workspace_id: body.workspace_id.toLowerCase(),
      agent_principal_id: body.agent_principal_id.toLowerCase(),
    };
  }

  if (body.resource === "conversation_oversight_history") {
    if (
      typeof body.workspace_id !== "string" ||
      !UUID_RE.test(body.workspace_id) ||
      typeof body.conversation_id !== "string" ||
      !UUID_RE.test(body.conversation_id) ||
      typeof body.agent_principal_id !== "string" ||
      !UUID_RE.test(body.agent_principal_id)
    ) {
      return null;
    }
    const tail = parseHistoryTail(body, [
      "resource",
      "workspace_id",
      "conversation_id",
      "agent_principal_id",
    ]);
    if (tail === null) return null;
    return {
      resource: "conversation_oversight_history",
      workspace_id: body.workspace_id.toLowerCase(),
      conversation_id: body.conversation_id.toLowerCase(),
      agent_principal_id: body.agent_principal_id.toLowerCase(),
      ...tail,
    };
  }

  return null;
}

export async function executeConversationRead(
  tx: postgres.TransactionSql,
  req: ConversationReadRequest,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (req.resource === "conversations") {
    const [row] = await tx<{ payload: Record<string, unknown> | null }[]>`
      SELECT swarm_read.conversations(
        ${req.workspace_id}::uuid,
        ${req.include_archived}::boolean
      ) AS payload
    `;
    if (!row?.payload) return { status: 200, body: { conversations: [] } };
    return { status: 200, body: row.payload };
  }

  if (req.resource === "conversation_history") {
    const [row] = await tx<{ payload: Record<string, unknown> | null }[]>`
      SELECT swarm_read.conversation_history(
        ${req.workspace_id}::uuid,
        ${req.conversation_id}::uuid,
        ${req.before_created_at}::timestamptz,
        ${req.before_id}::uuid,
        ${req.after_created_at}::timestamptz,
        ${req.after_id}::uuid,
        ${req.limit}::integer,
        ${req.include_mentions}::boolean,
        ${req.include_reactions}::boolean
      ) AS payload
    `;
    if (!row?.payload) return { status: 404, body: { ...CONVERSATION_NOT_FOUND_BODY } };
    return { status: 200, body: row.payload };
  }

  if (req.resource === "conversation_oversight") {
    const [row] = await tx<{ payload: Record<string, unknown> | null }[]>`
      SELECT swarm_read.conversation_oversight(
        ${req.workspace_id}::uuid,
        ${req.agent_principal_id}::uuid
      ) AS payload
    `;
    if (!row?.payload) return { status: 404, body: { ...CONVERSATION_NOT_FOUND_BODY } };
    return { status: 200, body: row.payload };
  }

  const [row] = await tx<{ payload: Record<string, unknown> | null }[]>`
    SELECT swarm_read.conversation_oversight_history(
      ${req.workspace_id}::uuid,
      ${req.conversation_id}::uuid,
      ${req.agent_principal_id}::uuid,
      ${req.before_created_at}::timestamptz,
      ${req.before_id}::uuid,
      ${req.after_created_at}::timestamptz,
      ${req.after_id}::uuid,
      ${req.limit}::integer,
      ${req.include_mentions}::boolean,
      ${req.include_reactions}::boolean
    ) AS payload
  `;
  if (!row?.payload) return { status: 404, body: { ...CONVERSATION_NOT_FOUND_BODY } };
  return { status: 200, body: row.payload };
}
