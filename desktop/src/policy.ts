export const APP_URL = "https://commonswarm.com/app";
export const APP_ORIGIN = "https://commonswarm.com";
export const HELP_URL = "https://commonswarm.com/support";
export const OVERRIDE_ENV_VAR = "COMMONSWARM_DESKTOP_URL";

export type NavigationDisposition = "in_app" | "external" | "blocked";

export interface SignInHostEntry {
  readonly host: string;
  readonly reason: string;
}

/**
 * Exact hosts that CommonSwarm web sign-in navigates through inside the window.
 * No wildcard broader than a single exact host is needed.
 */
export const SIGN_IN_HOSTS: readonly SignInHostEntry[] = Object.freeze([
  Object.freeze({
    host: "api.commonswarm.com",
    reason: "GoTrue/Supabase OAuth authorize and callback endpoints (site/src/lib/commonswarm.ts, multi-account.ts).",
  }),
  Object.freeze({
    host: "github.com",
    reason: "GitHub OAuth authorize, sign-in, and 2FA flow for provider=github (site/src/lib/auth-providers.ts).",
  }),
  Object.freeze({
    host: "accounts.google.com",
    reason: "Google OAuth authorize and sign-in flow for provider=google (site/src/lib/auth-providers.ts).",
  }),
]);

const SIGN_IN_HOST_SET: ReadonlySet<string> = new Set(
  SIGN_IN_HOSTS.map((entry) => entry.host),
);

export interface ResolveAppUrlOptions {
  readonly isPackaged: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface NavigationPolicyOptions {
  readonly allowedDevOrigin?: string | null;
}

function parseUrl(raw: string): URL | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed);
  } catch {
    return null;
  }
}

function hasCredentials(url: URL): boolean {
  return url.username.length > 0 || url.password.length > 0;
}

function isAllowedLocalDevUrl(url: URL): boolean {
  return (
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
    !hasCredentials(url)
  );
}

function isProductionAppOrigin(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    url.hostname === "commonswarm.com" &&
    url.port === "" &&
    !hasCredentials(url)
  );
}

/**
 * Resolve the initial URL to load in the main window.
 * COMMONSWARM_DESKTOP_URL is honored only when unpackaged and only for
 * http://localhost, http://127.0.0.1, or https://commonswarm.com origins.
 */
export function resolveAppUrl(options: ResolveAppUrlOptions): string {
  if (options.isPackaged) return APP_URL;
  const raw = options.env?.[OVERRIDE_ENV_VAR]?.trim();
  if (!raw) return APP_URL;
  const parsed = parseUrl(raw);
  if (!parsed || hasCredentials(parsed)) return APP_URL;
  if (isAllowedLocalDevUrl(parsed) || isProductionAppOrigin(parsed)) {
    return parsed.href;
  }
  return APP_URL;
}

/**
 * Derive the optional local dev origin allowed for in-app navigation when running unpackaged.
 */
export function getAllowedDevOrigin(appUrl: string, isPackaged: boolean): string | null {
  if (isPackaged) return null;
  const parsed = parseUrl(appUrl);
  if (!parsed || !isAllowedLocalDevUrl(parsed)) return null;
  return parsed.origin;
}

/**
 * Classify a navigation target:
 * - "in_app": https://commonswarm.com (any path), explicit sign-in hosts, or an allowed local dev origin
 * - "external": any other https: URL
 * - "blocked": http: to non-local hosts, file:, javascript:, data:, custom schemes, credentials, malformed input
 */
export function classifyNavigation(
  rawUrl: string,
  options?: NavigationPolicyOptions,
): NavigationDisposition {
  const parsed = parseUrl(rawUrl);
  if (!parsed || hasCredentials(parsed)) return "blocked";

  if (options?.allowedDevOrigin) {
    const devOrigin = parseUrl(options.allowedDevOrigin);
    if (devOrigin && isAllowedLocalDevUrl(devOrigin) && parsed.origin === devOrigin.origin) {
      return "in_app";
    }
  }

  if (parsed.protocol !== "https:") return "blocked";
  if (!parsed.hostname) return "blocked";

  if (parsed.port === "") {
    if (parsed.hostname === "commonswarm.com") return "in_app";
    if (SIGN_IN_HOST_SET.has(parsed.hostname)) return "in_app";
  }

  return "external";
}

/**
 * True only for the CommonSwarm app origin (or the active unpackaged local dev origin),
 * excluding third-party sign-in hosts. Used to scope notification permissions.
 */
export function isAppOriginUrl(
  rawUrl: string,
  options?: NavigationPolicyOptions,
): boolean {
  const parsed = parseUrl(rawUrl);
  if (!parsed || hasCredentials(parsed)) return false;
  if (isProductionAppOrigin(parsed)) return true;
  if (options?.allowedDevOrigin) {
    const devOrigin = parseUrl(options.allowedDevOrigin);
    if (devOrigin && isAllowedLocalDevUrl(devOrigin) && parsed.origin === devOrigin.origin) {
      return true;
    }
  }
  return false;
}

/**
 * Guard for shell.openExternal: allow https: URLs only.
 */
export function isAllowedExternalUrl(rawUrl: string): boolean {
  const parsed = parseUrl(rawUrl);
  if (!parsed || hasCredentials(parsed)) return false;
  return parsed.protocol === "https:" && parsed.hostname.length > 0;
}
