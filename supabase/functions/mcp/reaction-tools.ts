/**
 * The hosted react tool: what it sends and what it returns. It sends exactly add_reaction or
 * remove_reaction with signal_id and emoji, never a source: a hosted seat's automatic seen mark is
 * written by its check (command/index.ts handleHostedCheck), not through this tool.
 */
import type { CommandResult } from "../command/contract.d.ts";
import { normalizeReactionEmoji } from "../_shared/protocol.js";
// @ts-ignore TS5097: Deno requires the source extension; Node tests import this module through tsx.
import { HostedToolFailure } from "./tool-errors.ts";
// @ts-ignore TS5097: Deno requires the source extension; Node tests import this module through tsx.
import type { HostedToolArguments } from "./tools.ts";

/** The command for validated react arguments: a shortcode becomes its emoji, the id lowercase. */
export function reactionCommand(args: HostedToolArguments): {
  kind: "add_reaction" | "remove_reaction";
  signal_id: string;
  emoji: string;
} {
  const emoji = normalizeReactionEmoji(args.emoji);
  if (emoji === null) throw new HostedToolFailure("invalid_request");
  return {
    kind: args.remove === true ? "remove_reaction" : "add_reaction",
    signal_id: String(args.signal_id).toLowerCase(),
    emoji,
  };
}

/**
 * added or already_there, removed or not_there; the same outcomes the local react tool reports.
 * The message and emoji are the ones sent; only the outcome comes from the answer.
 */
export function reactionOutput(
  result: CommandResult,
  sent: { kind: "add_reaction" | "remove_reaction"; signal_id: string; emoji: string },
): Record<string, unknown> {
  if (result.status < 200 || result.status >= 300) {
    throw new HostedToolFailure(result.body.error, result.body.resets_at);
  }
  const body = result.body;
  const outcome = sent.kind === "add_reaction"
    ? body.added === true ? "added" : body.added === false ? "already_there" : null
    : body.removed === true ? "removed" : body.removed === false ? "not_there" : null;
  if (outcome === null) throw new HostedToolFailure("tool_failed");
  return { signal_id: sent.signal_id, emoji: sent.emoji, outcome };
}
