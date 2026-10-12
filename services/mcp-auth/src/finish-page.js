// Navigation-only finish HTML for P8/P9b: renderFinishPage takes a trusted display
// model { interactionUid, clientDisplay (consent shape), identity (displayName/email),
// workspaceNames OR workspaceCount, homeWorkspaceName, deadline (epoch ms) }.
// renderFinishExpiredPage takes { clientDisplay }; both return HTML strings.
// Routes apply FINISH_SECURITY_HEADERS to pages and 303s and serve FINISH_TIMER_PATH.
// No codes/callbacks are inputs; only UID-derived fixed paths, same tab, no storage.
// The server owns binding and expiry; pausing never extends its deadline.
import { BRAND_MARK, CONSENT_STYLES, escapeHtml, renderClientIdentity } from "./interaction-page.js";

export const FINISH_TIMER_PATH = "/interaction/finish-timer.js";
export const FINISH_SECURITY_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; script-src 'self'; script-src-attr 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
});

export function finishPaths(interactionUid) {
  if (typeof interactionUid !== "string" || !/^[A-Za-z0-9_-]+$/u.test(interactionUid)) {
    throw new TypeError("invalid finish interaction UID");
  }
  return { connectedPath: `/interaction/${interactionUid}/connected`, finishPath: `/interaction/${interactionUid}/finish` };
}

function expiryText(clientDisplay) {
  return `Return link expired. Return to ${clientDisplay.primary} and start a new connection.`;
}

function shell({ clientDisplay, title, content, script = "" }) {
  const client = renderClientIdentity(clientDisplay);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark">
<title>${title}</title>${script}<style>${CONSENT_STYLES}
.finish p,.finish a,.finish button{overflow-wrap:anywhere}
.finish section>*+*{margin-top:10px}
.finish .actions a{border-radius:999px;padding:12px 24px;background:var(--primary-bg);color:var(--primary-fg);text-align:center}
.finish .actions a:hover{background:var(--primary-hover)}
.finish .actions a[aria-disabled="true"]{background:var(--soft);color:var(--muted);cursor:default}
.finish .actions button{background:transparent;color:var(--ink);border:1px solid var(--border);font-size:15px;padding:12px 18px}
.finish .actions button:disabled{cursor:default;color:var(--muted)}
[hidden]{display:none!important}
</style></head><body><main class="page"><header class="top"><span class="brand">${BRAND_MARK}<span>CommonSwarm</span></span></header>
<div class="card finish${client.verified ? "" : " unverified"}"><div class="intro"><div class="connect-row">${client.badge}</div>
<div class="app-facts">${client.facts}</div>${client.warning}</div>${content}</div></main></body></html>`;
}

export function renderFinishPage({ interactionUid, clientDisplay, identity, workspaceNames = [], workspaceCount, homeWorkspaceName, deadline }) {
  const paths = finishPaths(interactionUid);
  if (!Number.isSafeInteger(deadline) || deadline <= 0 || !homeWorkspaceName ||
      (!workspaceNames.length && (!Number.isSafeInteger(workspaceCount) || workspaceCount < 1))) {
    throw new TypeError("invalid finish display model");
  }
  const client = escapeHtml(clientDisplay.primary);
  const name = escapeHtml(identity.displayName || identity.email || "Email unavailable");
  const email = identity.displayName && identity.email && identity.displayName !== identity.email ? ` (${escapeHtml(identity.email)})` : "";
  const workspaces = workspaceNames.length ? workspaceNames.map(escapeHtml).join(", ")
    : `${workspaceCount} workspace${workspaceCount === 1 ? "" : "s"}`;
  return shell({ clientDisplay, title: "Connected", script: `<script src="${FINISH_TIMER_PATH}" defer></script>`, content: `
<section id="finish-page" data-connected-path="${paths.connectedPath}" data-finish-path="${paths.finishPath}" data-deadline="${deadline}" data-remaining-ms="${Math.max(0, deadline - Date.now())}" data-expiry-text="${escapeHtml(expiryText(clientDisplay))}" aria-live="polite" aria-atomic="true" tabindex="-1">
<h1 id="finish-title">Connected</h1><p id="finish-status" class="lede">${client} is connected to ${workspaces} as ${name}${email}. You can return to ${client}.</p>
<p>Home workspace: <strong>${escapeHtml(homeWorkspaceName)}</strong></p>
<p id="finish-return-status">We will now return you to ${client} to finish sign-in.</p></section>
<div class="actions"><a id="finish-continue" href="${paths.finishPath}">Continue to ${client}</a>
<button id="finish-pause" type="button" hidden disabled>Pause automatic return</button></div>` });
}

export function renderFinishExpiredPage({ clientDisplay }) {
  return shell({ clientDisplay, title: "Return link expired", content: `<h1>Return link expired</h1><p class="lede">${escapeHtml(expiryText(clientDisplay))}</p>` });
}
