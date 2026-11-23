export const APP_URL = "https://commonswarm.com/app";
export const APP_ORIGIN = "https://commonswarm.com";
export const HELP_URL = "https://commonswarm.com/support";
export const OVERRIDE_ENV_VAR = "COMMONSWARM_DESKTOP_URL";

export type NavigationDisposition = "in_app" | "external" | "blocked" | "ignore";
export type NavigationSource = "navigate" | "redirect" | "new_window";

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
  /**
   * Whether the frame being navigated (or requesting a new window) is the main frame.
   */
  readonly isMainFrame: boolean;
  /**
   * Whether the frame that initiated this navigation is the window's own main frame.
   */
  readonly initiatorIsMainFrame?: boolean;
  /**
   * Serialized origin of the initiating frame (WebFrameMain.origin).
   */
  readonly initiatorOrigin?: string | null;
  /**
   * Optional full URL of the initiating frame (WebFrameMain.url).
   * Used to verify interactive sign-in steps and cross-check origin consistency.
   */
  readonly initiatorUrl?: string | null;
  /**
   * True only when the main frame is currently showing the bundled offline error page.
   */
  readonly initiatorIsOfflinePage?: boolean;
  /**
   * For source === "redirect": whether this redirect continues a trusted in-flight
   * main-frame navigation rather than an arbitrary or untracked request.
   */
  readonly continuingTrustedNavigation?: boolean;
  /**
   * For source === "redirect": the URL of the previous hop in the in-flight navigation chain.
   */
  readonly previousNavigationUrl?: string | null;
  /**
   * Whether a real browser-level user gesture authorized an explicit external open.
   */
  readonly hasUserGesture?: boolean;
  /**
   * For source === "new_window": whether the window's main frame currently has any subframes.
   * Must be explicitly false for any window-open request to be honoured (fails closed when true or omitted).
   */
  readonly mainFrameHasSubframes?: boolean;
}

export interface PermissionPolicyOptions extends AppOriginOptions {
  readonly permission: string;
  readonly requestingUrl?: string | null;
  readonly isMainFrame: boolean;
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

function isAllowedSignInParsedUrl(url: URL): boolean {
  if (url.protocol !== "https:" || url.port !== "" || hasCredentials(url)) {
    return false;
  }
  const entry = SIGN_IN_HOST_MAP.get(url.hostname);
  if (!entry) return false;
  return entry.paths.some((pathEntry) => matchesSignInPath(url.pathname, pathEntry.prefix));
}

export function isAllowedSignInUrl(rawUrl: string): boolean {
  const parsed = parseUrl(rawUrl);
  return parsed !== null && isAllowedSignInParsedUrl(parsed);
}

function isAppInitiator(options: NavigationPolicyOptions): boolean {
  if (!options.initiatorIsMainFrame) return false;
  if (!options.initiatorOrigin || !isAppOriginUrl(options.initiatorOrigin, options)) {
    return false;
  }
  if (options.initiatorUrl && !isAppOriginUrl(options.initiatorUrl, options)) {
    return false;
  }
  return true;
}

function isSignInInitiator(options: NavigationPolicyOptions): boolean {
  if (!options.initiatorIsMainFrame) return false;
  if (!options.initiatorUrl) return false;
  const parsed = parseUrl(options.initiatorUrl);
  if (!parsed || !isAllowedSignInParsedUrl(parsed)) return false;
  if (options.initiatorOrigin && parsed.origin !== options.initiatorOrigin) {
    return false;
  }
  return true;
}

function isTrustedRedirectHop(
  previousUrl: string | null | undefined,
  options: AppOriginOptions,
): boolean {
  if (!previousUrl) return false;
  if (isAppOriginUrl(previousUrl, options)) return true;
  return isAllowedSignInUrl(previousUrl);
}

/**
 * Classify a navigation, redirect, or window-open target:
 * - "ignore": subframe navigation or redirect (top-level policy does not apply; no OS hand-off)
 * - "in_app":
 *   - "navigate": app main frame to app origin or SIGN_IN_HOSTS; main frame on an allowed sign-in
 *     URL continuing to SIGN_IN_HOSTS or returning to app origin; bundled offline page retrying app origin
 *   - "redirect": continuation of a trusted main-frame navigation to app origin or SIGN_IN_HOSTS
 *   - "new_window": app main frame with no subframes opening an app-origin URL (loaded in the main window)
 * - "external": well-formed https: URL without credentials on an explicit user-gesture open
 *   ("navigate" or "new_window") initiated by the app's own main frame at the app origin
 *   (and for "new_window", only when mainFrameHasSubframes is explicitly false).
 *   Redirects never return "external".
 * - "blocked": everything else (cancelled locally, never handed to shell.openExternal)
 */
export function classifyNavigation(
  rawUrl: string,
  options: NavigationPolicyOptions,
): NavigationDisposition {
  if (!options.isMainFrame) {
    return options.source === "new_window" ? "blocked" : "ignore";
  }

  const parsed = parseUrl(rawUrl);
  if (!parsed || hasCredentials(parsed)) return "blocked";

  const targetIsAppOrigin = isAppOriginUrl(parsed.href, options);

  if (options.source === "redirect") {
    if (options.continuingTrustedNavigation !== true) return "blocked";
    if (options.initiatorIsMainFrame === false) return "blocked";
    if (targetIsAppOrigin) return "in_app";
    if (
      isAllowedSignInParsedUrl(parsed) &&
      isTrustedRedirectHop(options.previousNavigationUrl, options)
    ) {
      return "in_app";
    }
    return "blocked";
  }

  if (options.source === "new_window") {
    if (!isAppInitiator(options)) return "blocked";
    if (options.mainFrameHasSubframes !== false) return "blocked";
    if (targetIsAppOrigin) return "in_app";
    if (options.hasUserGesture === true && isAllowedExternalUrl(parsed.href)) {
      return "external";
    }
    return "blocked";
  }

  // source === "navigate"
  if (isAppInitiator(options)) {
    if (targetIsAppOrigin || isAllowedSignInParsedUrl(parsed)) return "in_app";
    if (options.hasUserGesture === true && isAllowedExternalUrl(parsed.href)) {
      return "external";
    }
    return "blocked";
  }

  if (isSignInInitiator(options)) {
    if (targetIsAppOrigin || isAllowedSignInParsedUrl(parsed)) return "in_app";
    return "blocked";
  }

  if (options.initiatorIsMainFrame === true && options.initiatorIsOfflinePage === true) {
    return targetIsAppOrigin ? "in_app" : "blocked";
  }

  return "blocked";
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
 * Guard for shell.openExternal: allow well-formed https: URLs without credentials only.
 */
export function isAllowedExternalUrl(rawUrl: string): boolean {
  const parsed = parseUrl(rawUrl);
  if (!parsed || hasCredentials(parsed)) return false;
  return parsed.protocol === "https:" && parsed.hostname.length > 0;
}

/**
 * Permission decision for Electron permission request and check handlers.
 * Allows notifications only for the app origin from the main frame; fails closed
 * on missing, empty, foreign, or subframe requests.
 */
export function isPermissionAllowed(options: PermissionPolicyOptions): boolean {
  if (options.permission !== "notifications") return false;
  if (!options.isMainFrame) return false;
  if (!options.requestingUrl) return false;
  return isAppOriginUrl(options.requestingUrl, options);
}
