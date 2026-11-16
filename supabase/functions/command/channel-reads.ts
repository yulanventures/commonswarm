/**
 * mark_channel_read: a person moves their read position in a channel (or in general, the unfiled
 * messages) forward, so swarm_read.channel_unread stops counting what they have read.
 *
 * A person's command only. A channel the person cannot access answers exactly as an unknown one, and
 * a message they cannot read exactly as an unknown id. The position never moves backwards.
 */
import type postgres from "postgres";

type Sql = postgres.TransactionSql<Record<string, unknown>>;

export const MARK_CHANNEL_READ_KIND = "mark_channel_read";

export type MarkChannelReadCommand =
  | {
    kind: typeof MARK_CHANNEL_READ_KIND;
    /** null is general. */
    channel_id: string | null;
    /** null: everything up to now. */
    through_signal_id: string | null;
  }
  | { kind: typeof MARK_CHANNEL_READ_KIND; all: true };

export interface ChannelReadPosition {
  channel_id: string | null;
  read_through_at: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Sorts after every id, so a position with no message reads through its moment inclusive. */
const LAST_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff";

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

const nullableUuid = (value: unknown): value is string | null =>
  value === null || (typeof value === "string" && UUID_RE.test(value));

export function parseMarkChannelReadCommand(
  cmd: Record<string, unknown>,
): { ok: true; command: MarkChannelReadCommand } | { ok: false; status: 400; reason: string } {
  if (exactKeys(cmd, ["kind", "all"])) {
    return cmd.all === true
      ? { ok: true, command: { kind: MARK_CHANNEL_READ_KIND, all: true } }
      : { ok: false, status: 400, reason: "all is true" };
  }
  const keys = Object.hasOwn(cmd, "through_signal_id")
    ? ["kind", "channel_id", "through_signal_id"]
    : ["kind", "channel_id"];
  if (!exactKeys(cmd, keys) || !nullableUuid(cmd.channel_id) ||
    !nullableUuid(cmd.through_signal_id ?? null)) {
    return {
      ok: false,
      status: 400,
      reason: "mark_channel_read takes channel_id (a channel id, or null for general) and optionally " +
        "through_signal_id (a message id or null), or all: true",
    };
  }
  const through = (cmd.through_signal_id ?? null) as string | null;
  return {
    ok: true,
    command: {
      kind: MARK_CHANNEL_READ_KIND,
      channel_id: cmd.channel_id === null ? null : (cmd.channel_id as string).toLowerCase(),
      through_signal_id: through === null ? null : through.toLowerCase(),
    },
  };
}

/** Is this channel one the person can open here? Unknown and inaccessible both answer false. */
export async function personCanAccessChannel(
  tx: Sql,
  workspaceId: string,
  channelId: string,
  userId: string,
): Promise<boolean> {
  const [row] = await tx<{ ok: boolean }[]>`
    SELECT true AS ok
    FROM swarm.channels AS c
    WHERE c.workspace_id = ${workspaceId}::uuid
      AND c.channel_id = ${channelId}::uuid
      AND swarm.actor_can_access_channel(c.workspace_id, c.channel_id, 'user', ${userId}::uuid)
  `;
  return row?.ok === true;
}

/**
 * Is this a message channel_unread would count in that channel: top level, or a thread reply sent
 * to the channel too? Whether the person can read it is the caller's second question
 * (signalReactable under the person's claims). Unknown ids answer false.
 */
export async function channelFeedMessage(
  tx: Sql,
  workspaceId: string,
  channelId: string | null,
  signalId: string,
): Promise<boolean> {
  const [inChannel] = await tx<{ ok: boolean }[]>`
    SELECT true AS ok
    FROM swarm.signals AS s
    WHERE s.workspace_id = ${workspaceId}::uuid
      AND s.id = ${signalId}::uuid
      AND s.channel_id IS NOT DISTINCT FROM ${channelId}::uuid
      AND (s.thread_root_id IS NULL OR s.broadcast_to_channel)
  `;
  return inChannel?.ok === true;
}

/**
 * Move the person's position forward in each target, in one statement, and answer each target's
 * position after it. Targets: one channel (null is general), or general plus every channel the
 * person can access that is not archived. The position is the named message's own (created_at, id),
 * read in the same statement so it keeps the database's precision, or (now, none) without one. A
 * position already at or past it stays where it is.
 */
export async function advanceChannelReads(
  tx: Sql,
  workspaceId: string,
  userId: string,
  target: { all: true } | { channelId: string | null; throughSignalId: string | null },
): Promise<ChannelReadPosition[]> {
  const all = "all" in target;
  const channelId = all ? null : target.channelId;
  const throughId = all ? null : target.throughSignalId;
  const rows = await tx<ChannelReadPosition[]>`
    WITH targets AS (
      SELECT ${channelId}::uuid AS channel_id
      UNION ALL
      SELECT ch.channel_id
      FROM swarm.channels AS ch
      WHERE ${all}::boolean
        AND ch.workspace_id = ${workspaceId}::uuid
        AND ch.archived_at IS NULL
        AND swarm.actor_can_access_channel(ch.workspace_id, ch.channel_id, 'user', ${userId}::uuid)
    ),
    mark AS (
      SELECT s.created_at AS read_through_at, s.id AS read_through_id
      FROM swarm.signals AS s
      WHERE ${throughId}::uuid IS NOT NULL
        AND s.workspace_id = ${workspaceId}::uuid
        AND s.id = ${throughId}::uuid
        AND s.channel_id IS NOT DISTINCT FROM ${channelId}::uuid
      UNION ALL
      SELECT statement_timestamp(), NULL::uuid
      WHERE ${throughId}::uuid IS NULL
    ),
    advanced AS (
      INSERT INTO swarm.human_channel_reads AS r (
        workspace_id, user_id, channel_id, read_through_at, read_through_id
      )
      SELECT ${workspaceId}::uuid, ${userId}::uuid, t.channel_id, mark.read_through_at, mark.read_through_id
      FROM targets AS t CROSS JOIN mark
      ON CONFLICT (user_id, workspace_id, channel_id) DO UPDATE
        SET read_through_at = excluded.read_through_at,
          read_through_id = excluded.read_through_id,
          updated_at = statement_timestamp()
        WHERE (excluded.read_through_at, coalesce(excluded.read_through_id, ${LAST_ID}::uuid))
          > (r.read_through_at, coalesce(r.read_through_id, ${LAST_ID}::uuid))
      RETURNING r.channel_id, r.read_through_at
    )
    SELECT t.channel_id::text AS channel_id,
      to_jsonb(coalesce(advanced.read_through_at, kept.read_through_at)) #>> '{}' AS read_through_at
    FROM targets AS t
    LEFT JOIN advanced ON advanced.channel_id IS NOT DISTINCT FROM t.channel_id
    LEFT JOIN swarm.human_channel_reads AS kept
      ON kept.workspace_id = ${workspaceId}::uuid
     AND kept.user_id = ${userId}::uuid
     AND kept.channel_id IS NOT DISTINCT FROM t.channel_id
    ORDER BY t.channel_id NULLS FIRST
  `;
  return rows.map((row) => ({ channel_id: row.channel_id, read_through_at: row.read_through_at }));
}
