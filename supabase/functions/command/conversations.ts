/**
 * Conversations (step 2a): the commands that open, join, leave, fill and mark a conversation, and the
 * route a post_signal with conversation_id takes. Every rule lives in the database's definers
 * (20261118000005_conversations_commands.sql); this file checks the wire shape and turns each
 * definer's status into an answer. A 1:1, a group or a private channel the caller cannot read answers
 * exactly as an unknown id does.
 */
import type postgres from "postgres";

type Sql = postgres.TransactionSql<Record<string, unknown>>;

export const CONVERSATION_COMMAND_KINDS = [
  "conversation_open",
  "conversation_join",
  "conversation_leave",
  "conversation_invite",
  "conversation_remove",
  "conversation_mark_read",
  "conversation_set_notify",
] as const;
export type ConversationCommandKind = typeof CONVERSATION_COMMAND_KINDS[number];

/** A 1:1 or group holds at most nine, the caller included: the sender plus the eight-recipient cap. */
export const CONVERSATION_MEMBER_MAX = 9;
/** How many people and agents one conversation_invite may add. */
export const CONVERSATION_INVITE_MAX = 50;
export const CONVERSATION_NOTIFY_LEVELS = ["everything", "mentions", "muted"] as const;
export type ConversationNotifyLevel = typeof CONVERSATION_NOTIFY_LEVELS[number];

export interface ConversationMember {
  kind: "user" | "agent";
  id: string;
}

export type ConversationCommand =
  | { kind: "conversation_open"; members: ConversationMember[]; new_group: boolean }
  | { kind: "conversation_join" | "conversation_leave"; conversation_id: string }
  | { kind: "conversation_invite"; conversation_id: string; members: ConversationMember[] }
  | { kind: "conversation_remove"; conversation_id: string; member: ConversationMember }
  | { kind: "conversation_mark_read"; conversation_id: string; through_signal_id: string | null }
  | {
    kind: "conversation_set_notify";
    conversation_id: string;
    notify_level?: ConversationNotifyLevel;
    starred?: boolean;
    star_rank?: number | null;
  };

export type ConversationParse =
  | { ok: true; command: ConversationCommand }
  | { ok: false; status: 400; reason: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

const uuid = (value: unknown): value is string => typeof value === "string" && UUID_RE.test(value);

function member(value: unknown): ConversationMember | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (!exactKeys(entry, ["kind", "id"]) || (entry.kind !== "user" && entry.kind !== "agent") || !uuid(entry.id)) {
    return null;
  }
  return { kind: entry.kind, id: entry.id.toLowerCase() };
}

const MEMBER_RULE = 'Each member is {"kind": "user" or "agent", "id": a UUID}.';

function members(value: unknown, max: number, field: string): ConversationMember[] | string {
  if (!Array.isArray(value) || value.length === 0) return `${field} is a list of 1 to ${max} members. ${MEMBER_RULE}`;
  if (value.length > max) return `${field} is a list of 1 to ${max} members.`;
  const parsed: ConversationMember[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const one = member(entry);
    if (one === null) return MEMBER_RULE;
    const key = `${one.kind}:${one.id}`;
    if (seen.has(key)) return `${field} names the same person or agent twice.`;
    seen.add(key);
    parsed.push(one);
  }
  return parsed;
}

function refused(reason: string): ConversationParse {
  return { ok: false, status: 400, reason };
}

export function isConversationCommandKind(kind: unknown): kind is ConversationCommandKind {
  return (CONVERSATION_COMMAND_KINDS as readonly unknown[]).includes(kind);
}

