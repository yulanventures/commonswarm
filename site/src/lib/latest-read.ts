/*
 * Latest-read sequencing for reads that can overlap.
 *
 * A screen often starts a second read of the same thing before the first one answers (open the
 * view twice, confirm, then open again). Replies can arrive in any order, and only the reply to
 * the newest request may paint. Each read takes a ticket; a reply whose ticket is no longer the
 * newest is dropped, success and failure alike. Scope checks (workspace, account, version) are
 * the caller's; this only orders reads of one kind (R2b review).
 */

export interface LatestRead {
  /** Start a read and get its ticket. */
  next(): number;
  /** True only for the ticket of the newest read started. */
  isLatest(ticket: number): boolean;
  /** Retire every ticket handed out so far (a scope change). */
  invalidate(): void;
}

export function createLatestRead(): LatestRead {
  let newest = 0;
  return {
    next: () => ++newest,
    isLatest: (ticket) => ticket === newest,
    invalidate: () => {
      newest += 1;
    },
  };
}
