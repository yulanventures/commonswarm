export const APP_URL = "https://commonswarm.com/app";
export const APP_ORIGIN = "https://commonswarm.com";
export const HELP_URL = "https://commonswarm.com/support";
export const OVERRIDE_ENV_VAR = "COMMONSWARM_DESKTOP_URL";

export const LINK_TICKET_WINDOW_MS = 1000;
export const MAX_EXTERNAL_URL_LENGTH = 2048;
export const IPC_LINK_ACTIVATED = "desktop:link-activated";
export const IPC_ACTIVATION_WITHOUT_LINK = "desktop:activation-without-link";
export const DEV_ORIGIN_ARG_PREFIX = "--commonswarm-dev-origin=";

export const CONTEXT_MENU_OPEN_LINK_LABEL = "Open Link in Browser";
export const CONTEXT_MENU_COPY_LINK_LABEL = "Copy Link";

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

/**
 * Identity of a live main-frame document.
 * Combines Chromium frame/process identifiers with a monotonic documentGeneration
 * counter incremented on every main-frame cross-document navigation (did-navigate)
 * and render-process-gone event so a same-URL reload always produces a new identity.
 */
export interface DocumentIdentity {
  readonly frameTreeNodeId: number;
  readonly processId: number;
  readonly routingId: number;
  readonly frameToken: string;
  readonly origin: string;
  readonly documentGeneration: number;
}

export interface LinkActivationTicket {
  readonly url: string;
  readonly document: DocumentIdentity;
  readonly issuedAt: number;
}

export interface LinkTicketState {
  readonly ticket: LinkActivationTicket | null;
  readonly discardActivationsUntil: number | null;
}

export const INITIAL_LINK_TICKET_STATE: LinkTicketState = Object.freeze({
  ticket: null,
  discardActivationsUntil: null,
});

export interface RecordLinkActivationInput extends AppOriginOptions {
  readonly rawUrl: unknown;
  readonly senderMatchesWindow: boolean;
  readonly senderIsMainFrame: boolean;
  readonly senderDocument: DocumentIdentity | null;
  readonly now: number;
}

export interface ClearLinkTicketInput extends AppOriginOptions {
  readonly senderMatchesWindow: boolean;
  readonly senderIsMainFrame: boolean;
  readonly senderOrigin: string | null | undefined;
}