export function parseConversationCommand(cmd: Record<string, unknown>): ConversationParse {
  const kind = cmd.kind;
  if (kind === "conversation_open") {
    const keys = Object.hasOwn(cmd, "new_group") ? ["kind", "members", "new_group"] : ["kind", "members"];
    if (!exactKeys(cmd, keys)) {
      return refused("conversation_open takes members (the people and agents to talk with, you may be one) and optionally new_group.");
    }
    if (Object.hasOwn(cmd, "new_group") && typeof cmd.new_group !== "boolean") return refused("new_group is true or false.");
    const list = members(cmd.members, CONVERSATION_MEMBER_MAX, "members");
    if (typeof list === "string") return refused(list);
    return { ok: true, command: { kind, members: list, new_group: cmd.new_group === true } };
  }
  if (kind === "conversation_join" || kind === "conversation_leave") {
    if (!exactKeys(cmd, ["kind", "conversation_id"]) || !uuid(cmd.conversation_id)) {
      return refused(`${kind} takes conversation_id, a UUID.`);
    }
    return { ok: true, command: { kind, conversation_id: cmd.conversation_id.toLowerCase() } };
  }
  if (kind === "conversation_invite") {
    if (!exactKeys(cmd, ["kind", "conversation_id", "members"]) || !uuid(cmd.conversation_id)) {
      return refused("conversation_invite takes conversation_id, a UUID, and members.");
    }
    const list = members(cmd.members, CONVERSATION_INVITE_MAX, "members");
    if (typeof list === "string") return refused(list);
    return { ok: true, command: { kind, conversation_id: cmd.conversation_id.toLowerCase(), members: list } };
  }
  if (kind === "conversation_remove") {
    if (!exactKeys(cmd, ["kind", "conversation_id", "member"]) || !uuid(cmd.conversation_id)) {
      return refused("conversation_remove takes conversation_id, a UUID, and member.");
    }
    const one = member(cmd.member);
    if (one === null) return refused(MEMBER_RULE);
    return { ok: true, command: { kind, conversation_id: cmd.conversation_id.toLowerCase(), member: one } };
  }
  if (kind === "conversation_mark_read") {
    const keys = Object.hasOwn(cmd, "through_signal_id")
      ? ["kind", "conversation_id", "through_signal_id"]
      : ["kind", "conversation_id"];
    const through = cmd.through_signal_id ?? null;
    if (!exactKeys(cmd, keys) || !uuid(cmd.conversation_id) || !(through === null || uuid(through))) {
      return refused("conversation_mark_read takes conversation_id, a UUID, and optionally through_signal_id (a message id, or null for now).");
    }
    return {
      ok: true,
      command: {
        kind,
        conversation_id: cmd.conversation_id.toLowerCase(),
        through_signal_id: through === null ? null : through.toLowerCase(),
      },
    };
  }
  if (kind === "conversation_set_notify") {
    const optional = ["notify_level", "starred", "star_rank"].filter((key) => Object.hasOwn(cmd, key));
    if (!exactKeys(cmd, ["kind", "conversation_id", ...optional]) || !uuid(cmd.conversation_id)) {
      return refused("conversation_set_notify takes conversation_id, a UUID, and notify_level, starred or both.");
    }
    if (!Object.hasOwn(cmd, "notify_level") && !Object.hasOwn(cmd, "starred")) {
      return refused("conversation_set_notify needs notify_level, starred or both.");
    }
    if (Object.hasOwn(cmd, "notify_level") &&
      !(CONVERSATION_NOTIFY_LEVELS as readonly unknown[]).includes(cmd.notify_level)) {
      return refused(`notify_level is ${CONVERSATION_NOTIFY_LEVELS.join(", ")}.`);
    }
    if (Object.hasOwn(cmd, "starred") && typeof cmd.starred !== "boolean") return refused("starred is true or false.");
    if (Object.hasOwn(cmd, "star_rank")) {
      const rank = cmd.star_rank;
      if (cmd.starred !== true) return refused("star_rank places a starred conversation, so it needs starred: true.");
      if (!(rank === null || (Number.isInteger(rank) && (rank as number) >= 0 && (rank as number) <= 1_000_000))) {
        return refused("star_rank is a whole number from 0, or null for last.");
      }
    }
    return {
      ok: true,
      command: {
        kind,
        conversation_id: cmd.conversation_id.toLowerCase(),
        ...(Object.hasOwn(cmd, "notify_level") ? { notify_level: cmd.notify_level as ConversationNotifyLevel } : {}),
        ...(Object.hasOwn(cmd, "starred") ? { starred: cmd.starred as boolean } : {}),
        ...(Object.hasOwn(cmd, "star_rank") ? { star_rank: cmd.star_rank as number | null } : {}),
      },
    };
  }
  return refused("unknown conversation command");
}

export type ConversationActor = { kind: "user" | "agent"; id: string };

export type ConversationOutcome =
  | { ok: true; response: Record<string, unknown>; audit_channel_ids?: string[] }
  | { ok: false; status: number; error: string; message: string; reason: string; audit_channel_ids?: string[] };

const NOT_FOUND = {
  status: 404,
  error: "conversation_not_found",
  message: "There is no conversation with that id that you can open in this workspace.",
};

function split(list: readonly ConversationMember[]): { users: string[]; agents: string[] } {
  return {
    users: list.filter((m) => m.kind === "user").map((m) => m.id),
    agents: list.filter((m) => m.kind === "agent").map((m) => m.id),
  };
}

