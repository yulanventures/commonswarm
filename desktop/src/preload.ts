import { ipcRenderer } from "electron";

// Sandboxed, context-isolated preload. Exposes no API, no contextBridge, and no globals.
// Acts only in the main frame at the app origin.

const PRODUCTION_APP_ORIGIN = "https://commonswarm.com";
const DEV_ORIGIN_ARG_PREFIX = "--commonswarm-dev-origin=";
const IPC_LINK_ACTIVATED = "desktop:link-activated";
const IPC_ACTIVATION_WITHOUT_LINK = "desktop:activation-without-link";
const MAX_EXTERNAL_URL_LENGTH = 2048;
const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

const NESTED_INTERACTIVE_TAGS = new Set([
  "button",
  "input",
  "select",
  "textarea",
  "summary",
]);

const INTERACTIVE_CLICK_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "listbox",
  "menu",
  "menubar",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
]);

function readAllowedDevOrigin(): string | null {
  const argv = Array.isArray(process.argv) ? process.argv : [];
  for (const arg of argv) {
    if (typeof arg !== "string" || !arg.startsWith(DEV_ORIGIN_ARG_PREFIX)) continue;
    const raw = arg.slice(DEV_ORIGIN_ARG_PREFIX.length);
    try {
      const parsed = new URL(raw);
      if (
        parsed.protocol === "http:" &&
        (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") &&
        parsed.username === "" &&
        parsed.password === ""
      ) {
        return parsed.origin;
      }
    } catch {
      return null;
    }
  }
  return null;
}

const allowedDevOrigin = readAllowedDevOrigin();

function isMainFrameContext(): boolean {
  return process.isMainFrame === true && window === window.top;
}

function isAllowedAppOrigin(origin: string): boolean {
  if (origin === PRODUCTION_APP_ORIGIN) return true;
  if (allowedDevOrigin !== null && origin === allowedDevOrigin) return true;
  return false;
}

function getElementRoles(element: Element): string[] {
  const rawRole = element.getAttribute("role");
  if (!rawRole) return [];
  return rawRole.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

function isNestedInteractiveControl(element: Element, isHtmlAnchor: boolean): boolean {
  const tag = element.tagName.toLowerCase();
  if (NESTED_INTERACTIVE_TAGS.has(tag)) return true;

  const roles = getElementRoles(element);
  for (const role of roles) {
    if (INTERACTIVE_CLICK_ROLES.has(role)) return true;
    if (!isHtmlAnchor && role === "link") return true;
  }
  return false;
}

function resolveHttpsAnchorHref(anchor: Element): string | null {
  if (!anchor.hasAttribute("href")) return null;
  if (anchor.hasAttribute("download")) return null;

  const rawHref = anchor.getAttribute("href");
  if (typeof rawHref !== "string") return null;
  const trimmed = rawHref.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed, document.baseURI);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:") return null;
  if (parsed.hostname.length === 0) return null;
  if (parsed.username.length > 0 || parsed.password.length > 0) return null;
  if (parsed.href.length >= MAX_EXTERNAL_URL_LENGTH) return null;
  return parsed.href;
}

function findActivatedLinkUrl(event: MouseEvent): string | null {
  const path = typeof event.composedPath === "function" ? event.composedPath() : [];
  for (const target of path) {
    if (!target || typeof target !== "object" || (target as Node).nodeType !== 1) {
      continue;
    }
    const element = target as Element;
    const isHtmlAnchor =
      element.namespaceURI === HTML_NAMESPACE && element.tagName.toLowerCase() === "a";

    if (isNestedInteractiveControl(element, isHtmlAnchor)) {
      return null;
    }

    if (isHtmlAnchor && element.hasAttribute("href")) {
      return resolveHttpsAnchorHref(element);
    }
  }
  return null;
}

function handleTrustedActivation(event: MouseEvent, requiredButton: number): void {
  if (!isMainFrameContext()) return;
  if (!isAllowedAppOrigin(window.location.origin)) return;
  if (event.isTrusted !== true) return;
  if (event.button !== requiredButton) return;

  const linkUrl = findActivatedLinkUrl(event);
  if (linkUrl !== null) {
    ipcRenderer.send(IPC_LINK_ACTIVATED, linkUrl);
  } else {
    ipcRenderer.send(IPC_ACTIVATION_WITHOUT_LINK);
  }
}

if (isMainFrameContext() && isAllowedAppOrigin(window.location.origin)) {
  window.addEventListener(
    "click",
    (event: MouseEvent) => {
      handleTrustedActivation(event, 0);
    },
    true,
  );
  window.addEventListener(
    "auxclick",
    (event: MouseEvent) => {
      handleTrustedActivation(event, 1);
    },
    true,
  );
}
