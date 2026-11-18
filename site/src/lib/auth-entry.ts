/**
 * Which screen a signed-out person gets on /app.
 *
 * "sign-in" is for someone who has an account. "create" is where Sign up and Start a workspace
 * lead: it offers only the doors that make an account (a provider, or the emailed link), because
 * a password belongs to an account that already exists and cannot make one.
 *
 * The address is the one shared fact: every link that means "new here" uses CREATE_ACCOUNT_HREF,
 * and /app reads it back with authEntryFromSearch.
 */
export type AuthEntry = "sign-in" | "create";

export const CREATE_ACCOUNT_PARAM = "signup";
export const SIGN_IN_HREF = "/app";
export const CREATE_ACCOUNT_HREF = `/app?${CREATE_ACCOUNT_PARAM}`;

export function authEntryFromSearch(search: string): AuthEntry {
  return new URLSearchParams(search).has(CREATE_ACCOUNT_PARAM) ? "create" : "sign-in";
}

/** The heading of each screen, and the one link on it that leads to the other. */
export const AUTH_ENTRY_COPY: Record<AuthEntry, { title: string; otherLabel: string; otherHref: string }> = {
  "sign-in": { title: "Sign in", otherLabel: "Create an account", otherHref: CREATE_ACCOUNT_HREF },
  create: { title: "Create an account", otherLabel: "Sign in to an existing account", otherHref: SIGN_IN_HREF },
};
