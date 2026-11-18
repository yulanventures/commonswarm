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
  /** The invite list as it stood when the invite was accepted: a snapshot from before the create, which cannot show
   *  it. Any other list was read after acceptance. */
  before: readonly unknown[];
}

/** An accepted answer becomes the dialog's receipt only if the form that asked is still the one on screen, in the same
 *  account, workspace and generation. Otherwise the link is dropped here and never stored. */
export function bindDialogInvite(receipt: InviteReceipt, asked: Omit<DialogInviteScope, "open" | "form"> & { form: object }, now: DialogInviteScope,
  before: readonly unknown[]): DialogInviteReceipt | null {
  if (!now.open || now.form !== asked.form || !asked.userId || now.userId !== asked.userId || now.workspaceId !== asked.workspaceId
    || now.generation !== asked.generation || receipt.workspaceId !== asked.workspaceId || !receipt.link || !receipt.invitationId) return null;
  return { ...receipt, form: asked.form, userId: asked.userId, generation: asked.generation, before };
}

/** The receipt still belongs to what is on screen. */
export function dialogInviteCurrent(held: DialogInviteReceipt | null, now: DialogInviteScope): held is DialogInviteReceipt {
  return !!held && now.open && now.form === held.form && now.userId === held.userId && now.workspaceId === held.workspaceId && now.generation === held.generation;
}

/** The link to show and to copy: the current receipt's, or nothing. */
export function dialogInviteLink(held: DialogInviteReceipt | null, now: DialogInviteScope): string {
  return dialogInviteCurrent(held, now) ? held.link : "";
}

/** The pending list shows only invites that still work: a used, cancelled or expired one is left out. So once a list
 *  read after acceptance leaves this invite out, its link is retired, the first such read included. Only the
 *  snapshot from before the create is no evidence; a read that failed leaves that snapshot in place, and the link with it. */
export function settleDialogInvite(held: DialogInviteReceipt, list: readonly { invitationId: string }[]): DialogInviteReceipt | null {
  if (list === held.before) return held;
  return list.some((invite) => invite.invitationId === held.invitationId) ? held : null;
}

/** What the Invites tab says after a link stopped being shown while its invite stayed pending. The invite still works
 *  for anyone who already copied the link, so cancelling is only for someone who needs a new one; and the tab says the
 *  invite is listed only once a read of the list has shown it. */
export function dialogInviteNotice(cleared: { email: string; why: "reloaded" | "closed" }, stillListed: boolean): string {
  const why = cleared.why === "reloaded" ? "because the workspace reloaded" : "because the invite form closed";
  return `The link for ${cleared.email} is no longer shown here ${why}. ${stillListed
    ? "The invite is still listed below. If you need a new link, cancel it and create another."
    : "If you need a new link, cancel the invite when it appears below, then create another."}`;
}
