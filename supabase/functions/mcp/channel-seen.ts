/**
 * After a hosted channel_read page, tell the command edge which messages the seat was given, so the
 * ones that mention it read as seen (👀 and Seen) and the channel-wide ones count the seat in "Seen
 * by N of M agents". The edge re-derives both sets under the seat's own claims; this side only sends
 * the ids. Best effort: the page is returned as it is whatever happens here.
 */
import type { CommandResult, HostedCommandInput } from "../command/contract.d.ts";

export const HOSTED_CHANNEL_READ_SEEN_KIND = "mark_hosted_channel_read_seen";
/** One page holds at most 50 messages, the same bound signals_seen takes. */
export const HOSTED_CHANNEL_READ_SEEN_MAX = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** The command for the messages a delivered page returned, or null when there is nothing to mark. */
export function channelReadSeenCommand(
  messages: readonly Record<string, unknown>[],
  workspaceId: string,
  seat: string,
): HostedCommandInput | null {
  const ids = [...new Set(messages
    .map((message) => message.signal_id)
    .filter((id): id is string => typeof id === "string" && UUID_RE.test(id))
    .map((id) => id.toLowerCase()))].slice(0, HOSTED_CHANNEL_READ_SEEN_MAX);
  if (ids.length === 0) return null;
  return {
    // A fresh id per page, as check uses: this writes no ledger row to replay.
    command_id: `mcpseen_${crypto.randomUUID()}`,
    client_version: "0.1.80",
    workspace_id: workspaceId,
    stream: { kind: "workspace" },
    command: { kind: HOSTED_CHANNEL_READ_SEEN_KIND, seat, signal_ids: ids },
  };
}

/**
 * Send the page's seen command with a `check` capability, the tool whose own write a seen mark is.
 * Returns whether the edge accepted it. Never throws: a missing capability, a refusal or an error
 * leaves the page unmarked and is logged without any id.
 */
export async function markChannelReadSeen<Capability>(
  messages: readonly Record<string, unknown>[],
  workspaceId: string,
  seat: string,
  capability: () => Promise<Capability | null>,
  send: (input: HostedCommandInput, capability: Capability) => Promise<CommandResult>,
): Promise<boolean> {
  const input = channelReadSeenCommand(messages, workspaceId, seat);
  if (input === null) return false;
  try {
    const granted = await capability();
    if (granted === null) return false;
    const result = await send(input, granted);
    if (result.status === 200) return true;
    console.error(JSON.stringify({ event: "hosted_channel_read_seen_refused", status: result.status }));
    return false;
  } catch {
    console.error(JSON.stringify({ event: "hosted_channel_read_seen_failed" }));
    return false;
  }
}
