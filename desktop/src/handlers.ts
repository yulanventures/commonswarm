import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  clipboard,
  ipcMain,
  Menu,
  session,
  shell,
  type BrowserWindow,
  type IpcMainEvent,
  type MenuItemConstructorOptions,
  type Session,
  type WebContents,
  type WebFrameMain,
} from "electron";
import {
  buildContextMenuDescriptor,
  canExecuteContextMenuLinkAction,
  classifyNavigation,
  clearLinkTicketOnActivationWithoutLink,
  consumeTicketAfterAttempt,
  DEV_ORIGIN_ARG_PREFIX,
  getAllowedDevOrigin,
  INITIAL_LINK_TICKET_STATE,
  IPC_ACTIVATION_WITHOUT_LINK,
  IPC_LINK_ACTIVATED,
  isAllowedExternalUrl,
  isAllowedSignInUrl,
  isAppOriginUrl,
  isPermissionAllowed,
  isSameDocumentIdentity,
  recordLinkActivation,
  retireLinkTicketOnDocumentChange,
  type AppOriginOptions,
  type DocumentIdentity,
  type LinkTicketState,
} from "./policy.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD_PATH = path.join(currentDir, "preload.cjs");

interface PendingMainNavigation {
  trusted: boolean;
  fromUrl: string;
}

export type ContextMenuPresenter = (
  template: MenuItemConstructorOptions[],
  win: BrowserWindow,
) => void;

export interface AttachWindowHandlersOptions {
  readonly offlinePageUrl?: string | null;
  readonly presentContextMenu?: ContextMenuPresenter;
}

/**
 * Absolute path to the compiled sandboxed preload script, resolved from the app's own files.
 */
export function getPreloadPath(): string {
  return PRELOAD_PATH;
}

/**
 * Additional renderer arguments to scope the preload to the active unpackaged dev origin (if any).
 * Always empty in packaged builds.
 */
