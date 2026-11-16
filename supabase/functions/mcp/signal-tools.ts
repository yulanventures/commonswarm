/**
 * The hosted ask, note, reply and working_on tools: the post_signal each one sends. Pure, so the
 * Node tests read the same mapping the edge runs. The edge does the two reads first: the members
 * roster when a mention has to be resolved, and the reply's target when a reply has to be placed.
 */
// @ts-ignore TS5097: Deno requires the source extension; Node tests import this module through tsx.
import { addReplyAuthorMention, bodyMayMention, MentionResolutionError, replyAuthorMentionRefused, replyAuthorNotNotified, replyRetryCommandId, resolveMentions, withoutReplyAuthor, type MentionRosterEntry, type WireMention } from "../../../src/protocol/mention-address.ts";
// @ts-ignore TS5097: Deno requires the source extension; Node tests import this module through tsx.
import { decideReplyPlacement, type ReplyAuthor, type ReplyPlacement } from "../../../src/protocol/reply-placement.ts";
// @ts-ignore TS5097: Deno requires the source extension; Node tests import this module through tsx.
import { hostedChoiceOptions, type HostedToolArguments } from "./tools.ts";

export { MentionResolutionError };

export type HostedSignalTool = "ask" | "note" | "reply" | "working_on";

function recipientsOf(args: HostedToolArguments): Array<{ kind: "user" | "agent"; id: string }> | null {
  return Array.isArray(args.recipients) ? args.recipients as Array<{ kind: "user" | "agent"; id: string }> : null;
}

function mentionSelectors(args: HostedToolArguments): string[] {
  return Array.isArray(args.mentions) ? (args.mentions as unknown[]).map(String) : [];
}

/** True for an ask with options or choices: one ask_choice, which carries no mentions. */
export function hostedChoiceAsk(name: HostedSignalTool, args: HostedToolArguments): boolean {
  return name === "ask" && (args.options !== undefined || args.choices !== undefined);
}

/** True when this call can carry mentions: a public ask or note, or any reply not forced private. */
function mayCarryMentions(name: HostedSignalTool, args: HostedToolArguments): boolean {
  if (name === "working_on" || hostedChoiceAsk(name, args)) return false;
  if (name === "reply") return args.private !== true;
  return recipientsOf(args) === null;
}

/** True when the members roster must be read before the command can be built. */
export function hostedNeedsRoster(name: HostedSignalTool, args: HostedToolArguments): boolean {
  if (!mayCarryMentions(name, args)) return false;
  return mentionSelectors(args).length > 0 || bodyMayMention(String(args.body ?? ""));
}

/** True when a reply's target must be read to place it. */
export function hostedNeedsReplyTarget(name: HostedSignalTool, args: HostedToolArguments): boolean {
  return name === "reply" && args.private !== true;
}

/** The members read's rows, as the shared resolver takes them. */
export function hostedRoster(output: Record<string, unknown>): MentionRosterEntry[] {
  const rows: MentionRosterEntry[] = [];
  for (const value of Array.isArray(output.members) ? output.members : []) {
    const row = value as Record<string, unknown>;
    if (typeof row.user_id === "string") rows.push({ kind: "user", id: row.user_id, name: typeof row.display_name === "string" ? row.display_name : null });
  }
  for (const value of Array.isArray(output.agents) ? output.agents : []) {
    const row = value as Record<string, unknown>;
    if (typeof row.principal_id === "string") rows.push({ kind: "agent", id: row.principal_id, name: typeof row.name === "string" ? row.name : null });
  }
  return rows;
}

/**
 * Where a hosted reply goes. `threadRootId` is what the reply_target read answered: the thread's
 * root for a message everyone in its channel can read, or null for anything else, including a
 * message the seat can't read. null keeps the reply private, refused exactly as before. `author` is
 * the message's author as the read answered it; the read leaves out the seat's own agent.
 */
export function hostedReplyPlacement(
  args: HostedToolArguments,
  threadRootId: string | null,
  author: ReplyAuthor | null = null,
): ReplyPlacement {
  const signalId = String(args.signal_id).toLowerCase();
  return decideReplyPlacement({
    target: args.private === true || threadRootId === null
      ? null
      : { id: signalId, thread_root_id: threadRootId, audience: "workspace", from: author?.id ?? null, from_kind: author?.kind ?? null },
    signalId,
    private: args.private === true,
    status: false,
    thread: false,
    broadcastToChannel: false,
  });
}

/**
 * The mentions a call sends: a thread reply's author first (see addReplyAuthorMention), then the
 * resolved ones. Throws MentionResolutionError when a mention can't be honoured, and when explicit
 * mentions were given on a reply that turned out private.
 */
