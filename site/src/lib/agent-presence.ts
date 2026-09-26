import {
  AGENT_PRESENCE_LABELS,
  classifyAgentPresence,
  type AgentPresenceRow,
} from "../../../src/cloud/agent-presence";

export interface BrowserAgentPresenceRow extends AgentPresenceRow {
  principal_id: string;
}

const nullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

/** Ignore malformed browser rows rather than hiding the rest of the roster. */
export function browserAgentPresenceRows(
  values: unknown,
): Map<string, AgentPresenceRow> {
  const result = new Map<string, AgentPresenceRow>();
  if (!Array.isArray(values)) return result;
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    if (
      typeof row.principal_id !== "string" ||
      !nullableString(row.last_command_at) ||
      !nullableString(row.client_build) ||
      !nullableString(row.watcher_at) ||
      !nullableString(row.channel_at) ||
      !nullableString(row.listener_at) ||
      !nullableString(row.turn_at) ||
      (row.last_ack_via !== null &&
        row.last_ack_via !== "leased" && row.last_ack_via !== "unclaimed") ||
      !nullableString(row.last_ack_at) ||
      !nullableString(row.current_client_build)
    ) continue;
    result.set(row.principal_id, {
      last_command_at: row.last_command_at,
      client_build: row.client_build,
      watcher_at: row.watcher_at,
      channel_at: row.channel_at,
      listener_at: row.listener_at,
      turn_at: row.turn_at,
      last_ack_via: row.last_ack_via,
      last_ack_at: row.last_ack_at,
      current_client_build: row.current_client_build,
    });
  }
  return result;
}

function escapedClientBuild(value: string | null): string | null {
  if (value === null) return null;
  const quoted = JSON.stringify(value);
  return quoted.slice(1, -1).replace(
    /[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function presenceAge(ageMs: number): string {
  const minutes = Math.max(0, Math.floor(ageMs / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** undefined means the server has no view; null means this seat has no row yet. */
export function agentPresenceLine(
  row: AgentPresenceRow | null | undefined,
  now = Date.now(),
): string | null {
  if (row === undefined) return null;
  const presence = classifyAgentPresence(row, now);
  const wake = presence.wake.route === "turn" && presence.wake.age_ms !== null
    ? `${presence.wake.label}, last ${presenceAge(presence.wake.age_ms)}`
    : presence.wake.label;
  const lastCall = presence.last_call === null
    ? `${AGENT_PRESENCE_LABELS.lastCall}: never`
    : `${presence.last_call.label}: ${presenceAge(presence.last_call.age_ms)}`;
  const clientBuild = escapedClientBuild(row?.client_build ?? null) ??
    AGENT_PRESENCE_LABELS.client.unknown;
  const clientState = presence.client.kind === "current" ||
      (presence.client.kind === "unknown" && row?.client_build == null)
    ? ""
    : ` · ${presence.client.label}`;
  return `${wake} · ${lastCall} · client build: ${clientBuild}${clientState}`;
}