/** A refusal for a database status. `kind` is the command, for the few sentences that differ by it. */
function refusal(status: Record<string, unknown>, kind: ConversationCommandKind): ConversationOutcome {
  const code = String(status.status);
  const channelId = typeof status.channel_id === "string" ? status.channel_id : null;
  const tagged = channelId === null ? {} : { audit_channel_ids: [channelId] };
  const no = (http: number, error: string, message: string): ConversationOutcome => ({
    ok: false, status: http, error, message, reason: code, ...tagged,
  });
  switch (code) {
    case "not_found":
      return { ok: false, ...NOT_FOUND, reason: code };
    case "forbidden":
      return kind === "conversation_remove"
        ? no(403, "forbidden", "Only the channel's creator or a workspace owner or admin can take someone out of it.")
        : no(403, "forbidden", "You aren't a live member of this workspace.");
    case "member_not_found":
      return no(403, "conversation_member_not_in_workspace", "Everyone in a conversation must belong to this workspace.");
    case "too_many":
      return no(400, "conversation_too_large",
        `A direct message or group holds at most ${CONVERSATION_MEMBER_MAX} people and agents, you included.`);
    case "member_left":
      return no(409, "conversation_member_left",
        `${String(status.name ?? "Someone")} left this group. Start a new group to message these people.`);
    case "caller_left":
      return no(409, "conversation_left", "You left this group, so you can't start it again. Someone still in it can.");
    case "private_channel":
      return no(409, "conversation_private_channel",
        "A private channel's members are managed with channel_member_add, channel_member_remove and channel_leave.");
    case "fixed_members":
      return status.kind === "dm"
        ? no(409, "conversation_members_fixed", "A direct message is always between the same two. Mute it instead.")
        : no(409, "conversation_members_fixed", "A group's members are fixed. Start a new group with everyone you want in it.");
    case "cannot_leave_dm":
      return no(409, "conversation_cannot_leave", "You can't leave a direct message. Mute it instead.");
    case "cannot_leave_general":
      return no(409, "conversation_cannot_leave", "Everyone in the workspace is in #general, so it can't be left.");
    case "everyone_in_general":
      return no(409, "conversation_members_fixed", "Everyone in the workspace is in #general already.");
    case "archived":
      return no(409, "channel_archived", "That channel is archived, so nobody joins it or is added to it.");
    case "not_a_member":
      return kind === "conversation_remove"
        ? no(409, "conversation_not_member", "They aren't in this channel.")
        : kind === "conversation_invite"
        ? no(409, "conversation_not_member", "Join the channel before you add people to it.")
        : no(409, "conversation_not_member", "Join the conversation first.");
    case "signal_not_found":
      return no(404, "signal_not_found", "There is no message with that id in that conversation that you can read.");
    default:
      throw new Error(`conversation command returned an unknown status: ${code}`);
  }
}

function tag(result: Record<string, unknown>): string[] | undefined {
  return typeof result.channel_id === "string" ? [result.channel_id] : undefined;
}

type Row = { result: Record<string, unknown> };

/** Run one conversation command as `actor` in this workspace. */
export async function applyConversationCommand(
  tx: Sql,
  workspaceId: string,
  actor: ConversationActor,
  command: ConversationCommand,
): Promise<ConversationOutcome> {
  const one = (rows: Row[]): Record<string, unknown> => {
    if (rows.length !== 1) throw new Error("a conversation command returned no result");
    return rows[0]!.result;
  };
  const ws = workspaceId;
  let result: Record<string, unknown>;
  switch (command.kind) {
    case "conversation_open": {
      const { users, agents } = split(command.members);
      result = one(await tx<Row[]>`SELECT swarm.conversation_open(${ws}::uuid, ${actor.kind}, ${actor.id}::uuid,
        ${users}::uuid[], ${agents}::uuid[], ${command.new_group}) AS result`);
      if (result.status !== "ok") return refusal(result, command.kind);
      return { ok: true, response: { conversation: result.conversation, created: result.created } };
    }
    case "conversation_join":
      result = one(await tx<Row[]>`SELECT swarm.conversation_join(${ws}::uuid, ${actor.kind}, ${actor.id}::uuid,
        ${command.conversation_id}::uuid) AS result`);
      break;
    case "conversation_leave":
      result = one(await tx<Row[]>`SELECT swarm.conversation_leave(${ws}::uuid, ${actor.kind}, ${actor.id}::uuid,
        ${command.conversation_id}::uuid) AS result`);
      break;
    case "conversation_invite": {
      const { users, agents } = split(command.members);
      result = one(await tx<Row[]>`SELECT swarm.conversation_invite(${ws}::uuid, ${actor.kind}, ${actor.id}::uuid,
        ${command.conversation_id}::uuid, ${users}::uuid[], ${agents}::uuid[]) AS result`);
      break;
    }
    case "conversation_remove":
      result = one(await tx<Row[]>`SELECT swarm.conversation_remove(${ws}::uuid, ${actor.kind}, ${actor.id}::uuid,
        ${command.conversation_id}::uuid, ${command.member.kind}, ${command.member.id}::uuid) AS result`);
      break;
    case "conversation_mark_read":
      result = one(await tx<Row[]>`SELECT swarm.conversation_mark_read(${ws}::uuid, ${actor.kind}, ${actor.id}::uuid,
        ${command.conversation_id}::uuid, ${command.through_signal_id}::uuid) AS result`);
      break;
    case "conversation_set_notify":
      result = one(await tx<Row[]>`SELECT swarm.conversation_set_notify(${ws}::uuid, ${actor.kind}, ${actor.id}::uuid,
        ${command.conversation_id}::uuid, ${command.notify_level ?? null}, ${command.starred ?? null}::boolean,
        ${command.star_rank ?? null}::integer) AS result`);
      break;
  }
  if (result.status !== "ok") return refusal(result, command.kind);
  const { status: _status, ...fields } = result;
  return {
    ok: true,
    response: { conversation_id: command.conversation_id, ...fields },
    audit_channel_ids: tag(result),
  };
}

