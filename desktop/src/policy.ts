export const APP_URL = "https://commonswarm.com/app";
export const APP_ORIGIN = "https://commonswarm.com";
export const HELP_URL = "https://commonswarm.com/support";
export const OVERRIDE_ENV_VAR = "COMMONSWARM_DESKTOP_URL";

export type NavigationDisposition = "in_app" | "external" | "blocked";
export type NavigationSource = "navigate" | "new_window";

export interface SignInPathEntry {
  /**
   * Path prefix (ending with "/") or exact path (no trailing "/") allowed during in-app sign-in.
   */
  readonly prefix: string;
  readonly reason: string;
}

export interface SignInHostEntry {
  readonly host: string;
  readonly reason: string;
  readonly paths: readonly SignInPathEntry[];
}

/**
 * Exact hosts and paths that CommonSwarm web sign-in navigates through inside the window.
 * No wildcard broader than a single exact host and explicit path prefixes is needed.
 */
export const SIGN_IN_HOSTS: readonly SignInHostEntry[] = Object.freeze([
  Object.freeze({
    host: "api.commonswarm.com",
    reason: "GoTrue/Supabase OAuth authorize and callback endpoints (site/src/lib/commonswarm.ts, multi-account.ts).",
    paths: Object.freeze([
      Object.freeze({
        prefix: "/auth/v1/",
        reason: "GoTrue auth endpoints (/auth/v1/authorize, /auth/v1/callback, /auth/v1/verify) used by the web app.",
      }),
    ]),
  }),
  Object.freeze({
    host: "github.com",
    reason: "GitHub OAuth authorize, sign-in, and 2FA flow for provider=github (site/src/lib/auth-providers.ts).",
    paths: Object.freeze([
      Object.freeze({
        prefix: "/login",
        reason: "GitHub interactive sign-in page reached during OAuth.",
      }),
      Object.freeze({
        prefix: "/login/oauth/",
        reason: "GitHub OAuth authorize and consent endpoints.",
      }),
      Object.freeze({
        prefix: "/session",
        reason: "GitHub sign-in form submission endpoint.",
      }),
      Object.freeze({
        prefix: "/sessions/",
        reason: "GitHub two-factor and device verification steps.",
      }),
    ]),
  }),
  Object.freeze({
    host: "accounts.google.com",
    reason: "Google OAuth authorize and sign-in flow for provider=google (site/src/lib/auth-providers.ts).",
    paths: Object.freeze([
      Object.freeze({
        prefix: "/o/oauth2/",
        reason: "Google OAuth 2.0 authorization endpoints (/o/oauth2/v2/auth, /o/oauth2/auth).",
      }),
      Object.freeze({
        prefix: "/v3/signin/",
        reason: "Google v3 sign-in, challenge, account chooser, and embedded-window rejection pages.",
      }),
      Object.freeze({
        prefix: "/signin/",
        reason: "Google OAuth consent and legacy sign-in or rejection pages.",
      }),
      Object.freeze({
        prefix: "/ServiceLogin",
        reason: "Google classic sign-in redirect entry point.",
      }),
      Object.freeze({
        prefix: "/AccountChooser",
        reason: "Google account selection redirect during sign-in.",
      }),
      Object.freeze({
        prefix: "/InteractiveLogin",
        reason: "Google interactive login redirect step.",
      }),
      Object.freeze({
        prefix: "/CheckCookie",
        reason: "Google cookie verification redirect during sign-in.",
      }),
    ]),
  }),
]);

const SIGN_IN_HOST_MAP: ReadonlyMap<string, SignInHostEntry> = new Map(
  SIGN_IN_HOSTS.map((entry) => [entry.host, entry]),
);

export interface ResolveAppUrlOptions {
  readonly isPackaged: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface AppOriginOptions {
  readonly allowedDevOrigin?: string | null;
}

export interface NavigationPolicyOptions extends AppOriginOptions {
  readonly source: NavigationSource;
  readonly currentUrl?: string | null;
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

function matchesSignInPath(pathname: string, prefix: string): boolean {
  if (prefix.endsWith("/")) {
    return pathname.startsWith(prefix);
  }
  return pathname === prefix;
}

function isAllowedSignInUrl(url: URL): boolean {
  if (url.protocol !== "https:" || url.port !== "" || hasCredentials(url)) {
    return false;
  }
  const entry = SIGN_IN_HOST_MAP.get(url.hostname);
  if (!entry) return false;
  return entry.paths.some((pathEntry) => matchesSignInPath(url.pathname, pathEntry.prefix));
}

function isSignInOriginatingUrl(
  rawCurrentUrl: string | null | undefined,
  options?: AppOriginOptions,
): boolean {
  if (!rawCurrentUrl) return false;
  if (isAppOriginUrl(rawCurrentUrl, options)) return true;
  const parsed = parseUrl(rawCurrentUrl);
  if (!parsed) return false;
  return isAllowedSignInUrl(parsed);
}

/**
 * Classify a navigation target:
 * - "in_app":
 *   - https://commonswarm.com (any path) or an allowed local dev origin, for any source
 *   - for source === "navigate" only: explicit sign-in paths on SIGN_IN_HOSTS when the window
 *     currently shows the app origin or is already on an allowed sign-in URL
 * - "external": any other https: URL (including sign-in hosts opened via new_window)
 * - "blocked": http: to non-local hosts, file:, javascript:, data:, custom schemes, credentials, malformed input
 */
export function classifyNavigation(
  rawUrl: string,
  options: NavigationPolicyOptions,
): NavigationDisposition {
  const parsed = parseUrl(rawUrl);
  if (!parsed || hasCredentials(parsed)) return "blocked";

  if (options.allowedDevOrigin) {
    const devOrigin = parseUrl(options.allowedDevOrigin);
    if (devOrigin && isAllowedLocalDevUrl(devOrigin) && parsed.origin === devOrigin.origin) {
      return "in_app";
    }
  }

  if (parsed.protocol !== "https:") return "blocked";
  if (!parsed.hostname) return "blocked";

  if (parsed.port === "") {
    if (parsed.hostname === "commonswarm.com") return "in_app";
    if (
      options.source === "navigate" &&
      isAllowedSignInUrl(parsed) &&
      isSignInOriginatingUrl(options.currentUrl, options)
    ) {
      return "in_app";
    }
  }

  return "external";
}

/**
 * True only for the CommonSwarm app origin (or the active unpackaged local dev origin),
 * excluding third-party sign-in hosts. Used to scope notification permissions and sign-in transitions.
 */
export function isAppOriginUrl(
  rawUrl: string,
  options?: AppOriginOptions,
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
