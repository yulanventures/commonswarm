/**
 * What happens after a password change succeeds (CS-E04): every session of the account ends, this
 * device's included, and the person signs in again.
 *
 * Bound to the account that changed its password. It never acts on whatever session the SDK holds
 * at the time:
 * - the server logout uses that account's own access token;
 * - this device's copy is removed only by `verifyCurrent`, the page's identity-safe check
 *   (commonswarm.ts currentSession). That checks the SDK's current credential under the SDK's own
 *   lock, and removes it only when the server no longer knows it. Another account that signed in
 *   meanwhile is verified, not removed.
 * - `live()` is asked after every await. Once another account or a newer completion owns the page,
 *   this one reports "superseded" and its caller must touch nothing.
 *
 * The password itself is never kept here and the change is never retried.
 */

export type RemoteLogout = "ended" | "unconfirmed";

export type CurrentCheck =
  | { kind: "none" }
  | { kind: "expired" }
  | { kind: "session"; userId: string }
  | { kind: "unknown" };

export type PasswordChangeOutcome =
  /** This device no longer holds the account's session. `remote` says whether the server confirmed every session ended. */
  | { kind: "signed-out"; remote: RemoteLogout }
  /** The account's session is still live here: the server logout was not confirmed. */
  | { kind: "still-signed-in"; remote: RemoteLogout }
  /** The local check failed. Nothing is known about this device's session. */
  | { kind: "unknown"; remote: RemoteLogout }
  /** Another account or a newer completion owns the page. */
  | { kind: "superseded" };

export interface PasswordChangeCompletionDeps {
  /** Ends every session of the account with its own token; resolves only on a confirmed logout. */
  signOutEverywhere(accessToken: string): Promise<void>;
  /** The page's identity-safe check of the SDK's current credential. */
  verifyCurrent(): Promise<CurrentCheck>;
  /** Still the owner: the same completion, and the page shows this account or no account. */
  live(): boolean;
}

export async function completePasswordChange(
  opening: { userId: string; accessToken: string },
  deps: PasswordChangeCompletionDeps,
): Promise<PasswordChangeOutcome> {
  let remote: RemoteLogout = "ended";
  try {
    await deps.signOutEverywhere(opening.accessToken);
  } catch {
    // A refusal, an error status, no response or a timeout: the server may or may not have ended
    // the sessions. Reported as unconfirmed; the local check below decides this device.
    remote = "unconfirmed";
  }
  if (!deps.live()) return { kind: "superseded" };
  let current: CurrentCheck;
  try {
    current = await deps.verifyCurrent();
  } catch {
    current = { kind: "unknown" };
  }
  if (!deps.live()) return { kind: "superseded" };
  switch (current.kind) {
    case "expired":
    case "none":
      return { kind: "signed-out", remote };
    case "session":
      return current.userId === opening.userId
        ? { kind: "still-signed-in", remote }
        : { kind: "superseded" };
    default:
      return { kind: "unknown", remote };
  }
}