export function getPreloadAdditionalArguments(policyOptions: AppOriginOptions): string[] {
  if (!policyOptions.allowedDevOrigin) return [];
  const devOrigin = getAllowedDevOrigin(policyOptions.allowedDevOrigin, false);
  if (!devOrigin) return [];
  return [`${DEV_ORIGIN_ARG_PREFIX}${devOrigin}`];
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

function isLiveFrame(frame: WebFrameMain | null | undefined): frame is WebFrameMain {
  return frame != null && !frame.isDestroyed() && !frame.detached;
}

function isOwnMainFrame(
  frame: WebFrameMain | null | undefined,
  webContents: WebContents,
): boolean {
  if (webContents.isDestroyed() || !isLiveFrame(frame)) return false;
  const mainFrame = webContents.mainFrame;
  if (!isLiveFrame(mainFrame)) return false;
  return frame.parent === null && frame.frameTreeNodeId === mainFrame.frameTreeNodeId;
}

function captureDocumentIdentity(
  frame: WebFrameMain,
  documentGeneration: number,
): DocumentIdentity {
  return {
    frameTreeNodeId: frame.frameTreeNodeId,
    processId: frame.processId,
    routingId: frame.routingId,
    frameToken: frame.frameToken,
    origin: frame.origin,
    documentGeneration,
  };
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

  const presentContextMenu: ContextMenuPresenter =
    options.presentContextMenu ??
    ((template, targetWin) => {
      Menu.buildFromTemplate(template).popup({ window: targetWin });
    });

  let documentGeneration = 0;
  let ticketState: LinkTicketState = INITIAL_LINK_TICKET_STATE;
  let pendingMainNav: PendingMainNavigation | null = null;

  const getCurrentMainDocumentIdentity = (): DocumentIdentity | null => {
    if (webContents.isDestroyed()) return null;
    const mainFrame = webContents.mainFrame;
    if (!isLiveFrame(mainFrame)) return null;
    return captureDocumentIdentity(mainFrame, documentGeneration);
  };

  const onLinkActivated = (event: IpcMainEvent, rawUrl: unknown): void => {
    if (webContents.isDestroyed() || event.sender !== webContents) return;
    const senderFrame = event.senderFrame;
    if (!isOwnMainFrame(senderFrame, webContents) || !isLiveFrame(senderFrame)) return;

    const senderDocument = captureDocumentIdentity(senderFrame, documentGeneration);
    if (!isSameDocumentIdentity(senderDocument, getCurrentMainDocumentIdentity())) return;

    ticketState = recordLinkActivation(ticketState, {
      ...policyOptions,
      rawUrl,
      senderMatchesWindow: true,
      senderIsMainFrame: true,
      senderDocument,
      now: Date.now(),
    });
  };

  const onActivationWithoutLink = (event: IpcMainEvent): void => {
    if (webContents.isDestroyed() || event.sender !== webContents) return;
    const senderFrame = event.senderFrame;
    if (!isOwnMainFrame(senderFrame, webContents) || !isLiveFrame(senderFrame)) return;

    ticketState = clearLinkTicketOnActivationWithoutLink(ticketState, {
      ...policyOptions,
      senderMatchesWindow: true,
      senderIsMainFrame: true,
      senderOrigin: senderFrame.origin,
    });
  };

  ipcMain.on(IPC_LINK_ACTIVATED, onLinkActivated);
  ipcMain.on(IPC_ACTIVATION_WITHOUT_LINK, onActivationWithoutLink);

  let cleanedUp = false;
  const cleanupIpc = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    ipcMain.off(IPC_LINK_ACTIVATED, onLinkActivated);
    ipcMain.off(IPC_ACTIVATION_WITHOUT_LINK, onActivationWithoutLink);
  };
  win.once("closed", cleanupIpc);
  webContents.once("destroyed", cleanupIpc);

  webContents.on("context-menu", (_event, params) => {
    const frame = params.frame;
    const frameIsAppMainFrame = isOwnMainFrame(frame, webContents) && isLiveFrame(frame);
    const capturedDocument = frameIsAppMainFrame
      ? captureDocumentIdentity(frame, documentGeneration)
      : null;

    const descriptor = buildContextMenuDescriptor({
      ...policyOptions,
      frameIsAppMainFrame,
      frameOrigin: capturedDocument?.origin ?? null,
      linkUrl: params.linkURL,
      isEditable: params.isEditable,
      hasSelection: params.selectionText.trim().length > 0,
      editFlags: params.editFlags,
    });

    if (descriptor.length === 0) return;

    const template: MenuItemConstructorOptions[] = descriptor.map((item) => {
      if (item.type === "separator") {
        return { type: "separator" };
      }
      if (item.id === "open-link" && item.linkUrl) {
        const targetLinkUrl = item.linkUrl;
        return {
          label: item.label,
          click: () => {
            if (
              canExecuteContextMenuLinkAction({
                ...policyOptions,
                capturedDocument,
                currentDocument: getCurrentMainDocumentIdentity(),
                linkUrl: targetLinkUrl,
              })
            ) {
              openExternalSafely(targetLinkUrl);
            }
          },
        };
      }
      if (item.id === "copy-link" && item.linkUrl) {
        const targetLinkUrl = item.linkUrl;
        return {
          label: item.label,
          click: () => {
            if (
              canExecuteContextMenuLinkAction({
                ...policyOptions,
                capturedDocument,
                currentDocument: getCurrentMainDocumentIdentity(),
                linkUrl: targetLinkUrl,
              })
            ) {
              void clipboard.writeText(targetLinkUrl).catch(() => {});
            }
          },
        };
      }
      return {
        role: item.role,
        enabled: item.enabled,
      };
    });

    presentContextMenu(template, win);
  });

  webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });

  webContents.on("will-frame-navigate", (details) => {
    const isMainFrame =
      details.isMainFrame &&
      (details.frame === null || isOwnMainFrame(details.frame, webContents));

    const initiator = details.initiator;
    const initiatorAlive = isLiveFrame(initiator);
    const initiatorIsMainFrame = initiatorAlive && isOwnMainFrame(initiator, webContents);
    const initiatorOrigin = initiatorAlive ? initiator.origin : null;
    const initiatorUrl = initiatorAlive ? initiator.url : null;
    const currentDocument = getCurrentMainDocumentIdentity();
    const now = Date.now();

    const disposition = classifyNavigation(details.url, {
      ...policyOptions,
      source: "navigate",
      isMainFrame,
      initiatorIsMainFrame,
      initiatorOrigin,
      initiatorUrl,
      initiatorIsOfflinePage:
        initiatorIsMainFrame && isOfflinePageUrl(initiatorUrl, options.offlinePageUrl),
      linkTicket: ticketState.ticket,
      currentDocument,
      now,
    });

    if (disposition === "ignore") return;

    ticketState = consumeTicketAfterAttempt(ticketState, {
      disposition,
      rawUrl: details.url,
      source: "navigate",
      currentDocument,
      now,
    });

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
    documentGeneration += 1;
    ticketState = retireLinkTicketOnDocumentChange(ticketState);
  });

  webContents.on("render-process-gone", () => {
    pendingMainNav = null;
    documentGeneration += 1;
    ticketState = retireLinkTicketOnDocumentChange(ticketState);
  });

  webContents.on("did-fail-load", (_event, _errorCode, _errorDescription, _validatedURL, isMainFrame) => {
    if (isMainFrame) {
      pendingMainNav = null;
    }
  });

  webContents.setWindowOpenHandler((details) => {
    const mainFrame = webContents.mainFrame;
    const mainFrameAlive = isLiveFrame(mainFrame);
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
    const currentDocument = getCurrentMainDocumentIdentity();
    const now = Date.now();

    const disposition = classifyNavigation(details.url, {
      ...policyOptions,
      source: "new_window",
      isMainFrame,
      initiatorIsMainFrame: isMainFrame,
      initiatorOrigin,
      initiatorUrl,
      linkTicket: ticketState.ticket,
      currentDocument,
      now,
      mainFrameHasSubframes,
    });

    ticketState = consumeTicketAfterAttempt(ticketState, {
      disposition,
      rawUrl: details.url,
      source: "new_window",
      currentDocument,
      now,
    });

    if (disposition === "in_app") {
      pendingMainNav = { trusted: true, fromUrl: details.url };
      void win.loadURL(details.url);
    } else if (disposition === "external") {
      openExternalSafely(details.url);
    }
    return { action: "deny" };
  });
}
