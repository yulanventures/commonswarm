/**
 * Cloud client for Conversations Step 2b reads (`POST /functions/v1/read`) and
 * Step 2a conversation commands (`POST /functions/v1/command`).
 */
import { randomUUID } from "node:crypto";
import {
  CLIENT_PROTOCOL_VERSION,
  commandEndpoint,
  readEndpoint,
  type CloudTarget,
} from "./config.js";

export type ConversationKind =
  | "general"
  | "public_channel"
  | "private_channel"
  | "dm"
  | "group_dm";

export type ConversationNotifyLevel = "everything" | "mentions" | "muted";

export interface ConversationMemberRef {
  kind: "user" | "agent";
  id: string;
}

export interface ConversationMember extends ConversationMemberRef {
  name: string | null;
  left_at: string | null;
}

export interface ConversationSummaryWire {
  conversation_id: string;
  kind: ConversationKind;
  channel_id: string | null;
  slug: string | null;
  description: string | null;
  archived_at: string | null;
  joined: boolean;
  generation: number;
  lead_mode: "workspace" | "agent" | "none" | null;
  lead_agent_principal_id: string | null;
  members: ConversationMember[];
  notify_level: ConversationNotifyLevel;
  starred: boolean;
  star_rank: number | null;
  read_through_at: string | null;
  read_through_id: string | null;
  unread_count: number;
  mention_count: number;
  last_message_at: string | null;
  last_message_id: string | null;
}

export interface OversightConversationSummaryWire {
  conversation_id: string;
  kind: ConversationKind;
  channel_id: string | null;
  slug: string | null;
  description: string | null;
  archived_at: string | null;
  generation: number;
  members: ConversationMember[];
  last_message_at: string | null;
  last_message_id: string | null;
  read_only: true;
}

export interface ConversationCursorWire {
  created_at: string;
  id: string;
}

export interface ConversationHistoryResponse {
  conversation: ConversationSummaryWire;
  messages: Record<string, unknown>[];
  has_more: boolean;
  next_before: ConversationCursorWire | null;
  next_after: ConversationCursorWire | null;
}

export interface OversightHistoryResponse {
  conversation: OversightConversationSummaryWire;
  messages: Record<string, unknown>[];
  has_more: boolean;
  next_before: ConversationCursorWire | null;
  next_after: ConversationCursorWire | null;
}

export interface ConversationReadClientOptions {
  fetcher?: typeof fetch;
  signal?: AbortSignal;
}

