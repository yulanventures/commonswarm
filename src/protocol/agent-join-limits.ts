/**
 * Bounds and wire fields for mint_agent_join_credential and
 * revoke_agent_join_credential.
 *
 * The command edge enforces the same numbers and the same field lists
 * (supabase/functions/command/index.ts). The migration
 * 20260916000001_agent_join_credentials.sql repeats the seat cap, the
 * 24-hour ceiling, and the locator shape. tests/p1-cli/h0-link-join-app.test.ts
 * fails when those copies differ.
 */

export const AGENT_JOIN_SEAT_CAP_MIN = 1;
export const AGENT_JOIN_SEAT_CAP_MAX = 10;
export const AGENT_JOIN_TTL_MIN_HOURS = 1;
export const AGENT_JOIN_TTL_MAX_HOURS = 24;

/** Public document locator. It authorises nothing. */
export const AGENT_JOIN_LOCATOR_RE = /^[A-Za-z0-9_-]{22}$/;

/**
 * join_credential_id. The command edge's UUID_RE is the check revoke uses.
 * The app test fails when this source differs from that constant.
 */
export const AGENT_JOIN_CREDENTIAL_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const MINT_AGENT_JOIN_CREDENTIAL_KIND = "mint_agent_join_credential" as const;
export const REVOKE_AGENT_JOIN_CREDENTIAL_KIND = "revoke_agent_join_credential" as const;

export const MINT_AGENT_JOIN_CREDENTIAL_FIELDS = ["kind", "seat_cap", "ttl_hours"] as const;
export const REVOKE_AGENT_JOIN_CREDENTIAL_FIELDS = ["kind", "join_credential_id"] as const;

export interface MintAgentJoinCredentialCommand {
  kind: typeof MINT_AGENT_JOIN_CREDENTIAL_KIND;
  seat_cap: number;
  ttl_hours: number;
}

export interface RevokeAgentJoinCredentialCommand {
  kind: typeof REVOKE_AGENT_JOIN_CREDENTIAL_KIND;
  join_credential_id: string;
}

function sameKeys(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  const left = [...actual].sort();
  const right = [...expected].sort();
  return left.every((key, index) => key === right[index]);
}

/** The invite this page mints: the server's maximum seat cap and lifetime. */
export function mintAgentJoinCredentialCommand(): MintAgentJoinCredentialCommand {
  const command: MintAgentJoinCredentialCommand = {
    kind: MINT_AGENT_JOIN_CREDENTIAL_KIND,
    seat_cap: AGENT_JOIN_SEAT_CAP_MAX,
    ttl_hours: AGENT_JOIN_TTL_MAX_HOURS,
  };
  if (
    command.seat_cap < AGENT_JOIN_SEAT_CAP_MIN
    || command.seat_cap > AGENT_JOIN_SEAT_CAP_MAX
    || command.ttl_hours < AGENT_JOIN_TTL_MIN_HOURS
    || command.ttl_hours > AGENT_JOIN_TTL_MAX_HOURS
    || !sameKeys(Object.keys(command), MINT_AGENT_JOIN_CREDENTIAL_FIELDS)
  ) {
    throw new Error("mint_agent_join_credential is outside the server limits");
  }
  return command;
}

export function revokeAgentJoinCredentialCommand(
  joinCredentialId: string,
): RevokeAgentJoinCredentialCommand {
  if (!AGENT_JOIN_CREDENTIAL_ID_RE.test(joinCredentialId)) {
    throw new Error("join_credential_id must be a UUID");
  }
  const command: RevokeAgentJoinCredentialCommand = {
    kind: REVOKE_AGENT_JOIN_CREDENTIAL_KIND,
    join_credential_id: joinCredentialId.toLowerCase(),
  };
  if (!sameKeys(Object.keys(command), REVOKE_AGENT_JOIN_CREDENTIAL_FIELDS)) {
    throw new Error("revoke_agent_join_credential fields do not match the command shape");
  }
  return command;
}

/** What this invite asks for. The numbers are the server limits, not a second list. */
export function joinInviteLimitSentence(): string {
  return `Up to ${AGENT_JOIN_SEAT_CAP_MAX} agents can join. This invite lasts ${AGENT_JOIN_TTL_MAX_HOURS} hours.`;
}

export function joinInviteResultLead(input: {
  seatCap: number;
  expiresAt: string | null;
}): string {
  const expiry = input.expiresAt === null
    ? `It lasts ${AGENT_JOIN_TTL_MAX_HOURS} hours.`
    : `The server expires it at ${input.expiresAt}.`;
  return [
    "Copy this message into your agent.",
    "It has a public document link and a join credential.",
    "This page shows the credential once.",
    `Up to ${input.seatCap} agents can join.`,
    expiry,
    "Revoke stops new joins. Agents that already joined keep their seats.",
    "Done leaves the invite active.",
  ].join(" ");
}
