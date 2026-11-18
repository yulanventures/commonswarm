/**
 * Everything waiting to join a workspace, as People & agents lists it: who made it, when, and
 * whether this viewer may cancel it. Pure: the dashboard passes the three server reads in and
 * sends the command this file names. The server still decides every cancellation.
 */
import type { AgentAccessStatus, PendingAgentAccess, PendingMemberInvite } from "./commonswarm";

/** person: an email invitation. key: an agent key nobody has used. code: an agent connect code
 *  with places left. agent: an agent that was added and has never connected. */
export type PeopleInviteKind = "person" | "key" | "code" | "agent";
export interface PeopleInvite {
  kind: PeopleInviteKind;
  /** The invitation, key, connect code or agent id: the id its cancel command names. */
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

/** People first, then agents: unused keys, connect codes, agents that never connected. */
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
  const keyed = new Set<string>();
  for (const entry of input.access) {
    if (!unusedKey(entry, now)) continue;
    keyed.add(entry.principalId);
    rows.push({ kind: "key", id: entry.tokenId, workspaceId: entry.workspaceId, name: entry.agentName,
      detail: line(whose(entry.ownerUserId), `made ${relative(entry.issuedAt)}`, `ends ${relative(entry.expiresAt)}`),
      mayCancel: mine(entry.ownerUserId) });
  }
  const codes: PeopleInvite[] = [], agents: PeopleInvite[] = [];
  for (const entry of input.pending ?? []) {
    if (entry.kind === "join" && entry.joinCredentialId !== null) {
      codes.push({ kind: "code", id: entry.joinCredentialId, workspaceId: input.workspaceId, name: "Connect code",
        detail: line(who(entry.ownerUserId, "made it", entry.issuerDisplay), relative(entry.issuedAt),
          entry.seatsUsed !== null && entry.seatCap !== null ? `${entry.seatsUsed} of ${entry.seatCap} places used` : null,
          entry.expiresAt ? `ends ${relative(entry.expiresAt)}` : null),
        mayCancel: mine(entry.ownerUserId) });
    } else if (entry.kind === "classic" && entry.principalId !== null && !keyed.has(entry.principalId)) {
      agents.push({ kind: "agent", id: entry.principalId, workspaceId: input.workspaceId, name: entry.principalName ?? "Agent",
        detail: line(whose(entry.ownerUserId, entry.issuerDisplay), `added ${relative(entry.issuedAt)}`, "never connected"),
        mayCancel: mine(entry.ownerUserId) });
    }
  }
  return [...rows, ...codes, ...agents];
}

/** The four ways an invite ends. Each takes the id its row carries: an invitation, a key, a connect code, an agent. */
export interface PeopleInviteSenders {
  person: (invitationId: string) => Promise<void>;
  key: (tokenId: string) => Promise<void>;
  code: (joinCredentialId: string) => Promise<void>;
  agent: (principalId: string) => Promise<void>;
}
/** Ends one invite with the command for its kind and the row's own id. The server decides whether it may. */
export function cancelPeopleInvite(invite: Pick<PeopleInvite, "kind" | "id">, send: PeopleInviteSenders): Promise<void> {
  return send[invite.kind](invite.id);
}

/** The Cancel button's accessible name. */
export function peopleInviteCancelLabel(invite: Pick<PeopleInvite, "kind" | "name">): string {
  if (invite.kind === "person") return `Cancel the invitation for ${invite.name}`;
  if (invite.kind === "key") return `Cancel the unused key for ${invite.name}`;
  if (invite.kind === "code") return "Cancel this connect code";
  return `Remove ${invite.name}, which never connected`;
}
export function peopleInviteReceipt(invite: Pick<PeopleInvite, "kind" | "name">): string {
  if (invite.kind === "person") return "Invitation canceled.";
  if (invite.kind === "key") return "Unused key canceled.";
  if (invite.kind === "code") return "Connect code canceled.";
  return `${invite.name} removed.`;
}
/** What the confirmation says stops and what stays, for each kind of invite. */
export function peopleInviteConfirmCopy(invite: Pick<PeopleInvite, "kind" | "name">) {
  const name = invite.name;
  if (invite.kind === "person") return { title: "Cancel this invitation?", button: "Cancel invitation",
    stops: [`The invitation for ${name} stops working and leaves this list. No one has joined with it.`],
    stays: ["You can send a new invitation later."] };
  if (invite.kind === "key") return { title: "Cancel this unused key?", button: "Cancel key",
    stops: [`The unused key for ${name} stops working and leaves this list. No agent has used it.`],
    stays: ["You can create a new key later."] };
  if (invite.kind === "code") return { title: "Cancel this connect code?", button: "Cancel code",
    stops: ["The connect code stops working and leaves this list. No more agents can join with it."],
    stays: ["Agents that already joined with it stay.", "You can make a new code later."] };
  return { title: `Remove ${name}?`, button: `Remove ${name}`,
    stops: [`${name} never connected. Its setup stops working, and it leaves this list and the agent list.`],
    stays: ["You can add it again later."] };
}
