/**
 * Everything waiting to join a workspace, as People & agents lists it: who made it, when, and
 * whether this viewer may cancel it. Pure: the dashboard passes the three server reads in and
 * sends the command this file names. The server still decides every cancellation.
 */
import type { AgentAccessStatus, PendingAgentAccess, PendingMemberInvite } from "./commonswarm";

/** person: an email invitation. key: an agent key nobody has used. code: an agent connect code
 *  with places left.
 *
 *  An agent with no key is not an invite and is never listed here. The pending read reports any
 *  agent with no used key, and a hosted agent is created without one, so that read cannot tell a
 *  connected agent from one that never connected (HezSec C1 on #501). Removing an agent is the
 *  agent list's action, with its own confirmation. */
export type PeopleInviteKind = "person" | "key" | "code";
export interface PeopleInvite {
  kind: PeopleInviteKind;
  /** The invitation, key or connect code id: the id its cancel command names. */
  id: string;
  workspaceId: string;
  /** The email, the agent's name, or "Connect code". */
  name: string;
  /** Who made it and when, then what is left of it. */
  detail: string;
  mayCancel: boolean;
}
export interface PeopleInvitesInput {
  workspaceId: string;
  invites: PendingMemberInvite[];
  access: AgentAccessStatus[];
  /** Undefined when the pending read is not used (the sample workspace). */
  pending?: PendingAgentAccess[];
  /** Null when the viewer is not a member here: nothing can be cancelled. */
  viewer: { userId: string; elevated: boolean } | null;
  /** A member's display name, or null when they are no longer a member. */
  nameOf: (userId: string) => string | null;
  /** A time as "3 days ago" or "in 4 days". */
  relative: (iso: string) => string;
  now: number;
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;
const unusedKey = (entry: AgentAccessStatus, now: number) =>
  entry.firstUsedAt === null && entry.revokedAt === null && new Date(entry.expiresAt).getTime() > now;

/** People first, then agents: unused keys, then connect codes. */
export function peopleInvites(input: PeopleInvitesInput): PeopleInvite[] {
  const { viewer, nameOf, relative, now } = input;
  const who = (userId: string, verb: string, fallback?: string) => {
    if (viewer && userId === viewer.userId) return `You ${verb}`;
    const name = nameOf(userId) ?? fallback;
    return name ? `${firstName(name)} ${verb}` : "";
  };
  // A key or an agent belongs to its owner; the server does not say who clicked.
  const whose = (userId: string, fallback?: string) => {
    if (viewer && userId === viewer.userId) return "Your agent";
    const name = nameOf(userId) ?? fallback;
    return name ? `${firstName(name)}’s agent` : "";
  };
  const line = (...parts: Array<string | null>) => parts.filter(Boolean).join(" · ");
  const mine = (ownerUserId: string) => !!viewer && (viewer.elevated || ownerUserId === viewer.userId);
  const rows: PeopleInvite[] = [];
  for (const invite of input.invites) {
    rows.push({ kind: "person", id: invite.invitationId, workspaceId: invite.workspaceId, name: invite.email,
      detail: line(who(invite.createdBy, "invited"), relative(invite.createdAt), `ends ${relative(invite.expiresAt)}`),
      // Only an owner or an admin reads invitations, and only they may revoke one.
      mayCancel: !!viewer?.elevated });
  }
  for (const entry of input.access) {
    if (!unusedKey(entry, now)) continue;
    rows.push({ kind: "key", id: entry.tokenId, workspaceId: entry.workspaceId, name: entry.agentName,
      detail: line(whose(entry.ownerUserId), `made ${relative(entry.issuedAt)}`, `ends ${relative(entry.expiresAt)}`),
      mayCancel: mine(entry.ownerUserId) });
  }
  for (const entry of input.pending ?? []) {
    // Only connect codes. A "classic" row is an agent with no used key, connected or not: see PeopleInviteKind.
    if (entry.kind !== "join" || entry.joinCredentialId === null) continue;
    rows.push({ kind: "code", id: entry.joinCredentialId, workspaceId: input.workspaceId, name: "Connect code",
      detail: line(who(entry.ownerUserId, "made it", entry.issuerDisplay), relative(entry.issuedAt),
        entry.seatsUsed !== null && entry.seatCap !== null ? `${entry.seatsUsed} of ${entry.seatCap} places used` : null,
        entry.expiresAt ? `ends ${relative(entry.expiresAt)}` : null),
      mayCancel: mine(entry.ownerUserId) });
  }
  return rows.map((row) => row.kind === "code" ? { ...row, detail: peopleInviteDisplayDetail(row, rows) } : row);
}

/**
 * When two connect codes in a workspace share identical displayed details (same creator, rounded times
 * and seat count), prepend a stable non-secret prefix of the credential record id ("code 11111111") so
 * the row, accessible Cancel button and confirmation stay distinguishable without ever showing the code value.
 */
function uniqueCodePrefix(id: string, siblings: readonly string[]): string {
  const clean = id.trim();
  for (let len = 8; len <= clean.length; len += 4) {
    const prefix = clean.slice(0, len);
    if (siblings.every((other) => other === clean || !other.startsWith(prefix))) return prefix;
  }
  return clean;
}
export function peopleInviteDisplayDetail(
  invite: Pick<PeopleInvite, "kind" | "id" | "detail">,
  all: readonly Pick<PeopleInvite, "kind" | "id" | "detail">[],
): string {
  if (invite.kind !== "code") return invite.detail;
  const matching = all.filter((other) => other.kind === "code" && other.detail === invite.detail);
  if (matching.length < 2 || matching.every((other) => other.id === invite.id)) return invite.detail;
  const tag = `code ${uniqueCodePrefix(invite.id, matching.map((other) => other.id))}`;
  return invite.detail ? `${tag} · ${invite.detail}` : tag;
}

/** The three ways an invite ends. Each takes the id its row carries: an invitation, a key, a connect code.
 *  None of them names an agent: cancelling an invite can never remove one. */
export interface PeopleInviteSenders {
  person: (invitationId: string) => Promise<void>;
  key: (tokenId: string) => Promise<void>;
  code: (joinCredentialId: string) => Promise<void>;
}
/** Ends one invite with the command for its kind and the row's own id. The server decides whether it may. */
export function cancelPeopleInvite(invite: Pick<PeopleInvite, "kind" | "id">, send: PeopleInviteSenders): Promise<void> {
  return send[invite.kind](invite.id);
}

/** The Cancel button's accessible name. */
export function peopleInviteCancelLabel(invite: Pick<PeopleInvite, "kind" | "name"> & { detail?: string }): string {
  if (invite.kind === "person") return `Cancel the invitation for ${invite.name}`;
  if (invite.kind === "key") return `Cancel the unused key for ${invite.name}`;
  const detail = invite.detail?.trim();
  return detail ? `Cancel connect code: ${detail}` : "Cancel this connect code";
}
export function peopleInviteReceipt(invite: Pick<PeopleInvite, "kind" | "name">): string {
  if (invite.kind === "person") return "Invitation canceled.";
  if (invite.kind === "key") return "Key canceled.";
  return "Connect code canceled.";
}
/** What the confirmation says stops and what stays, for each kind of invite. */
export function peopleInviteConfirmCopy(invite: Pick<PeopleInvite, "kind" | "name"> & { workspaceName?: string; detail?: string }) {
  const name = invite.name;
  if (invite.kind === "person") return { title: `Cancel the invitation for ${name}?`, button: "Cancel invitation",
    stops: ["Cancelling this invitation stops the email link from working."],
    stays: ["You can send a new invitation later."] };
  // The key was unused when this list loaded. The server revokes it either way, so say what that means if it has been used since.
  if (invite.kind === "key") return { title: `Cancel the key for ${name}?`, button: "Cancel key",
    stops: [`This key stops working and leaves this list. If ${name} has connected with it since this list loaded, turning it off cuts off ${name} and any access renewed from this key.`],
    stays: ["You can create a new key later."] };
  const workspace = invite.workspaceName?.trim();
  const context = invite.detail?.trim() || undefined;
  return { title: workspace ? `Cancel this connect code for ${workspace}?` : "Cancel this connect code?",
    ...(context ? { context } : {}),
    button: "Cancel code",
    stops: ["This connect code stops working and leaves this list. No more agents can join with it."],
    stays: ["Agents that already joined with it stay. You can make a new code later."] };
}