export interface ConsumeTicketInput {
  readonly disposition: NavigationDisposition;
  readonly rawUrl: string;
  readonly source: NavigationSource;
  readonly currentDocument: DocumentIdentity | null;
  readonly now: number;
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
   * Current one-time link-activation ticket, bound to an exact URL and document lifetime.
   */
  readonly linkTicket?: LinkActivationTicket | null;
  /**
   * Live main-frame document identity at the moment of the navigation or window-open check.
   */
  readonly currentDocument?: DocumentIdentity | null;
  /**
   * Current timestamp in milliseconds (for deterministic ticket expiry evaluation).
   */
  readonly now?: number;
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

export type ContextMenuActionId =
  | "open-link"
  | "copy-link"
  | "undo"
  | "redo"
  | "cut"
  | "copy"
  | "paste"
  | "selectAll"
  | "separator";

export interface ContextMenuDescriptorItem {
  readonly id: ContextMenuActionId;
  readonly label?: string;
  readonly role?: "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll";
  readonly type?: "separator";
  readonly enabled?: boolean;
  readonly linkUrl?: string;
}

export interface ContextMenuEditFlags {
  readonly canUndo?: boolean;
  readonly canRedo?: boolean;
  readonly canCut?: boolean;
  readonly canCopy?: boolean;
  readonly canPaste?: boolean;
  readonly canSelectAll?: boolean;
}

export interface ContextMenuPolicyInput extends AppOriginOptions {
  readonly frameIsAppMainFrame: boolean;
  readonly frameOrigin: string | null | undefined;
  readonly linkUrl: string | null | undefined;
  readonly isEditable: boolean;
  readonly hasSelection: boolean;
  readonly editFlags?: ContextMenuEditFlags;
}

export interface ContextMenuLinkActionCheck extends AppOriginOptions {
  readonly capturedDocument: DocumentIdentity | null;
  readonly currentDocument: DocumentIdentity | null;
  readonly linkUrl: string | null | undefined;
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

export function isSameDocumentIdentity(
  a: DocumentIdentity | null | undefined,
  b: DocumentIdentity | null | undefined,
): boolean {
  if (!a || !b) return false;
  return (
    a.frameTreeNodeId === b.frameTreeNodeId &&
    a.processId === b.processId &&
    a.routingId === b.routingId &&
    a.frameToken === b.frameToken &&
    a.origin === b.origin &&
    a.documentGeneration === b.documentGeneration
  );
}

/**
 * Normalize an external https: URL for ticket binding and exact comparison.
 * Rejects non-strings, non-https schemes, credentials, empty hostnames, and URLs >= 2,048 chars.
 */
export function normalizeTicketUrl(rawUrl: unknown): string | null {
  if (typeof rawUrl !== "string") return null;
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length >= MAX_EXTERNAL_URL_LENGTH) return null;
  const parsed = parseUrl(trimmed);
  if (!parsed || hasCredentials(parsed)) return null;
  if (parsed.protocol !== "https:" || parsed.hostname.length === 0) return null;
  const normalized = parsed.href;
  if (normalized.length >= MAX_EXTERNAL_URL_LENGTH) return null;
  return normalized;
}

/**
 * Record a link-activation ticket from a validated main-frame IPC message.
 * Ignores invalid senders, non-main frames, foreign origins, invalid/oversized URLs,
 * and messages arriving during an active out-of-order discard window.
 */
export function recordLinkActivation(
  state: LinkTicketState,
  input: RecordLinkActivationInput,
): LinkTicketState {
  if (!input.senderMatchesWindow || !input.senderIsMainFrame || !input.senderDocument) {
    return state;
  }
  if (!isAppOriginUrl(input.senderDocument.origin, input)) {
    return state;
  }
  if (!Number.isFinite(input.now)) {
    return state;
  }
  if (state.discardActivationsUntil !== null && input.now < state.discardActivationsUntil) {
    return { ticket: null, discardActivationsUntil: state.discardActivationsUntil };
  }
  const normalizedUrl = normalizeTicketUrl(input.rawUrl);
  if (!normalizedUrl) {
    return state;
  }
  return {
    ticket: {
      url: normalizedUrl,
      document: input.senderDocument,
      issuedAt: input.now,
    },
    discardActivationsUntil: null,
  };
}

/**
 * Clear any stored ticket after a trusted main-frame activation that was not on a link.
 */
export function clearLinkTicketOnActivationWithoutLink(
  state: LinkTicketState,
  input: ClearLinkTicketInput,
): LinkTicketState {
  if (!input.senderMatchesWindow || !input.senderIsMainFrame) {
    return state;
  }
  if (!input.senderOrigin || !isAppOriginUrl(input.senderOrigin, input)) {
    return state;
  }
  if (state.ticket === null) return state;
  return { ...state, ticket: null };
}

/**
 * Retire any stored ticket when the main-frame document changes (navigation, reload, or crash).
 */
export function retireLinkTicketOnDocumentChange(state: LinkTicketState): LinkTicketState {
  if (state.ticket === null) return state;
  return { ...state, ticket: null };
}

/**
 * Check whether a ticket authorizes an external open for rawTargetUrl from currentDocument at now.
 */
export function isTicketValidForDestination(
  ticket: LinkActivationTicket | null | undefined,
  rawTargetUrl: string,
  currentDocument: DocumentIdentity | null | undefined,
  now: number | undefined,
): boolean {
  if (!ticket || !currentDocument || typeof now !== "number" || !Number.isFinite(now)) {
    return false;
  }
  const age = now - ticket.issuedAt;
  if (age < 0 || age >= LINK_TICKET_WINDOW_MS) {
    return false;
  }
  if (!isSameDocumentIdentity(ticket.document, currentDocument)) {
    return false;
  }
  const normalizedTarget = normalizeTicketUrl(rawTargetUrl);
  if (!normalizedTarget) {
    return false;
  }
  return ticket.url === normalizedTarget;
}

/**
 * Consume any pending ticket after a main-frame navigation or window-open decision.
 * If an external attempt found no live matching-document ticket, suppress incoming
 * activation IPCs for the rest of the ticket window so a late out-of-order IPC cannot
 * arm a future open.
 */
export function consumeTicketAfterAttempt(
  state: LinkTicketState,
  input: ConsumeTicketInput,
): LinkTicketState {
  if (input.disposition === "ignore" || input.source === "redirect") {
    return state;
  }

  let discardActivationsUntil = state.discardActivationsUntil;
  if (input.disposition === "blocked" && isAllowedExternalUrl(input.rawUrl) && Number.isFinite(input.now)) {
    const hadLiveTicketForDoc =
      state.ticket !== null &&
      isSameDocumentIdentity(state.ticket.document, input.currentDocument) &&
      input.now - state.ticket.issuedAt >= 0 &&
      input.now - state.ticket.issuedAt < LINK_TICKET_WINDOW_MS;

    if (!hadLiveTicketForDoc) {
      const until = input.now + LINK_TICKET_WINDOW_MS;
      discardActivationsUntil =
        discardActivationsUntil !== null ? Math.max(discardActivationsUntil, until) : until;
    }
  }

  return {
    ticket: null,
    discardActivationsUntil,
  };
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
 * - "external": well-formed https: URL without credentials when a fresh, single-use link-activation
 *   ticket issued by the current main-frame document matches the exact normalized destination
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
    if (
      isAllowedExternalUrl(parsed.href) &&
      isTicketValidForDestination(
        options.linkTicket,
        parsed.href,
        options.currentDocument,
        options.now,
      )
    ) {
      return "external";
    }
    return "blocked";
  }

