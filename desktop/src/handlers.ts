import {
  session,
  shell,
  type BrowserWindow,
  type Session,
  type WebContents,
  type WebFrameMain,
} from "electron";
import {
  classifyNavigation,
  isAllowedExternalUrl,
  isAllowedSignInUrl,
  isAppOriginUrl,
  isPermissionAllowed,
  type AppOriginOptions,
} from "./policy.js";

const USER_GESTURE_WINDOW_MS = 1000;

interface PendingMainNavigation {
  trusted: boolean;
  fromUrl: string;
}

export interface AttachWindowHandlersOptions {
  readonly offlinePageUrl?: string | null;
}

export function openExternalSafely(rawUrl: string): void {
  if (!isAllowedExternalUrl(rawUrl)) return;
  void shell.openExternal(rawUrl);
}

export function configurePermissions(
  policyOptions: AppOriginOptions,
  targetSession: Session = session.defaultSession,
): void {
  targetSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    callback(
      isPermissionAllowed({
        ...policyOptions,
        permission,
        requestingUrl: details.requestingUrl,
        isMainFrame: details.isMainFrame,
      }),
    );
  });

  targetSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
    return isPermissionAllowed({
      ...policyOptions,
      permission,
      requestingUrl: requestingOrigin,
      isMainFrame: details.isMainFrame,
    });
  });
}

function isOwnMainFrame(
  frame: WebFrameMain | null | undefined,
  webContents: WebContents,
): boolean {
  if (!frame || frame.isDestroyed()) return false;
  const mainFrame = webContents.mainFrame;
  if (!mainFrame || mainFrame.isDestroyed()) return false;
  return frame.parent === null && frame.frameTreeNodeId === mainFrame.frameTreeNodeId;
}

function isOfflinePageUrl(rawUrl: string | null | undefined, offlinePageUrl: string | null | undefined): boolean {
  if (!rawUrl || !offlinePageUrl) return false;
  try {
    const parsed = new URL(rawUrl);
    const expected = new URL(offlinePageUrl);
    return parsed.protocol === "file:" && parsed.pathname === expected.pathname;
  } catch {
    return false;
  }
}

function originFromReferrerUrl(rawReferrer: string | undefined): string | null {
  if (!rawReferrer) return null;
  try {
    return new URL(rawReferrer).origin;
  } catch {
    return null;
  }
}