async function postReadJson(
  target: CloudTarget,
  bearer: string,
  payload: Record<string, unknown>,
  options: ConversationReadClientOptions = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(readEndpoint(target), {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      apikey: target.anonKey,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  if (text.trim().length > 0) {
    try {
      const json = JSON.parse(text);
      if (json && typeof json === "object" && !Array.isArray(json)) {
        parsed = json as Record<string, unknown>;
      }
    } catch {
      parsed = { raw: text };
    }
  }
  return { status: response.status, body: parsed };
}

export async function listConversations(
  target: CloudTarget,
  bearer: string,
  workspaceId: string,
  options: ConversationReadClientOptions & { includeArchived?: boolean } = {},
): Promise<{ conversations: ConversationSummaryWire[] }> {
  const { status, body } = await postReadJson(
    target,
    bearer,
    {
      resource: "conversations",
      workspace_id: workspaceId.toLowerCase(),
      include_archived: options.includeArchived === true,
    },
    options,
  );
  if (status !== 200 || !Array.isArray(body.conversations)) {
    const message = typeof body.message === "string"
      ? body.message
      : typeof body.error === "string"
      ? body.error
      : `conversations read failed (HTTP ${status})`;
    throw new Error(message);
  }
  return { conversations: body.conversations as ConversationSummaryWire[] };
}

export interface ReadConversationHistoryParams {
  before?: ConversationCursorWire | null;
  after?: ConversationCursorWire | null;
  limit?: number;
  includeMentions?: boolean;
  includeReactions?: boolean;
}

export async function readConversationHistory(
  target: CloudTarget,
  bearer: string,
  workspaceId: string,
  conversationId: string,
  params: ReadConversationHistoryParams = {},
  options: ConversationReadClientOptions = {},
): Promise<
  | { ok: true; data: ConversationHistoryResponse }
  | { ok: false; status: number; error: string; message: string }
> {
  const payload: Record<string, unknown> = {
    resource: "conversation_history",
    workspace_id: workspaceId.toLowerCase(),
    conversation_id: conversationId.toLowerCase(),
    ...(params.before
      ? { before_created_at: params.before.created_at, before_id: params.before.id.toLowerCase() }
      : {}),
    ...(params.after
      ? { after_created_at: params.after.created_at, after_id: params.after.id.toLowerCase() }
      : {}),
    ...(params.limit !== undefined ? { limit: params.limit } : {}),
    ...(params.includeMentions !== undefined ? { include_mentions: params.includeMentions } : {}),
    ...(params.includeReactions !== undefined ? { include_reactions: params.includeReactions } : {}),
  };
  const { status, body } = await postReadJson(target, bearer, payload, options);
  if (status === 200 && body.conversation && Array.isArray(body.messages)) {
    return { ok: true, data: body as unknown as ConversationHistoryResponse };
  }
  return {
    ok: false,
    status,
    error: typeof body.error === "string" ? body.error : `http_${status}`,
    message: typeof body.message === "string"
      ? body.message
      : "This conversation isn't available in this workspace.",
  };
}

export async function listOversightConversations(
  target: CloudTarget,
  bearer: string,
  workspaceId: string,
  agentPrincipalId: string,
  options: ConversationReadClientOptions = {},
): Promise<
  | { ok: true; conversations: OversightConversationSummaryWire[] }
  | { ok: false; status: number; error: string; message: string }
> {
  const { status, body } = await postReadJson(
    target,
    bearer,
    {
      resource: "conversation_oversight",
      workspace_id: workspaceId.toLowerCase(),
      agent_principal_id: agentPrincipalId.toLowerCase(),
    },
    options,
  );
  if (status === 200 && Array.isArray(body.conversations)) {
    return { ok: true, conversations: body.conversations as OversightConversationSummaryWire[] };
  }
  return {
    ok: false,
    status,
    error: typeof body.error === "string" ? body.error : `http_${status}`,
    message: typeof body.message === "string"
      ? body.message
      : "This conversation isn't available in this workspace.",
  };
}

export async function readOversightConversationHistory(
  target: CloudTarget,
  bearer: string,
  workspaceId: string,
  conversationId: string,
  agentPrincipalId: string,
  params: ReadConversationHistoryParams = {},
  options: ConversationReadClientOptions = {},
): Promise<
  | { ok: true; data: OversightHistoryResponse }
  | { ok: false; status: number; error: string; message: string }
> {
  const payload: Record<string, unknown> = {
    resource: "conversation_oversight_history",
    workspace_id: workspaceId.toLowerCase(),
    conversation_id: conversationId.toLowerCase(),
    agent_principal_id: agentPrincipalId.toLowerCase(),
    ...(params.before
      ? { before_created_at: params.before.created_at, before_id: params.before.id.toLowerCase() }
      : {}),
    ...(params.after
      ? { after_created_at: params.after.created_at, after_id: params.after.id.toLowerCase() }
      : {}),
    ...(params.limit !== undefined ? { limit: params.limit } : {}),
    ...(params.includeMentions !== undefined ? { include_mentions: params.includeMentions } : {}),
    ...(params.includeReactions !== undefined ? { include_reactions: params.includeReactions } : {}),
  };
  const { status, body } = await postReadJson(target, bearer, payload, options);
  if (status === 200 && body.conversation && Array.isArray(body.messages)) {
    return { ok: true, data: body as unknown as OversightHistoryResponse };
  }
  return {
    ok: false,
    status,
    error: typeof body.error === "string" ? body.error : `http_${status}`,
    message: typeof body.message === "string"
      ? body.message
      : "This conversation isn't available in this workspace.",
  };
}

export async function postConversationCommand(
  target: CloudTarget,
  bearer: string,
  workspaceId: string,
  command: Record<string, unknown>,
  options: ConversationReadClientOptions & { commandId?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(commandEndpoint(target), {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      apikey: target.anonKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      command_id: options.commandId ?? `conv_${randomUUID()}`,
      client_version: CLIENT_PROTOCOL_VERSION,
      workspace_id: workspaceId.toLowerCase(),
      stream: { kind: "workspace" },
      command,
    }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  if (text.trim().length > 0) {
    try {
      const json = JSON.parse(text);
      if (json && typeof json === "object" && !Array.isArray(json)) {
        parsed = json as Record<string, unknown>;
      }
    } catch {
      parsed = { raw: text };
    }
  }
  return { status: response.status, body: parsed };
}
