import { AGENT_JOIN_LOCATOR_RE } from "./agent-join-limits.js";

/**
 * Public path on the service base URL. The locator is the last segment.
 * The h0 function matches this shape and the gateway-stripped form.
 */
export const H0_AGENT_DOCUMENT_PATH_PREFIX = "/functions/v1/h0/agent-doc/";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Document URL for a locator. serviceBaseUrl is the configured service origin
 * (PUBLIC_SUPABASE_URL, or the meta tag the build writes from it).
 * The credential is not an input.
 */
export function h0AgentDocumentUrl(serviceBaseUrl: string, locator: string): string {
  if (!AGENT_JOIN_LOCATOR_RE.test(locator)) {
    throw new Error("The deployment returned a document locator this page cannot use.");
  }
  let base: URL;
  try {
    base = new URL(serviceBaseUrl);
  } catch {
    throw new Error("The service base URL is not a URL.");
  }
  const loopback = LOOPBACK_HOSTS.has(base.hostname);
  if (base.protocol !== "https:" && !(base.protocol === "http:" && loopback)) {
    throw new Error("The service base URL must be HTTPS.");
  }
  if (base.username !== "" || base.password !== "") {
    throw new Error("The service base URL must not contain userinfo.");
  }
  if (base.search !== "" || base.hash !== "") {
    throw new Error("The service base URL must not contain a query or a fragment.");
  }
  if (base.pathname !== "/" && base.pathname !== "") {
    throw new Error("The service base URL must not include a path.");
  }
  return new URL(`${H0_AGENT_DOCUMENT_PATH_PREFIX}${locator}`, base.origin).href;
}
