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
  SIGNAL_REACTION_SEEN,
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

/** Seen marks one hosted check may write: the same courtesy bound as an agent client's. */
export const HOSTED_SEEN_MARK_MAX = 20;

/**
 * The returned check rows a hosted seat marks seen with 👀: an ask or a note it did not write. Every
 * row a hosted check returns already reaches the seat (addressed to it or mentioning it), and a
 * reaction note is never one of them (only the read edge writes those). Unique, in order, bounded.
 */
export function hostedSeenAckTargets(
  rows: readonly Record<string, unknown>[],
  principalId: string,
  limit = HOSTED_SEEN_MARK_MAX,
): string[] {
  const ids = rows.filter((row) =>
    (row.kind === "ask" || row.kind === "note") &&
    !(row.from_kind === "agent" && String(row.from).toLowerCase() === principalId.toLowerCase()) &&
    typeof row.id === "string" && UUID_RE.test(row.id)
  ).map((row) => String(row.id).toLowerCase());
  return [...new Set(ids)].slice(0, limit);
}

/**
 * Mark what a hosted check returned as seen: one 👀 (source "ack") by the seat's agent on each
 * target, in the check's own transaction, after its batch is decided and read. Best effort: a
 * savepoint holds the write, any failure rolls back only that and is logged by SQLSTATE alone, and
 * the check's result and acknowledgement never change. The caller has installed the seat's claims
 * (its owner's sub plus agent_principal_id), so swarm.signal_reactable() answers for this agent
 * exactly as it does for its react command. A message already marked, or already at the 64 bound,
 * is skipped rather than refused, so one full message never costs the others their mark.
 */
export async function markHostedCheckSeen(
  tx: Sql,
  workspaceId: string,
  principalId: string,
  rows: readonly Record<string, unknown>[],
): Promise<number> {
  const ids = hostedSeenAckTargets(rows, principalId);
  if (ids.length === 0) return 0;
  try {
    const [before] = await tx<{ lock_timeout: string }[]>`SELECT current_setting('lock_timeout') AS lock_timeout`;
    const inserted = await tx.savepoint(async (sp) => {
      // Never hold the check long behind a concurrent reaction by the same agent on the same message.
      await sp`SELECT set_config('lock_timeout', '1s', true)`;
      return await sp<{ reaction_id: string }[]>`
        INSERT INTO swarm.signal_reactions (
          workspace_id, signal_id, actor_agent_principal_id, emoji, source
        )
        SELECT ${workspaceId}::uuid, target.id, ${principalId}::uuid, ${SIGNAL_REACTION_SEEN}, 'ack'
        FROM unnest(${ids}::uuid[]) AS target(id)
        WHERE swarm.signal_reactable(${workspaceId}::uuid, target.id)
          AND NOT EXISTS (
            SELECT 1 FROM swarm.signal_reactions AS r
            WHERE r.workspace_id = ${workspaceId}::uuid
              AND r.signal_id = target.id
              AND r.actor_agent_principal_id = ${principalId}::uuid
              AND r.emoji = ${SIGNAL_REACTION_SEEN}
          )
          AND (
            SELECT count(*) FROM swarm.signal_reactions AS r
            WHERE r.workspace_id = ${workspaceId}::uuid
              AND r.signal_id = target.id
              AND r.actor_agent_principal_id = ${principalId}::uuid
          ) < ${SIGNAL_REACTION_MAX_PER_ACTOR}
        ON CONFLICT DO NOTHING
        RETURNING reaction_id
      `;
    });
    await tx`SELECT set_config('lock_timeout', ${before?.lock_timeout ?? "5s"}, true)`;
    return inserted.length;
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    console.error(JSON.stringify({
      event: "hosted_check_seen_mark_failed",
      sqlstate: typeof code === "string" && /^[0-9A-Z]{5}$/u.test(code) ? code : null,
    }));
    return 0;
  }
}