export type ConversationPostRoute =
  | { ok: true; kind: "general" }
  | { ok: true; kind: "public_channel" | "private_channel"; channel_id: string; slug: string }
  | { ok: true; kind: "dm" | "group_dm"; to: ConversationMember[] }
  | { ok: false; status: number; error: string; message: string; reason: string };

/**
 * Where a post_signal with conversation_id goes. #general and channels post as today's `channel`
 * does. A 1:1 or group is addressed by the route rule: a person's post to every other live member; an
 * agent's group post to the live people and only the live agents it named in `to`. Takes the
 * conversation FOR SHARE until commit, as the deferred check at commit does.
 */
export async function routeConversationPost(
  tx: Sql,
  workspaceId: string,
  actor: ConversationActor,
  conversationId: string,
  named: readonly ConversationMember[],
): Promise<ConversationPostRoute> {
  const { users, agents } = split(named);
  const [row] = await tx<Row[]>`
    SELECT swarm.conversation_post_route(${workspaceId}::uuid, ${actor.kind}, ${actor.id}::uuid,
      ${conversationId}::uuid, ${users}::uuid[], ${agents}::uuid[]) AS result`;
  if (row === undefined) throw new Error("conversation_post_route returned no result");
  const result = row.result;
  const status = String(result.status);
  if (status === "not_found") return { ok: false, ...NOT_FOUND, reason: status };
  if (status === "not_in_conversation") {
    return { ok: false, status: 409, error: "conversation_not_member",
      message: "Everyone in to must be in this conversation.", reason: status };
  }
  if (status === "no_recipients") {
    return result.kind === "dm"
      ? { ok: false, status: 409, error: "conversation_no_recipients",
        message: `${String(result.name ?? "The other person")} is no longer in this workspace.`, reason: status }
      : { ok: false, status: 409, error: "conversation_no_recipients",
        message: "Nobody in this group would receive it. Name an agent in to.", reason: status };
  }
  if (status !== "ok") throw new Error(`conversation_post_route returned an unknown status: ${status}`);
  if (result.kind === "general") return { ok: true, kind: "general" };
  if (result.kind === "public_channel" || result.kind === "private_channel") {
    return { ok: true, kind: result.kind, channel_id: String(result.channel_id), slug: String(result.slug) };
  }
  const to = (result.to as Array<{ kind: "user" | "agent"; id: string }>).map((m) => ({ kind: m.kind, id: m.id }));
  return { ok: true, kind: result.kind as "dm" | "group_dm", to };
}

/** File the message just posted to a 1:1 or group in it, after its recipient rows. */
export async function prefileConversationPost(
  tx: Sql,
  workspaceId: string,
  signalId: string,
  conversationId: string,
): Promise<void> {
  await tx`SELECT swarm.conversation_prefile(${workspaceId}::uuid, ${signalId}::uuid, ${conversationId}::uuid)`;
}

/**
 * Today's path, addressed outside any channel: the name of someone who left the group this set would
 * post to, or null. The database refuses such a post at commit regardless; this says why, first.
 */
export async function departedGroupMember(
  tx: Sql,
  workspaceId: string,
  actor: ConversationActor,
  recipients: readonly ConversationMember[],
): Promise<string | null> {
  const { users, agents } = split(recipients);
  const [row] = await tx<{ name: string | null }[]>`
    SELECT swarm.conversation_group_departed(${workspaceId}::uuid, ${actor.kind}, ${actor.id}::uuid,
      ${users}::uuid[], ${agents}::uuid[]) AS name`;
  return row?.name ?? null;
}