  // source === "navigate"
  if (isAppInitiator(options)) {
    if (targetIsAppOrigin || isAllowedSignInParsedUrl(parsed)) return "in_app";
    if (
      isAllowedExternalUrl(parsed.href) &&
      isTicketValidForDestination(
        options.linkTicket,
        parsed.href,
        options.currentDocument,
        options.now,
      )
    ) {
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
 * Pure descriptor builder for the native context menu.
 * Returns "Open Link in Browser" and "Copy Link" only when the menu was invoked
 * in the app's own live main frame at the app origin on a well-formed https: link
 * without credentials, plus standard editing items when editable or text is selected.
 */
export function buildContextMenuDescriptor(
  input: ContextMenuPolicyInput,
): ContextMenuDescriptorItem[] {
  const items: ContextMenuDescriptorItem[] = [];

  const allowLinkActions =
    input.frameIsAppMainFrame === true &&
    typeof input.frameOrigin === "string" &&
    isAppOriginUrl(input.frameOrigin, input) &&
    typeof input.linkUrl === "string" &&
    isAllowedExternalUrl(input.linkUrl);

  if (allowLinkActions && typeof input.linkUrl === "string") {
    items.push(
      {
        id: "open-link",
        label: CONTEXT_MENU_OPEN_LINK_LABEL,
        linkUrl: input.linkUrl,
      },
      {
        id: "copy-link",
        label: CONTEXT_MENU_COPY_LINK_LABEL,
        linkUrl: input.linkUrl,
      },
    );
  }

  if (input.isEditable) {
    if (items.length > 0) {
      items.push({ id: "separator", type: "separator" });
    }
    items.push(
      { id: "undo", role: "undo", enabled: input.editFlags?.canUndo ?? true },
      { id: "redo", role: "redo", enabled: input.editFlags?.canRedo ?? true },
      { id: "separator", type: "separator" },
      { id: "cut", role: "cut", enabled: input.editFlags?.canCut ?? true },
      { id: "copy", role: "copy", enabled: input.editFlags?.canCopy ?? true },
      { id: "paste", role: "paste", enabled: input.editFlags?.canPaste ?? true },
      { id: "selectAll", role: "selectAll", enabled: input.editFlags?.canSelectAll ?? true },
    );
  } else if (input.hasSelection) {
    if (items.length > 0) {
      items.push({ id: "separator", type: "separator" });
    }
    items.push({ id: "copy", role: "copy", enabled: input.editFlags?.canCopy ?? true });
  }

  return items;
}

/**
 * Re-check when a context-menu link item is chosen: the exact same main-frame document
 * must still be live at the app origin, and the link URL must still be an allowed https: URL.
 */
export function canExecuteContextMenuLinkAction(input: ContextMenuLinkActionCheck): boolean {
  if (!input.capturedDocument || !input.currentDocument) return false;
  if (!isSameDocumentIdentity(input.capturedDocument, input.currentDocument)) return false;
  if (!isAppOriginUrl(input.currentDocument.origin, input)) return false;
  if (typeof input.linkUrl !== "string" || !isAllowedExternalUrl(input.linkUrl)) return false;
  return true;
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
