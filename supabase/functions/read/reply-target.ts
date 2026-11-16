/**
 * The hosted reply_target answer (read/index.ts). Pure, so the Node tests read the same mapping the
 * edge runs; the SQL that produces the row stays beside the hosted read.
 */
export interface ReplyTargetRow {
  id: string;
  thread_root_id: string | null;
  from: string;
  from_kind: string;
  /** swarm_read.channel_messages with this message as its cursor: null or an error when ineligible. */
  page: Record<string, unknown> | null;
}

/**
 * The hosted reply_target answer from one looked-up row: the thread root and the author a thread
 * reply notifies, or both null. Null whenever channel_read would not show the message (no row, no
 * page, or a page error such as cursor_not_found or channel_not_found), so every ineligible target
 * answers alike. The seat's own agent is never its own author to notify.
 */
export function replyTargetAnswer(
  row: ReplyTargetRow | undefined,
  seatPrincipalId: string,
): { thread_root_id: string | null; author: { kind: string; id: string } | null } {
  const eligible = row !== undefined && row.page !== null && typeof row.page === "object" &&
    !Object.hasOwn(row.page, "error");
  if (!eligible) return { thread_root_id: null, author: null };
  return {
    thread_root_id: row.thread_root_id ?? row.id,
    author: row.from_kind === "agent" && row.from === seatPrincipalId ? null : { kind: row.from_kind, id: row.from },
  };
}
