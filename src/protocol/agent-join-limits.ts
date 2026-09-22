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

/**
 * Live (unrevoked, unexpired) join credentials. The command edge uses these
 * same numbers: one person, then the whole workspace.
 */
export const AGENT_JOIN_LIVE_PER_USER_LIMIT = 5;
export const AGENT_JOIN_LIVE_PER_WORKSPACE_LIMIT = 20;

/**
 * Body field `error` on that refusal. The audit reason is
 * `agent_join_live_limit_reached` and is not sent to the client.
 * `scope` is `identity` or `workspace`. `limit` is the matching constant.
 */
export const AGENT_JOIN_LIVE_LIMIT_ERROR = "join_credential_limit_reached";

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

/** Singular only for one. Every other count uses the plural. */
export function joinSeatNoun(count: number): string {
  return count === 1 ? "agent" : "agents";
}

/** Sentences the result panel shows while Revoke is still on this page. */
export function joinInviteBeforeDoneSentences(): readonly string[] {
  return [
    "Done leaves the invite active.",
    "After Done, this page cannot revoke the invite.",
    "Revoke it now if you do not want it used.",
  ];
}

/**
 * Refusal copy for a live-invite ceiling. Null when `scope` is not one of the
 * two values the command edge sends. The numbers are the constants above.
 * There is no revoke control for an invite this page is not showing.
 */
export function joinInviteLiveLimitMessage(scope: string): string | null {
  const limit = scope === "identity"
    ? AGENT_JOIN_LIVE_PER_USER_LIMIT
    : scope === "workspace"
      ? AGENT_JOIN_LIVE_PER_WORKSPACE_LIMIT
      : null;
  if (limit === null) return null;
  const reached = scope === "identity"
    ? `You already have ${limit} live invites, which is the limit for one person.`
    : `This workspace already has ${limit} live invites, which is the limit for one workspace.`;
  return [
    reached,
    `Each invite expires within ${AGENT_JOIN_TTL_MAX_HOURS} hours.`,
    "Wait for one to expire, then try again.",
    "No new invite was created.",
  ].join(" ");
}

/** A mint whose response never arrived. The server may already have stored one. */
export function joinInviteLostMintMessage(): string {
  return [
    "The answer did not come back.",
    "An invite may already exist and will expire on its own",
    `within ${AGENT_JOIN_TTL_MAX_HOURS} hours.`,
  ].join(" ");
}

/** What this invite asks for. The numbers are the server limits, not a second list. */
export function joinInviteLimitSentence(): string {
  const count = AGENT_JOIN_SEAT_CAP_MAX;
  return `Up to ${count} ${joinSeatNoun(count)} can join. This invite lasts ${AGENT_JOIN_TTL_MAX_HOURS} hours.`;
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
    `Up to ${input.seatCap} ${joinSeatNoun(input.seatCap)} can join.`,
    expiry,
    "Revoke stops new joins. Agents that already joined keep their seats.",
    ...joinInviteBeforeDoneSentences(),
  ].join(" ");
}
