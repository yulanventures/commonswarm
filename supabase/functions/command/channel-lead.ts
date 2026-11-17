/**
 * set_channel_lead: a person who can manage a channel chooses who an untagged top-level person post
 * in it wakes: the workspace lead ("workspace", the default), one agent ("agent"), or nobody
 * ("none"). The command edge runs it on the channel-command path (lock, uniform 404, manager rule);
 * this module is its exact shape.
 */

export const SET_CHANNEL_LEAD_KIND = "set_channel_lead";
export const CHANNEL_LEAD_MODES = ["workspace", "agent", "none"] as const;
export type ChannelLeadMode = typeof CHANNEL_LEAD_MODES[number];

export interface SetChannelLeadCommand {
  kind: typeof SET_CHANNEL_LEAD_KIND;
  channel_id: string;
  lead_mode: ChannelLeadMode;
  /** The agent for "agent"; null otherwise. */
  principal_id: string | null;
}

/* The same sentences commandFieldsMessage and CHANNEL_ID_RULE_TEXT (_shared/channels.ts) build; kept
 * literal so this module imports nothing, and pinned to them by tests/channel-leads.test.ts. */
export const SET_CHANNEL_LEAD_FIELDS_TEXT =
  "set_channel_lead takes channel_id and lead_mode, and optionally principal_id, and nothing else.";
export const SET_CHANNEL_LEAD_ID_RULE_TEXT = "channel_id must be a UUID.";
export const CHANNEL_LEAD_MODE_RULE_TEXT = `lead_mode is one of ${CHANNEL_LEAD_MODES.join(", ")}.`;
export const CHANNEL_LEAD_PRINCIPAL_RULE_TEXT =
  'principal_id is the agent\'s id when lead_mode is "agent", and absent or null otherwise.';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** Exact keys; ids lowercased and an absent principal_id stored as null, so each setting has one hash. */
export function parseSetChannelLeadCommand(
  cmd: Record<string, unknown>,
): { ok: true; command: SetChannelLeadCommand } | { ok: false; status: 400; reason: string } {
  const keysOk = exactKeys(cmd, ["kind", "channel_id", "lead_mode", ...(Object.hasOwn(cmd, "principal_id") ? ["principal_id"] : [])]);
  const idOk = typeof cmd.channel_id === "string" && UUID_RE.test(cmd.channel_id);
  if (!keysOk || !idOk) {
    return {
      ok: false,
      status: 400,
      reason: !keysOk ? SET_CHANNEL_LEAD_FIELDS_TEXT : SET_CHANNEL_LEAD_ID_RULE_TEXT,
    };
  }
  if (typeof cmd.lead_mode !== "string" || !(CHANNEL_LEAD_MODES as readonly string[]).includes(cmd.lead_mode)) {
    return { ok: false, status: 400, reason: CHANNEL_LEAD_MODE_RULE_TEXT };
  }
  const principal = cmd.principal_id ?? null;
  if (
    cmd.lead_mode === "agent"
      ? typeof principal !== "string" || !UUID_RE.test(principal)
      : principal !== null
  ) {
    return { ok: false, status: 400, reason: CHANNEL_LEAD_PRINCIPAL_RULE_TEXT };
  }
  return {
    ok: true,
    command: {
      kind: SET_CHANNEL_LEAD_KIND,
      channel_id: (cmd.channel_id as string).toLowerCase(),
      lead_mode: cmd.lead_mode as ChannelLeadMode,
      principal_id: typeof principal === "string" ? principal.toLowerCase() : null,
    },
  };
}