export function hostedMentions(
  name: HostedSignalTool,
  args: HostedToolArguments,
  roster: readonly MentionRosterEntry[] | null,
  placement: ReplyPlacement | null,
): WireMention[] {
  if (!mayCarryMentions(name, args)) return [];
  if (name === "reply" && placement?.placement !== "thread") {
    if (mentionSelectors(args).length > 0) {
      throw new MentionResolutionError("mention_private_reply");
    }
    return [];
  }
  const explicit = roster === null ? [] : resolveMentions({ body: String(args.body ?? ""), selectors: mentionSelectors(args), roster });
  if (name !== "reply" || placement?.placement !== "thread") return explicit;
  return addReplyAuthorMention(explicit, placement.author).mentions;
}

/** The implicit author the reply added, or null when it added none (absent, or also named explicitly). */
export function hostedImplicitAuthor(
  args: HostedToolArguments,
  roster: readonly MentionRosterEntry[] | null,
  placement: ReplyPlacement | null,
): ReplyAuthor | null {
  if (placement?.placement !== "thread" || placement.author === null) return null;
  const explicit = roster === null ? [] : resolveMentions({ body: String(args.body ?? ""), selectors: mentionSelectors(args), roster });
  return addReplyAuthorMention(explicit, placement.author).authorAdded ? placement.author : null;
}

/**
 * Send a hosted signal, and for a thread reply whose implicit author mention the edge refused (a
 * bare 403 for an author no longer live, or 409 mention_hop_limit), send it once more without that
 * mention under a derived request id. The answer then says the author was not notified.
 */
export async function sendHostedSignal<R extends { status: number; body: Record<string, unknown> }>(
  name: HostedSignalTool,
  args: HostedToolArguments,
  workspaceId: string,
  resolved: { mentions: readonly WireMention[]; placement: ReplyPlacement | null; implicitAuthor: ReplyAuthor | null },
  send: (input: ReturnType<typeof hostedSignalCommand>) => Promise<R>,
): Promise<{ result: R; authorNotNotified: string | null }> {
  const first = await send(hostedSignalCommand(name, args, workspaceId, resolved));
  const code = typeof first.body.error === "string" ? first.body.error : null;
  if (resolved.implicitAuthor === null || !replyAuthorMentionRefused(first.status, code)) {
    return { result: first, authorNotNotified: null };
  }
  const result = await send(hostedSignalCommand(name, { ...args, request_id: replyRetryCommandId(String(args.request_id)) }, workspaceId,
    { mentions: withoutReplyAuthor(resolved.mentions, resolved.implicitAuthor), placement: resolved.placement }));
  return { result, authorNotNotified: replyAuthorNotNotified(code) };
}

export function hostedSignalCommand(
  name: HostedSignalTool,
  args: HostedToolArguments,
  workspaceId: string,
  resolved: { mentions?: readonly WireMention[]; placement?: ReplyPlacement | null } = {},
) {
  const addressed = recipientsOf(args);
  /* An ask with choices is one ask_choice: to the one person named, or to nobody so that anyone
   * who reads it may answer. The command edge admits it only from this tool, and it takes no
   * mentions (validateHostedToolArguments refuses them). */
  if (hostedChoiceAsk(name, args)) {
    return {
      command_id: args.request_id,
      client_version: "0.1.80",
      workspace_id: workspaceId,
      stream: { kind: "workspace" },
      command: {
        kind: "ask_choice",
        body: args.body,
        to_user_id: addressed === null ? null : addressed[0]!.id.toLowerCase(),
        about: null,
        options: hostedChoiceOptions(args),
        ...(args.multi === true ? { multi: true } : {}),
        ...(typeof args.channel === "string" && args.channel.toLowerCase() !== "general"
          ? { channel: args.channel.toLowerCase() } : {}),
      },
    };
  }
  const attached = name !== "working_on" && Array.isArray(args.attachments)
    ? (args.attachments as Array<{ file_id: string; version_n: number }>)
      .map((row) => ({ file_id: row.file_id.toLowerCase(), version_n: row.version_n }))
    : null;
  const placement = name === "reply"
    ? resolved.placement ?? { placement: "private" as const, inReplyTo: String(args.signal_id).toLowerCase(), advisory: null }
    : null;
  const mentions = resolved.mentions ?? [];
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
      in_reply_to: placement?.placement === "private" ? placement.inReplyTo : null,
      about: null,
      // "general" is the unfiled main channel: no channel key at all.
      ...(name !== "reply" && typeof args.channel === "string" && args.channel.toLowerCase() !== "general"
        ? { channel: args.channel.toLowerCase() } : {}),
      ...(placement?.placement === "thread" ? { thread_root_id: placement.threadRootId } : {}),
      ...(addressed === null ? {} : { to: addressed }),
      ...(mentions.length === 0 ? {} : { mentions: mentions.map((row) => ({ kind: row.kind, id: row.id })) }),
      ...(attached === null ? {} : { attachments: attached }),
    },
  };
}
