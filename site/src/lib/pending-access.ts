/*
 * The pending-access model shared by every surface that shows it.
 *
 * Pending access is the waiting room of a workspace: teammate invitations not yet
 * redeemed, and agent keys not yet used. Two surfaces render it — the rail's
 * Pending access details (desktop) and the Agents dialog section (the only
 * reachable one at mobile widths) — and a bounded workspace poll keeps it fresh,
 * including discovery of access created by another browser. One function builds
 * the rows so the two lists can never disagree about content, order, or wording;
 * one predicate decides whether the poll should run, so the cadence can never
 * depend on which channel view is open or what this browser already knows.
 *
 * Pure and I/O-free so the dashboard and its test drive the same decisions.
 */

import type { AgentAccessStatus, PendingAgentAccess, PendingMemberInvite } from "./commonswarm";

export interface PendingAccessRow {
  /** The cancellation route, or pending when no cancellable token exists. */
  kind: "invite" | "agent" | "pending";
  /** The invitation, token, principal, or join credential id. */
  id: string;
  workspaceId: string;
  /** The row's strong line: the invitee's email or the agent's name. */
  title: string;
  /** The row's quiet line: invitation expiry or pending age and capacity. */
  state: string;
  /** The Cancel button's accessible name, specific to the row it cancels. */
  cancelLabel: string;
}

/**
 * Rows for both pending lists, in display order: teammate invitations first,
 * then unused agent keys. An agent key is pending only while it is unused,
 * unrevoked, and unexpired — a consumed or dead key is history, not access.
 */
export function pendingAccessRows(
  invites: PendingMemberInvite[],
  access: AgentAccessStatus[],
  ownerName: (userId: string) => string,
  now: number,
  relative: (iso: string) => string,
  serverPending?: PendingAgentAccess[],
  workspaceId = "",
): PendingAccessRow[] {
  const rows: PendingAccessRow[] = [];
  for (const invitation of invites) {
    rows.push({
      kind: "invite",
      id: invitation.invitationId,
      workspaceId: invitation.workspaceId,
      title: invitation.email,
      state: `Teammate invite · expires ${relative(invitation.expiresAt)}`,
      cancelLabel: `Cancel invite for ${invitation.email}`,
    });
  }
  if (serverPending !== undefined) {
    for (const entry of serverPending) {
      const cancellable = entry.principalId === null ? undefined : access.find(
        (status) => status.principalId === entry.principalId &&
          status.firstUsedAt === null && status.revokedAt === null &&
          new Date(status.expiresAt).getTime() > now && status.tokenId.length > 0,
      );
      rows.push({
        kind: cancellable ? "agent" : "pending",
        id: cancellable?.tokenId ?? entry.principalId ?? entry.joinCredentialId ?? "",
        workspaceId,
        title: entry.principalName ??
          `Agent connect code (${entry.joinCredentialId?.slice(0, 8) ?? ""})`,
        state: `Invited, not connected · ${relative(entry.issuedAt)}` +
          (entry.kind === "join"
            ? ` · ${entry.seatsUsed}/${entry.seatCap} seats used · issued by ${entry.issuerDisplay}`
            : ""),
        cancelLabel: cancellable ? `Cancel access for ${entry.principalName ?? "agent"}` : "",
      });
    }
    return rows;
  }
  for (const entry of access) {
    const pending =
      entry.firstUsedAt === null &&
      entry.revokedAt === null &&
      new Date(entry.expiresAt).getTime() > now;
    if (!pending) continue;
    rows.push({
      kind: "agent",
      id: entry.tokenId,
      workspaceId: entry.workspaceId,
      title: entry.agentName,
      state:
        `${entry.model ?? "Model not specified"} · owned by ${ownerName(entry.ownerUserId)}` +
        ` · expires ${relative(entry.expiresAt)}`,
      cancelLabel: `Cancel access for ${entry.agentName}`,
    });
  }
  return rows;
}

/**
 * True once the exact freshly-created teammate invitation is absent from the
 * server's pending set. Other invitations cannot keep its one-use link alive.
 */
export function shouldRetireFreshInvite(
  invitationId: string,
  invites: PendingMemberInvite[],
): boolean {
  return (
    invitationId.length > 0 &&
    !invites.some((invitation) => invitation.invitationId === invitationId)
  );
}

/**
 * Whether the pending-access poll should be running at all. Deliberately NOT a
 * function of the channel view or current pending rows: a collaborator can add
 * the first invite from another browser, so local zero is not proof that there
 * is nothing to discover. The refresh gate supplies the slower idle cadence.
 */
export function shouldPollPendingAccess(args: {
  sampleMode: boolean;
  activeWorkspaceId: string;
  visible: boolean;
}): boolean {
  return (
    !args.sampleMode &&
    args.activeWorkspaceId.length > 0 &&
    args.visible
  );
}
