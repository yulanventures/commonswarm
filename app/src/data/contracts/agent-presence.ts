// Copied from src/cloud/agent-presence.ts, src/cloud/wake-lease-constants.ts,
// src/cloud/idle-poll.ts, src/host/version.ts (compareSemVer only, without NodeJS.Signals),
// and site/src/lib/agent-presence.ts at commit 1cbfcccfde5e68a6db19272ee504d66a25a66fc9.

export const WAKE_LEASE_RENEW_MS = 60_000;
export const WAKE_LEASE_STALE_MS = 3 * WAKE_LEASE_RENEW_MS;
export const IDLE_POLL_MAX_MS = 60_000;
export const WAKE_STALE_MULTIPLE = 3;
export const WAKE_STALE_MS = IDLE_POLL_MAX_MS * WAKE_STALE_MULTIPLE;

const CORE_IDENTIFIER = '(?:0|[1-9]\\d*)';
const PRERELEASE_IDENTIFIER = '(?:0|[1-9]\\d*|[A-Za-z-][0-9A-Za-z-]*)';
const BUILD_IDENTIFIER = '[0-9A-Za-z-]+';
const SEMVER_SOURCE =
  `${CORE_IDENTIFIER}\\.${CORE_IDENTIFIER}\\.${CORE_IDENTIFIER}` +
  `(?:-${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*)?` +
  `(?:\\+${BUILD_IDENTIFIER}(?:\\.${BUILD_IDENTIFIER})*)?`;
const SEMVER_RE = new RegExp(`^${SEMVER_SOURCE}$`);

type ParsedSemVer = {
  core: [bigint, bigint, bigint];
  prerelease: string[] | null;
};

function parseSemVer(value: string): ParsedSemVer | null {
  if (!SEMVER_RE.test(value)) return null;
  const withoutBuild = value.split('+', 1)[0]!;
  const dash = withoutBuild.indexOf('-');
  const coreText = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash);
  const prereleaseText = dash === -1 ? null : withoutBuild.slice(dash + 1);
  const coreParts = coreText.split('.');
  if (coreParts.length !== 3) return null;
  return {
    core: [BigInt(coreParts[0]!), BigInt(coreParts[1]!), BigInt(coreParts[2]!)],
    prerelease: prereleaseText === null ? null : prereleaseText.split('.'),
  };
}

function compareSemVer(left: string, right: string): -1 | 0 | 1 {
  const a = parseSemVer(left);
  const b = parseSemVer(right);
  if (!a || !b) {
    throw new Error(
      `cannot compare invalid semantic versions: ${JSON.stringify(left)} and ${JSON.stringify(right)}`,
    );
  }
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index]! < b.core[index]!) return -1;
    if (a.core[index]! > b.core[index]!) return 1;
  }
  if (a.prerelease === null && b.prerelease === null) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      return BigInt(leftPart) < BigInt(rightPart) ? -1 : 1;
    }
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

export const AGENT_PRESENCE_LABELS = Object.freeze({
  wake: Object.freeze({
    live: 'live',
    stale: 'stale',
    turn: 'turn',
    none: 'none',
  }),
  lastCall: 'last call',
  lastAck: 'last ACK',
  client: Object.freeze({
    current: 'current',
    updateAvailable: 'update available',
    unknown: 'unknown',
  }),
});

export type AgentPresencePushRoute = 'watcher' | 'channel' | 'listener';
export type AgentPresenceWakeKind =
  | `live ${AgentPresencePushRoute}`
  | `stale ${AgentPresencePushRoute}`
  | 'turn'
  | 'none';
export type AgentPresenceClientKind =
  | 'current'
  | 'update available'
  | 'unknown';

export interface AgentPresenceRow {
  last_command_at: string | null;
  client_build: string | null;
  watcher_at: string | null;
  channel_at: string | null;
  listener_at: string | null;
  turn_at: string | null;
  last_ack_via: 'leased' | 'unclaimed' | null;
  last_ack_at: string | null;
  current_client_build: string | null;
}

