/*
 * Ownership check for the dashboard's asynchronous teammate-invite submission.
 *
 * The invite response contains a one-use credential. It may be rendered only by
 * the exact workspace generation that submitted it: a workspace switch or even
 * a reload of the same workspace makes the response stale. Pure and I/O-free so
 * the dashboard and its causal race tests drive the same decision.
 */

export interface InviteSubmitOwner {
  workspaceId: string;
  version: number;
}

/** True only while the submitted workspace generation still owns the result. */
export function isInviteSubmitCurrent(
  owner: InviteSubmitOwner,
  activeWorkspaceId: string,
  requestVersion: number,
): boolean {
  return (
    owner.workspaceId === activeWorkspaceId &&
    owner.version === requestVersion
  );
}

/** What an accepted create hands to the surface that asked for it: the one-use link, and the invite it belongs to. */
export interface InviteReceipt {
  invitationId: string;
  link: string;
  workspaceId: string;
  email: string;
}

export type InviteCreateOutcome =
  /** The invite exists. `listed` is false when the list could not be read afterwards; that is not a failed create. */
  | { status: "made"; invitationId: string; listed: boolean }
  /** The workspace generation that asked ended before the answer arrived. Nothing was handed over. */
  | { status: "stale" }
  | { status: "error"; message: string };

export interface InviteCreateIo {
  workspaceId: string;
  /** The workspace generation that asked is still the current one. */
  owns(): boolean;
  /** Sends the command and builds the receipt. Throws on a refusal or an unknown outcome. */
  create(): Promise<InviteReceipt>;
  /** Called at most once, synchronously, when an accepted answer still belongs to the generation that asked. */
  accepted(receipt: InviteReceipt): void;
  /** Reads the list of invites again and applies it. Throws when it cannot be read. */
  refreshList(receipt: InviteReceipt): Promise<void>;
  /** The list could not be read after an accepted create, and the asking generation is still current. */
  listFailed(): void;
  /** A refusal or an unknown outcome, as the sentence to show. */
  failed(error: unknown): string;
}

/**
 * One invite, from command to list. The order is the contract:
 * an answer that arrives after its workspace generation ended is dropped before any surface sees it;
 * an accepted answer is handed over exactly once; and from then on the invite exists, so a list that
 * cannot be read afterwards is reported as its own failure and never turns the create into an error
 * (which would invite a second create while the first invite is live).
 */
export async function runInviteCreate(io: InviteCreateIo): Promise<InviteCreateOutcome> {
  let receipt: InviteReceipt;
  try {
    receipt = await io.create();
    if (!io.owns()) return { status: "stale" };
    if (receipt.workspaceId !== io.workspaceId) throw new Error("CommonSwarm returned an invite for another workspace. No link was shown.");
  } catch (error) {
    if (!io.owns()) return { status: "stale" };
    return { status: "error", message: io.failed(error) };
  }
  io.accepted(receipt);
  let listed = true;
  try { await io.refreshList(receipt); }
  catch { listed = false; if (io.owns()) io.listFailed(); }
  return { status: "made", invitationId: receipt.invitationId, listed };
}