export function attachWindowHandlers(
  win: BrowserWindow,
  policyOptions: AppOriginOptions,
  options: AttachWindowHandlersOptions = {},
): void {
  const { webContents } = win;

  let lastGestureAt: number | null = null;
  let pendingMainNav: PendingMainNavigation | null = null;

  const markUserGesture = (): void => {
    lastGestureAt = Date.now();
  };

  const hasRecentUserGesture = (): boolean => {
    return lastGestureAt !== null && Date.now() - lastGestureAt <= USER_GESTURE_WINDOW_MS;
  };

  const consumeUserGesture = (): void => {
    lastGestureAt = null;
  };

  webContents.on("input-event", (_event, inputEvent) => {
    if (
      inputEvent.type === "mouseUp" ||
      inputEvent.type === "gestureTap" ||
      inputEvent.type === "touchEnd" ||
      inputEvent.type === "pointerUp"
    ) {
      const button = "button" in inputEvent ? (inputEvent as { button?: string }).button : undefined;
      if (button === "right") return;
      markUserGesture();
    }
  });

  webContents.on("before-input-event", (_event, input) => {
    if (
      input.type === "keyDown" &&
      !input.isAutoRepeat &&
      (input.key === "Enter" || input.key === " ")
    ) {
      markUserGesture();
    }
  });

  webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });

  webContents.on("will-frame-navigate", (details) => {
    const isMainFrame =
      details.isMainFrame &&
      (details.frame === null || isOwnMainFrame(details.frame, webContents));

    const initiator = details.initiator;
    const initiatorAlive = initiator != null && !initiator.isDestroyed();
    const initiatorIsMainFrame = initiatorAlive && isOwnMainFrame(initiator, webContents);
    const initiatorOrigin = initiatorAlive ? initiator.origin : null;
    const initiatorUrl = initiatorAlive ? initiator.url : null;

    const disposition = classifyNavigation(details.url, {
      ...policyOptions,
      source: "navigate",
      isMainFrame,
      initiatorIsMainFrame,
      initiatorOrigin,
      initiatorUrl,
      initiatorIsOfflinePage:
        initiatorIsMainFrame && isOfflinePageUrl(initiatorUrl, options.offlinePageUrl),
      hasUserGesture: hasRecentUserGesture(),
    });

    if (disposition === "ignore") return;
    consumeUserGesture();
    if (disposition === "in_app") {
      pendingMainNav = { trusted: true, fromUrl: details.url };
      return;
    }

    details.preventDefault();
    if (disposition === "external") {
      openExternalSafely(details.url);
    }
  });

  webContents.on("did-start-navigation", (details) => {
    if (!details.isMainFrame || details.isSameDocument) return;
    if (details.frame !== null && !isOwnMainFrame(details.frame, webContents)) return;

    if (pendingMainNav && pendingMainNav.fromUrl === details.url) {
      return;
    }

    if (
      details.initiator == null &&
      (isAppOriginUrl(details.url, policyOptions) || isAllowedSignInUrl(details.url))
    ) {
      pendingMainNav = { trusted: true, fromUrl: details.url };
      return;
    }

    pendingMainNav = { trusted: false, fromUrl: details.url };
  });

  webContents.on("will-redirect", (details) => {
    const isMainFrame =
      details.isMainFrame &&
      (details.frame === null || isOwnMainFrame(details.frame, webContents));

    const initiatorIsMainFrame =
      details.initiator != null ? isOwnMainFrame(details.initiator, webContents) : undefined;

    const disposition = classifyNavigation(details.url, {
      ...policyOptions,
      source: "redirect",
      isMainFrame,
      initiatorIsMainFrame,
      continuingTrustedNavigation: pendingMainNav?.trusted === true,
      previousNavigationUrl: pendingMainNav?.fromUrl ?? null,
      hasUserGesture: false,
    });

    if (disposition === "ignore") return;
    if (disposition === "in_app") {
      pendingMainNav = { trusted: true, fromUrl: details.url };
      return;
    }

    details.preventDefault();
    pendingMainNav = null;
  });

  webContents.on("did-navigate", () => {
    pendingMainNav = null;
  });

  webContents.on("did-fail-load", (_event, _errorCode, _errorDescription, _validatedURL, isMainFrame) => {
    if (isMainFrame) {
      pendingMainNav = null;
    }
  });

  webContents.setWindowOpenHandler((details) => {
    const mainFrame = webContents.mainFrame;
    const mainFrameAlive = mainFrame != null && !mainFrame.isDestroyed();
    const mainFrameHasSubframes = !mainFrameAlive || mainFrame.frames.length > 0;
    const focusedFrame = webContents.focusedFrame;
    const focusedIsSubframe = focusedFrame !== null && !isOwnMainFrame(focusedFrame, webContents);

    const referrerOrigin = originFromReferrerUrl(details.referrer?.url);
    const referrerIsForeign =
      referrerOrigin !== null && !isAppOriginUrl(referrerOrigin, policyOptions);

    const isMainFrame = mainFrameAlive && !focusedIsSubframe && !referrerIsForeign;
    const initiatorOrigin = referrerIsForeign
      ? referrerOrigin
      : mainFrameAlive
        ? mainFrame.origin
        : null;
    const initiatorUrl = referrerIsForeign
      ? details.referrer.url
      : mainFrameAlive
        ? mainFrame.url
        : null;

    const disposition = classifyNavigation(details.url, {
      ...policyOptions,
      source: "new_window",
      isMainFrame,
      initiatorIsMainFrame: isMainFrame,
      initiatorOrigin,
      initiatorUrl,
      hasUserGesture: hasRecentUserGesture(),
      mainFrameHasSubframes,
    });

    consumeUserGesture();
    if (disposition === "in_app") {
      pendingMainNav = { trusted: true, fromUrl: details.url };
      void win.loadURL(details.url);
    } else if (disposition === "external") {
      openExternalSafely(details.url);
    }
    return { action: "deny" };
  });
}
