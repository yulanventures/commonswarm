/**
 * The only read of PUBLIC_H0_LINK_JOIN.
 * The value "1" shows the Add an agent invite. Any other value hides it.
 *
 * loadLinkJoin is how the page reaches the invite module. h0LinkJoinEnabled is
 * a build-time constant. The page loads the module only through the flag-on
 * dynamic import below.
 */
export const h0LinkJoinEnabled = import.meta.env.PUBLIC_H0_LINK_JOIN === "1";

export function loadLinkJoin(): Promise<typeof import("./h0-link-join")> | null {
  if (!h0LinkJoinEnabled) return null;
  return import("./h0-link-join");
}
