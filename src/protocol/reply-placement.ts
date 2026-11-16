/**
 * WHERE A REPLY GOES, decided from the message it answers. One rule for `cswarm reply`, the
 * local MCP reply tool and the hosted one. Pure and import-free, so the Deno edge imports it too.
 *
 * - A message the whole workspace can read (no recipient, not a private reply) is answered in
 *   its thread, rooted on the thread's first message, so a reply to any message inside a thread
 *   lands in that same thread.
 * - An addressed message, or a private reply, has no thread. It is answered privately.
 * - `private` (or a reply status, which only a private reply carries) answers the author
 *   privately whatever the message is.
 * - When the message could not be read, the flags decide, exactly as before this rule existed,
 *   so a message the caller can't see is refused the same way it always was.
 * - A thread reply names the answered message's author (unless that is the replier), so the
 *   author is told as a private reply would have told them (addReplyAuthorMention in
 *   mention-address.ts puts it on the wire).
 */

/** Who wrote the answered message, as a mention names them. */
export interface ReplyAuthor {
  kind: "user" | "agent";
  id: string;
}

/** The fields of the answered message this rule reads. */
export interface ReplyTarget {
  id: string;
  to?: string | null;
  to_agent?: string | null;
  in_reply_to?: string | null;
  thread_root_id?: string | null;
  recipients?: readonly unknown[] | null;
  /** "workspace" or "private" when the read edge says so; otherwise derived from the columns. */
  audience?: string | null;
  /** The author's user or principal id, and which it is. */
  from?: string | null;
  from_kind?: string | null;
}

export interface ReplyPlacementInput {
  /** The message, or null when it could not be read. */
  target: ReplyTarget | null;
  signalId: string;
  private: boolean;
  /** A reply status was asked for; it implies a private reply. */
  status: boolean;
  thread: boolean;
  broadcastToChannel: boolean;
  /** The replier. The author is not named when it is the replier; null when not known. */
  self?: ReplyAuthor | null;
}

export type ReplyPlacement =
  | { placement: "thread"; threadRootId: string; author: ReplyAuthor | null }
  | { placement: "private"; inReplyTo: string; advisory: string | null };

export class ReplyPlacementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplyPlacementError";
  }
}

/** Said when --thread was asked for on a message that has no thread. */
export const REPLY_THREAD_ADVISORY =
  "That message was addressed, so it has no thread. The reply went privately to its author.";

export const REPLY_PRIVATE_CONFLICT =
  "--private replies privately to the author, so it can't be combined with --thread or --broadcast-to-channel.";

export const REPLY_BROADCAST_ADDRESSED =
  "--broadcast-to-channel sends a thread reply to its channel, and that message was addressed, so it has no thread. Remove --broadcast-to-channel to reply privately.";

export const REPLY_BROADCAST_NEEDS_THREAD =
  "--broadcast-to-channel sends a thread reply to its channel as well, so it needs --thread";

/** True for a message everyone in its channel can read. */
export function replyTargetIsPublic(target: ReplyTarget): boolean {
  if (target.audience === "workspace") return true;
  if (target.audience === "private") return false;
  return (target.to ?? null) === null && (target.to_agent ?? null) === null &&
    (target.in_reply_to ?? null) === null && (target.recipients ?? []).length === 0;
}

/** The answered message's author, or null when the read did not say. */
export function replyTargetAuthor(target: ReplyTarget | null): ReplyAuthor | null {
  if (target === null || typeof target.from !== "string" || target.from === "") return null;
  if (target.from_kind !== "user" && target.from_kind !== "agent") return null;
  return { kind: target.from_kind, id: target.from.toLowerCase() };
}

/** Refusals that need no network. Call before reading anything. */
export function replyFlagProblem(input: { private: boolean; thread: boolean; broadcastToChannel: boolean }): string | null {
  return input.private && (input.thread || input.broadcastToChannel) ? REPLY_PRIVATE_CONFLICT : null;
}

/** True when the answered message has to be read before the reply can be placed. */
export function replyNeedsTarget(input: { private: boolean; status: boolean }): boolean {
  return !input.private && !input.status;
}

export function decideReplyPlacement(input: ReplyPlacementInput): ReplyPlacement {
  const problem = replyFlagProblem(input);
  if (problem !== null) throw new ReplyPlacementError(problem);
  const signalId = input.signalId.toLowerCase();
  const privately = (advisory: string | null = null): ReplyPlacement => ({ placement: "private", inReplyTo: signalId, advisory });
  if (!replyNeedsTarget(input)) {
    if (input.broadcastToChannel) throw new ReplyPlacementError(REPLY_BROADCAST_NEEDS_THREAD);
    return privately();
  }
  if (input.target === null) {
    if (input.thread) return { placement: "thread", threadRootId: signalId, author: null };
    if (input.broadcastToChannel) throw new ReplyPlacementError(REPLY_BROADCAST_NEEDS_THREAD);
    return privately();
  }
  if (replyTargetIsPublic(input.target)) {
    const root = input.target.thread_root_id ?? input.target.id;
    const author = replyTargetAuthor(input.target);
    const self = input.self ?? null;
    const isSelf = author !== null && self !== null && author.kind === self.kind && author.id === self.id.toLowerCase();
    return { placement: "thread", threadRootId: root.toLowerCase(), author: isSelf ? null : author };
  }
  if (input.broadcastToChannel) throw new ReplyPlacementError(REPLY_BROADCAST_ADDRESSED);
  return privately(input.thread ? REPLY_THREAD_ADVISORY : null);
}
