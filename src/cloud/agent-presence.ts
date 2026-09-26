import { compareSemVer } from "../host/version.js";
import { WAKE_LEASE_STALE_MS } from "./wake-lease-constants.js";

export const AGENT_PRESENCE_LABELS = Object.freeze({
  wake: Object.freeze({
    live: "live",
    stale: "stale",
    turn: "turn",
    none: "none",
  }),
  lastCall: "last call",
  lastAck: "last ACK",
  client: Object.freeze({
    current: "current",
    updateAvailable: "update available",
    unknown: "unknown",
  }),
});

export type AgentPresencePushRoute = "watcher" | "channel" | "listener";
export type AgentPresenceWakeKind =
  | `live ${AgentPresencePushRoute}`
  | `stale ${AgentPresencePushRoute}`
  | "turn"
  | "none";
export type AgentPresenceClientKind = "current" | "update available" | "unknown";

export interface AgentPresenceRow {
  last_command_at: string | null;
  client_build: string | null;
  watcher_at: string | null;
  channel_at: string | null;
  listener_at: string | null;
  turn_at: string | null;
  last_ack_via: "leased" | "unclaimed" | null;
  last_ack_at: string | null;
  current_client_build: string | null;
}

export interface ClassifiedAgentPresence {
  wake: {
    kind: AgentPresenceWakeKind;
    route: AgentPresencePushRoute | "turn" | null;
    age_ms: number | null;
    label: string;
  };
  last_call: { age_ms: number; label: string } | null;
  last_ack: {
    route: AgentPresenceRow["last_ack_via"];
    age_ms: number;
    label: string;
  } | null;
  client: { kind: AgentPresenceClientKind; label: string };
}

function ageMs(value: string | null, now: number): number | null {
  if (value === null) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, now - timestamp) : null;
}

function clientKind(row: AgentPresenceRow | null): AgentPresenceClientKind {
  if (row?.current_client_build === null || row === null) return "unknown";
  // A row that predates the first recorded command cannot establish which
  // client build made that call, even after a current build is configured.
  if (row.last_command_at === null) return "unknown";
  if (row.client_build === null) {
    return "update available";
  }
  try {
    return compareSemVer(row.client_build, row.current_client_build) < 0
      ? "update available"
      : "current";
  } catch {
    return "unknown";
  }
}

/** Classify raw presence facts without reading clocks, files, or the network. */
export function classifyAgentPresence(
  row: AgentPresenceRow | null,
  now: number,
): ClassifiedAgentPresence {
  const client = clientKind(row);
  if (row === null) {
    return {
      wake: { kind: "none", route: null, age_ms: null, label: AGENT_PRESENCE_LABELS.wake.none },
      last_call: null,
      last_ack: null,
      client: { kind: client, label: AGENT_PRESENCE_LABELS.client.unknown },
    };
  }

  const push = (["watcher", "channel", "listener"] as const)
    .map(route => ({ route, age: ageMs(row[`${route}_at`], now) }))
    .filter((entry): entry is { route: AgentPresencePushRoute; age: number } =>
      entry.age !== null)
    .sort((left, right) => left.age - right.age)[0];

  let wake: ClassifiedAgentPresence["wake"];
  if (push) {
    const state = push.age <= WAKE_LEASE_STALE_MS ? "live" : "stale";
    const kind = `${state} ${push.route}` as AgentPresenceWakeKind;
    wake = {
      kind,
      route: push.route,
      age_ms: push.age,
      label: `${AGENT_PRESENCE_LABELS.wake[state]} ${push.route}`,
    };
  } else {
    const turnAge = ageMs(row.turn_at, now);
    wake = turnAge === null
      ? { kind: "none", route: null, age_ms: null, label: AGENT_PRESENCE_LABELS.wake.none }
      : { kind: "turn", route: "turn", age_ms: turnAge, label: AGENT_PRESENCE_LABELS.wake.turn };
  }

  const callAge = ageMs(row.last_command_at, now);
  const ackAge = ageMs(row.last_ack_at, now);
  const clientLabel = client === "update available"
    ? AGENT_PRESENCE_LABELS.client.updateAvailable
    : AGENT_PRESENCE_LABELS.client[client];
  return {
    wake,
    last_call: callAge === null ? null : { age_ms: callAge, label: AGENT_PRESENCE_LABELS.lastCall },
    last_ack: ackAge === null ? null : {
      route: row.last_ack_via,
      age_ms: ackAge,
      label: AGENT_PRESENCE_LABELS.lastAck,
    },
    client: { kind: client, label: clientLabel },
  };
}