export interface ClassifiedAgentPresence {
  wake: {
    kind: AgentPresenceWakeKind;
    route: AgentPresencePushRoute | 'turn' | null;
    age_ms: number | null;
    label: string;
  };
  last_call: { age_ms: number; label: string } | null;
  last_ack: {
    route: AgentPresenceRow['last_ack_via'];
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
  if (row?.current_client_build === null || row === null) return 'unknown';
  if (row.last_command_at === null) return 'unknown';
  if (row.client_build === null) {
    return 'update available';
  }
  try {
    return compareSemVer(row.client_build, row.current_client_build) < 0
      ? 'update available'
      : 'current';
  } catch {
    return 'unknown';
  }
}

export function classifyAgentPresence(
  row: AgentPresenceRow | null,
  now: number,
): ClassifiedAgentPresence {
  const client = clientKind(row);
  if (row === null) {
    return {
      wake: {
        kind: 'none',
        route: null,
        age_ms: null,
        label: AGENT_PRESENCE_LABELS.wake.none,
      },
      last_call: null,
      last_ack: null,
      client: { kind: client, label: AGENT_PRESENCE_LABELS.client.unknown },
    };
  }

  const push = (['watcher', 'channel', 'listener'] as const)
    .map((route) => ({ route, age: ageMs(row[`${route}_at`], now) }))
    .filter(
      (entry): entry is { route: AgentPresencePushRoute; age: number } =>
        entry.age !== null,
    )
    .sort((left, right) => left.age - right.age)[0];

  let wake: ClassifiedAgentPresence['wake'];
  if (push) {
    const state = push.age <= WAKE_LEASE_STALE_MS ? 'live' : 'stale';
    const kind = `${state} ${push.route}` as AgentPresenceWakeKind;
    wake = {
      kind,
      route: push.route,
      age_ms: push.age,
      label: `${AGENT_PRESENCE_LABELS.wake[state]} ${push.route}`,
    };
  } else {
    const turnAge = ageMs(row.turn_at, now);
    wake =
      turnAge === null
        ? {
            kind: 'none',
            route: null,
            age_ms: null,
            label: AGENT_PRESENCE_LABELS.wake.none,
          }
        : {
            kind: 'turn',
            route: 'turn',
            age_ms: turnAge,
            label: AGENT_PRESENCE_LABELS.wake.turn,
          };
  }

  const callAge = ageMs(row.last_command_at, now);
  const ackAge = ageMs(row.last_ack_at, now);
  const clientLabel =
    client === 'update available'
      ? AGENT_PRESENCE_LABELS.client.updateAvailable
      : AGENT_PRESENCE_LABELS.client[client];
  return {
    wake,
    last_call:
      callAge === null
        ? null
        : { age_ms: callAge, label: AGENT_PRESENCE_LABELS.lastCall },
    last_ack:
      ackAge === null
        ? null
        : {
            route: row.last_ack_via,
            age_ms: ackAge,
            label: AGENT_PRESENCE_LABELS.lastAck,
          },
    client: { kind: client, label: clientLabel },
  };
}

const nullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';

/** Strict decoder for `swarm_read.agent_presence` rows: throws on malformed rows. */
export function parseAgentPresenceRows(
  values: unknown,
): Map<string, AgentPresenceRow> {
  if (!Array.isArray(values)) {
    throw new Error('agent_presence_malformed');
  }
  const result = new Map<string, AgentPresenceRow>();
  for (const value of values) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('agent_presence_malformed');
    }
    const row = value as Record<string, unknown>;
    if (
      typeof row.principal_id !== 'string' ||
      !row.principal_id.trim() ||
      !nullableString(row.last_command_at) ||
      !nullableString(row.client_build) ||
      !nullableString(row.watcher_at) ||
      !nullableString(row.channel_at) ||
      !nullableString(row.listener_at) ||
      !nullableString(row.turn_at) ||
      (row.last_ack_via !== null &&
        row.last_ack_via !== 'leased' &&
        row.last_ack_via !== 'unclaimed') ||
      !nullableString(row.last_ack_at) ||
      !nullableString(row.current_client_build)
    ) {
      throw new Error('agent_presence_malformed');
    }
    result.set(row.principal_id.toLowerCase(), {
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
