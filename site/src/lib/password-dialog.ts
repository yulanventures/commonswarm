/**
 * Identity guard for the Password dialog (HezSec #282). The dialog acts only for the account that
 * opened it: open() records that user and starts a new generation; any auth reset, close or
 * reopen ends it. Work started under one generation must check `live()` after every await and
 * drop its result otherwise, so a late reply can never update a dialog that belongs to someone else.
 */
export interface PasswordDialogTicket { readonly userId: string; readonly generation: number }

export class PasswordDialogGuard {
  #generation = 0;
  #ticket: PasswordDialogTicket | null = null;

  open(userId: string): PasswordDialogTicket {
    this.#ticket = { userId, generation: ++this.#generation };
    return this.#ticket;
  }

  /** Close, sign-out, or an identity change: every outstanding ticket goes stale. */
  reset(): void {
    this.#generation += 1;
    this.#ticket = null;
  }

  /** The ticket is still the open one and the page's verified user is still its user. */
  live(ticket: PasswordDialogTicket | null, currentUserId: string | null | undefined): ticket is PasswordDialogTicket {
    return ticket !== null && this.#ticket === ticket && ticket.generation === this.#generation &&
      typeof currentUserId === "string" && currentUserId === ticket.userId;
  }

  get ticket(): PasswordDialogTicket | null { return this.#ticket; }

  /** An auth event ends the dialog unless it keeps the same verified user. */
  observeAuth(event: string, nextUserId: string | null | undefined): boolean {
    if (this.#ticket === null) return false;
    if (event === "SIGNED_OUT" || nextUserId !== this.#ticket.userId) { this.reset(); return true; }
    return false;
  }
}
