/**
 * System alerts cloud client: read authorized seat-health alerts (for live leads, owners/admins,
 * or owner escalated inbox) and build resolve_system_alert wire commands.
 */
import type { CloudTarget } from "./config.js";

export interface SystemAlertRecord {
  alert_id: string;
  workspace_id: string;
  channel_id: string | null;
  kind: string;
  affected_principal_id: string;
  affected_seat_name: string;
  fix_hint: string;
  waiting_count: number | null;
  oldest_waiting_at: string | null;
  routed_lead_principal_id: string | null;
  routed_at?: string | null;
  opened_at: string;
  escalate_after?: string | null;
  escalated_at: string | null;
  resolved_at?: string | null;
  resolved_by_kind?: string | null;
  resolved_by_id?: string | null;
  resolution_note?: string | null;
  was_escalated?: boolean;
}

export interface SystemAlertsReadResult {
  alerts: SystemAlertRecord[];
  total?: number;
  truncated?: boolean;
}

export interface ResolveSystemAlertCommandWire {
  kind: "resolve_system_alert";
  alert_id: string;
  note: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL_RE = /[\u0000-\u001f\u007f]/u;

export function resolveSystemAlertCommand(
  alertId: string,
  note: string,
): ResolveSystemAlertCommandWire {
  const normalizedId = alertId.trim().toLowerCase();
  if (!UUID_RE.test(normalizedId)) {
    throw new Error("alert_id must be a UUID");
  }
  const trimmedNote = note.trim();
  if (trimmedNote.length < 1 || trimmedNote.length > 500 || CONTROL_RE.test(trimmedNote)) {
    throw new Error("resolution note must be 1 to 500 non-control characters");
  }
  return {
    kind: "resolve_system_alert",
    alert_id: normalizedId,
    note: trimmedNote,
  };
}

export async function readSystemAlerts(
  target: CloudTarget,
  token: string,
  workspaceId: string,
  options: { includeResolved?: boolean; escalatedOnly?: boolean; fetcher?: typeof fetch } = {},
): Promise<SystemAlertsReadResult> {
  const fetcher = options.fetcher ?? fetch;
  const endpoint = `${target.url.replace(/\/+$/, "")}/functions/v1/read`;
  const response = await fetcher(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      apikey: target.anonKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      resource: "system_alerts",
      workspace_id: workspaceId,
      ...(options.includeResolved === true ? { include_resolved: true } : {}),
      ...(options.escalatedOnly === true ? { escalated_only: true } : {}),
    }),
  });
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    const message = typeof body?.message === "string"
      ? body.message
      : typeof body?.error === "string"
      ? body.error
      : `system alerts read failed (${response.status})`;
    throw new Error(message);
  }
  if (!body || !Array.isArray(body.alerts)) {
    throw new Error("system alerts read returned malformed JSON");
  }
  return {
    alerts: body.alerts as SystemAlertRecord[],
    ...(typeof body.total === "number" ? { total: body.total } : {}),
    ...(typeof body.truncated === "boolean" ? { truncated: body.truncated } : {}),
  };
}
