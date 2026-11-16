/**
 * Reactions: add or remove one emoji on a message, as a person or an agent.
 *
 * Who may react is who may read. The check is swarm.signal_reactable(), which reads the message
 * through swarm_read.signals (the read policy) under the reactor's own claims, so a private message
 * or a private channel the reactor cannot read answers exactly as an id that does not exist.
 */
import type postgres from "postgres";
import {
  normalizeReactionEmoji,
  SIGNAL_REACTION_EMOJI_RULE,
  SIGNAL_REACTION_MAX_PER_ACTOR,
} from "../_shared/protocol.js";

type Sql = postgres.TransactionSql<Record<string, unknown>>;

export const ADD_REACTION_KIND = "add_reaction";
export const REMOVE_REACTION_KIND = "remove_reaction";
export const REACTION_COMMAND_KINDS = [ADD_REACTION_KIND, REMOVE_REACTION_KIND] as const;

export interface AddReactionCommand {
  kind: typeof ADD_REACTION_KIND;
  signal_id: string;
  emoji: string;
  /** "ack" is an agent client's automatic seen mark; a person's reaction is always "manual". */
  source: "manual" | "ack";
}
export interface RemoveReactionCommand {
  kind: typeof REMOVE_REACTION_KIND;
  signal_id: string;
  emoji: string;
}
export type ReactionCommand = AddReactionCommand | RemoveReactionCommand;

export type Reactor =
  | { kind: "user"; userId: string }
  | { kind: "agent"; principalId: string; ownerUserId: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function parseReactionCommand(
  cmd: Record<string, unknown>,
): { ok: true; command: ReactionCommand } | { ok: false; status: 400; reason: string } {
  const add = cmd.kind === ADD_REACTION_KIND;
  const keys = add && Object.hasOwn(cmd, "source")
    ? ["kind", "signal_id", "emoji", "source"]
    : ["kind", "signal_id", "emoji"];
  if (!exactKeys(cmd, keys) || typeof cmd.signal_id !== "string" || !UUID_RE.test(cmd.signal_id)) {
    return {
      ok: false,
      status: 400,
      reason: `${String(cmd.kind)} takes signal_id (a message id) and emoji${add ? ", and optionally source" : ""}`,
    };
  }
  const emoji = normalizeReactionEmoji(cmd.emoji);
  if (emoji === null) return { ok: false, status: 400, reason: SIGNAL_REACTION_EMOJI_RULE };
  const signalId = cmd.signal_id.toLowerCase();
  if (!add) return { ok: true, command: { kind: REMOVE_REACTION_KIND, signal_id: signalId, emoji } };
  const source = Object.hasOwn(cmd, "source") ? cmd.source : "manual";
  if (source !== "manual" && source !== "ack") {
    return { ok: false, status: 400, reason: 'source is "manual" or "ack"' };
  }
  return { ok: true, command: { kind: ADD_REACTION_KIND, signal_id: signalId, emoji, source } };
}

/** Can this reactor read the message? Unknown and hidden ids both answer false. */
export async function signalReactable(
  tx: Sql,
  workspaceId: string,
  signalId: string,
  reactor: Reactor,
): Promise<boolean> {
  const claims = reactor.kind === "user"
    ? { sub: reactor.userId, role: "authenticated" }
    : { sub: reactor.ownerUserId, role: "authenticated", agent_principal_id: reactor.principalId };
  // The claims are this transaction's; put back whatever was there so nothing later reads ours.
  const [before] = await tx<{ claims: string | null }[]>`
    SELECT current_setting('request.jwt.claims', true) AS claims
  `;
  await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`;
  try {
    const [row] = await tx<{ readable: boolean }[]>`
      SELECT swarm.signal_reactable(${workspaceId}::uuid, ${signalId}::uuid) AS readable
    `;
    return row?.readable === true;
  } finally {
    await tx`SELECT set_config('request.jwt.claims', ${before?.claims ?? ""}, true)`;
  }
}

export type ReactionOutcome =
  | { status: "added" | "present" | "removed" | "absent" }
  | { status: "limit"; message: string };

export async function applyReaction(
  tx: Sql,
  workspaceId: string,
  command: ReactionCommand,
  reactor: Reactor,
): Promise<ReactionOutcome> {
  const user = reactor.kind === "user" ? reactor.userId : null;
  const agent = reactor.kind === "agent" ? reactor.principalId : null;
  if (command.kind === REMOVE_REACTION_KIND) {
    const removed = await tx`
      DELETE FROM swarm.signal_reactions
      WHERE workspace_id = ${workspaceId}::uuid
        AND signal_id = ${command.signal_id}::uuid
        AND emoji = ${command.emoji}
        AND actor_user_id IS NOT DISTINCT FROM ${user}::uuid
        AND actor_agent_principal_id IS NOT DISTINCT FROM ${agent}::uuid
      RETURNING reaction_id
    `;
    return { status: removed.length > 0 ? "removed" : "absent" };
  }
  try {
    // A savepoint, so the per-reactor bound's refusal leaves the transaction usable for its audit.
    const inserted = await tx.savepoint((sp) => sp`
      INSERT INTO swarm.signal_reactions (
        workspace_id, signal_id, actor_user_id, actor_agent_principal_id, emoji, source
      ) VALUES (
        ${workspaceId}::uuid, ${command.signal_id}::uuid, ${user}::uuid, ${agent}::uuid,
        ${command.emoji}, ${command.source}
      )
      ON CONFLICT DO NOTHING
      RETURNING reaction_id
    `);
    return { status: inserted.length > 0 ? "added" : "present" };
  } catch (error) {
    if ((error as { constraint_name?: string }).constraint_name === "signal_reactions_per_actor") {
      return {
        status: "limit",
        message: `You already have ${SIGNAL_REACTION_MAX_PER_ACTOR} reactions on this message. Remove one to add another.`,
      };
    }
    throw error;
  }
}
