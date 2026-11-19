/**
 * resolve_system_alert: a live lead agent (for the alert's channel or workspace) or a workspace
 * owner/admin with scope access marks a system alert resolved with a short note.
 */

export const RESOLVE_SYSTEM_ALERT_KIND = "resolve_system_alert";
export const SYSTEM_ALERT_KINDS = [
  "agent_quiet",
  "local_renewal_superseded",
  "local_credential_revoked",
  "hosted_seat_refused",
  "hosted_family_retired",
] as const;
export type SystemAlertKind = typeof SYSTEM_ALERT_KINDS[number];

export interface ResolveSystemAlertCommand {
  kind: typeof RESOLVE_SYSTEM_ALERT_KIND;
  alert_id: string;
  note: string;
}

export const RESOLVE_SYSTEM_ALERT_FIELDS_TEXT =
  "resolve_system_alert takes alert_id and note, and nothing else.";
export const RESOLVE_SYSTEM_ALERT_ID_RULE_TEXT = "alert_id must be a UUID.";
export const RESOLVE_SYSTEM_ALERT_NOTE_RULE_TEXT =
  "note must be 1 to 500 non-control characters.";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL_RE = /[\u0000-\u001f\u007f]/u;

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function parseResolveSystemAlertCommand(
  cmd: Record<string, unknown>,
): { ok: true; command: ResolveSystemAlertCommand } | { ok: false; status: 400; reason: string } {
  if (!exactKeys(cmd, ["kind", "alert_id", "note"])) {
    return { ok: false, status: 400, reason: RESOLVE_SYSTEM_ALERT_FIELDS_TEXT };
  }
  if (typeof cmd.alert_id !== "string" || !UUID_RE.test(cmd.alert_id)) {
    return { ok: false, status: 400, reason: RESOLVE_SYSTEM_ALERT_ID_RULE_TEXT };
  }
  if (typeof cmd.note !== "string") {
    return { ok: false, status: 400, reason: RESOLVE_SYSTEM_ALERT_NOTE_RULE_TEXT };
  }
  const note = cmd.note.trim();
  if (note.length < 1 || note.length > 500 || CONTROL_RE.test(note)) {
    return { ok: false, status: 400, reason: RESOLVE_SYSTEM_ALERT_NOTE_RULE_TEXT };
  }
  return {
    ok: true,
    command: {
      kind: RESOLVE_SYSTEM_ALERT_KIND,
      alert_id: cmd.alert_id.toLowerCase(),
      note,
    },
  };
}
