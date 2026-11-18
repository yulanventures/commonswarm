/**
 * People & agents: the dialog's own receipt for the invite its form made. The receipt carries a one-use link, so it
 * belongs to exactly one form, account, workspace and workspace generation. It is kept, shown and copied only while
 * all four still hold; anything else erases it. The invite itself stays pending in the list until it is cancelled.
 * The older invite page keeps a receipt of its own; neither surface reads or clears the other's. Pure.
 */
import type { InviteReceipt } from "../invite-submit";

export interface DialogInviteScope {
  /** The dialog is open. */
  open: boolean;
  /** The form now on the Invites tab (its draft object), or null when there is none. */
  form: object | null;
  userId: string;
  workspaceId: string;
  /** The workspace generation: it advances on every load of a workspace, the same one included. */
  generation: number;
}
export interface DialogInviteReceipt extends InviteReceipt {
  form: object;
  userId: string;
  generation: number;
  /** A read of the invite list has shown this invite. Only then can its absence mean it is gone. */
  listed: boolean;
}

/** An accepted answer becomes the dialog's receipt only if the form that asked is still the one on screen, in the same
 *  account, workspace and generation. Otherwise the link is dropped here and never stored. */
export function bindDialogInvite(receipt: InviteReceipt, asked: Omit<DialogInviteScope, "open" | "form"> & { form: object }, now: DialogInviteScope): DialogInviteReceipt | null {
  if (!now.open || now.form !== asked.form || !asked.userId || now.userId !== asked.userId || now.workspaceId !== asked.workspaceId
    || now.generation !== asked.generation || receipt.workspaceId !== asked.workspaceId || !receipt.link || !receipt.invitationId) return null;
  return { ...receipt, form: asked.form, userId: asked.userId, generation: asked.generation, listed: false };
}

/** The receipt still belongs to what is on screen. */
export function dialogInviteCurrent(held: DialogInviteReceipt | null, now: DialogInviteScope): held is DialogInviteReceipt {
  return !!held && now.open && now.form === held.form && now.userId === held.userId && now.workspaceId === held.workspaceId && now.generation === held.generation;
}

/** The link to show and to copy: the current receipt's, or nothing. */
export function dialogInviteLink(held: DialogInviteReceipt | null, now: DialogInviteScope): string {
  return dialogInviteCurrent(held, now) ? held.link : "";
}

/** After the invite list was read: an invite the list has shown and no longer shows was cancelled, used or expired, and
 *  its receipt goes with it. One the list has not shown yet is kept; the list may simply not have caught up. */
export function settleDialogInvite(held: DialogInviteReceipt, listedIds: readonly string[]): DialogInviteReceipt | null {
  if (listedIds.includes(held.invitationId)) return held.listed ? held : { ...held, listed: true };
  return held.listed ? null : held;
}

/** What the Invites tab says after a link was cleared without its invite being cancelled. */
export function dialogInviteNotice(cleared: { email: string; why: "reloaded" | "closed" }, stillListed: boolean): string {
  const when = cleared.why === "reloaded" ? "when this workspace reloaded" : "when its form was closed";
  return stillListed
    ? `The link for ${cleared.email} was cleared ${when}. The invite is still in the list below. Cancel it and create another if you need a new link.`
    : `The link for ${cleared.email} was cleared ${when}. If the invite is in the list below, cancel it and create another.`;
}
